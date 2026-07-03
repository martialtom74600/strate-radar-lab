/**
 * Top 5 Scanner — entonnoir humain : blocklist → Jina scrape → Groq arbitrage → short-circuit.
 */

import Groq from 'groq-sdk';
import { z } from 'zod';

import type { AppConfig } from '../../config/index.js';
import { StrateRadarError } from '../errors.js';
import {
  getRegistrableDomain,
  hostnameFromUrl,
  isCorporateNetworkUrl,
  isMultiTenantPlatformHost,
  isSearchNoiseHost,
} from '../host-presence.js';
import { sleep } from '../retry.js';
import { fetchJinaReaderMarkdown } from './jina-reader.js';
import {
  assessCorporateParentCandidate,
  corporateParentFromAssessment,
  corporateParentFromLocator,
  pickStrongerCorporateCandidate,
  resolveSharedParentDomainLocator,
} from './top5-corporate-signals.js';
import {
  applyQuarantinePolicy,
  computeGroqRateLimitBackoffMs,
  DEFAULT_SERP_CLASSIFIER_MODEL,
  formatGroqRateLimitReason,
  GROQ_CLASSIFIER_MAX_ATTEMPTS,
  isGroqRateLimitError,
  parseGroqRateLimitKind,
  type SerpClassifierDetailedResult,
  type SerpClassifierResult,
} from './serp-classifier.js';
import {
  assessStructuralOwnerSiteSignal,
  formatStructuralHintsForGroq,
  scoreOwnerCandidateUrl,
  type StructuralOwnerSiteSignal,
} from './top5-owner-signals.js';

export const TOP5_SCANNER_MAX_CANDIDATES = 5;
/** Espace les appels Groq du scanner (prompts Jina lourds → TPM free tier ~6K). */
export const TOP5_GROQ_INTER_REQUEST_DELAY_MS = 8_000;
/** Markdown envoyé à Groq (tronqué avant l’appel — Jina peut en fournir davantage). */
export const TOP5_GROQ_MAX_MARKDOWN_CHARS = 6_000;

export const TOP5_SCANNER_SYSTEM_PROMPT = `Tu es un expert en data B2B local. On te fournit le contenu markdown d'une page web et le nom d'un commerce local.
Tu dois décider si cette page est le site officiel INDÉPENDANT de cet établissement précis.

Réponds FALSE si :
- C'est une fiche sur un annuaire, un comparateur ou un réseau social
- C'est une page succursale / franchise d'un réseau national
- C'est un article, un avis, un blog ou un média tiers
- Le contenu ne correspond pas clairement à ce commerce

Réponds TRUE si le commerce a son propre nom de domaine (ex. annecy-mobilites.fr, lamy-joaillerie.com) et que le contenu confirme qu'il s'agit de CET établissement — ce n'est PAS un annuaire. Un annuaire liste plusieurs commerces sur SON domaine (pagesjaunes.fr, petitfute.com…).

Retourne UNIQUEMENT un JSON brut : {"official":true|false,"confidence":0.0-1.0,"reason":"..."}`;

const officialSiteSchema = z.object({
  official: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export type Top5ScannerCandidatePrep = {
  readonly candidates: readonly string[];
  readonly platformUrls: readonly string[];
  readonly droppedUrls: readonly string[];
};

/** État de la recherche web Serper/Brave — requis avant de conclure « presence_only ». */
export type Top5WebDiscoveryContext = {
  readonly attempted: boolean;
  readonly ok: boolean;
  readonly hits: number;
  readonly error: string | null;
};

export function canConcludePlatformOnlyAbsence(
  discovery: Top5WebDiscoveryContext | undefined,
): boolean {
  if (!discovery?.attempted) return false;
  if (!discovery.ok) return false;
  return discovery.hits > 0;
}

export type Top5ScannerDeps = {
  readonly fetchPage?: typeof fetchJinaReaderMarkdown;
  readonly fetchImpl?: typeof fetch;
  readonly askOfficialSite?: typeof askGroqOfficialSite;
};

let lastGroqScannerRequestAt = 0;

async function awaitGroqScannerThrottle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastGroqScannerRequestAt;
  if (lastGroqScannerRequestAt > 0 && elapsed < TOP5_GROQ_INTER_REQUEST_DELAY_MS) {
    await sleep(TOP5_GROQ_INTER_REQUEST_DELAY_MS - elapsed);
  }
  lastGroqScannerRequestAt = Date.now();
}

function trimMarkdownForGroq(markdown: string, maxChars: number): string {
  const trimmed = markdown.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars);
}

function resolveScannerGroqModel(config: AppConfig): string {
  const preflight = config.GROQ_PREFLIGHT_MODEL?.trim();
  if (preflight && preflight.length > 0) return preflight;
  const fromEnv = config.GROQ_MODEL?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_SERP_CLASSIFIER_MODEL;
}

function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(trimmed);
  if (fence?.[1]) return fence[1].trim();
  return trimmed;
}

export function buildTop5ScannerUserPrompt(args: {
  readonly companyName: string;
  readonly city: string | null;
  readonly url: string;
  readonly markdown: string;
  readonly structuralHints?: string | null;
}): string {
  const cityLine = args.city?.trim()
    ? `Ville : ${args.city.trim()}`
    : 'Ville : (non précisée)';
  const hintsBlock = args.structuralHints?.trim()
    ? `\nIndices structurels (non décisionnels) :\n${args.structuralHints.trim()}\n`
    : '';
  return `${cityLine}
Commerce : ${args.companyName.trim()}
URL analysée : ${args.url}
${hintsBlock}
Contenu de la page (markdown tronqué) :
---
${args.markdown}
---

Cette page est-elle le site officiel indépendant de ce commerce ?`;
}

/** Priorise Maps/Details, filtre plateformes, trie par alignement domaine/nom, garde max N candidats dédiés. */
export function prepareTop5ScannerCandidates(args: {
  readonly urlsCollected: readonly string[];
  readonly priorityUrls: readonly string[];
  readonly maxCandidates?: number;
  readonly companyName?: string;
}): Top5ScannerCandidatePrep {
  const max = args.maxCandidates ?? TOP5_SCANNER_MAX_CANDIDATES;
  const seen = new Set<string>();
  const ordered: string[] = [];

  const push = (raw: string) => {
    const url = raw.trim();
    if (!url) return;
    const key = url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(url);
  };

  for (const url of args.priorityUrls) push(url);
  for (const url of args.urlsCollected) push(url);

  const platformUrls: string[] = [];
  const dedicated: string[] = [];
  for (const url of ordered) {
    const host = hostnameFromUrl(url);
    if (!host || isSearchNoiseHost(host) || isMultiTenantPlatformHost(host)) {
      platformUrls.push(url);
    } else {
      dedicated.push(url);
    }
  }

  const companyName = args.companyName?.trim();
  const rankedDedicated =
    companyName && dedicated.length > 1
      ? [...dedicated].sort(
          (a, b) => scoreOwnerCandidateUrl(b, companyName) - scoreOwnerCandidateUrl(a, companyName),
        )
      : dedicated;

  return {
    candidates: rankedDedicated.slice(0, max),
    platformUrls,
    droppedUrls: [...platformUrls, ...rankedDedicated.slice(max)],
  };
}

function platformPresenceResult(args: {
  readonly platformUrls: readonly string[];
  readonly reason: string;
}): SerpClassifierResult {
  const matched = args.platformUrls[0] ?? null;
  const host = matched ? hostnameFromUrl(matched) : null;
  const registrable = host ? getRegistrableDomain(host) : null;
  return {
    status: 'presence_only',
    confidence: 0.95,
    reason: registrable
      ? `${args.reason} (${registrable})`
      : args.reason,
    matchedUrl: matched,
  };
}

function parseOfficialSiteJson(raw: string): z.infer<typeof officialSiteSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(raw));
  } catch (e) {
    throw new StrateRadarError('GROQ_JSON', 'Réponse Top5 Scanner non JSON', { cause: e });
  }
  const result = officialSiteSchema.safeParse(parsed);
  if (!result.success) {
    throw new StrateRadarError(
      'GROQ_TOP5_SCANNER_PARSE',
      `JSON Top5 Scanner invalide : ${result.error.message.slice(0, 160)}`,
    );
  }
  return result.data;
}

function isGroqScannerTimeoutError(err: unknown): boolean {
  return err instanceof StrateRadarError && err.code === 'GROQ_TOP5_SCANNER_TIMEOUT';
}

async function fetchJinaWithRetry(args: {
  readonly fetchPage: typeof fetchJinaReaderMarkdown;
  readonly url: string;
  readonly timeoutMs: number;
  readonly maxMarkdownChars: number;
  readonly apiKey: string | undefined;
  readonly fetchImpl?: typeof fetch;
}): Promise<Awaited<ReturnType<typeof fetchJinaReaderMarkdown>>> {
  const first = await args.fetchPage({
    url: args.url,
    timeoutMs: args.timeoutMs,
    maxMarkdownChars: args.maxMarkdownChars,
    apiKey: args.apiKey,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
  if (first.ok) return first;

  return args.fetchPage({
    url: args.url,
    timeoutMs: args.timeoutMs,
    maxMarkdownChars: args.maxMarkdownChars,
    apiKey: args.apiKey,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
}

async function askGroqOfficialSiteWithRetry(args: {
  readonly config: AppConfig;
  readonly companyName: string;
  readonly city: string | null;
  readonly url: string;
  readonly markdown: string;
  readonly structuralHints?: string | null;
  readonly timeoutMs: number;
  readonly askOfficial: typeof askGroqOfficialSite;
}): Promise<Awaited<ReturnType<typeof askGroqOfficialSite>>> {
  let markdown = trimMarkdownForGroq(args.markdown, TOP5_GROQ_MAX_MARKDOWN_CHARS);
  let timeoutMs = args.timeoutMs;
  let timeoutRetried = false;

  for (let attempt = 1; attempt <= GROQ_CLASSIFIER_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await args.askOfficial({
        config: args.config,
        companyName: args.companyName,
        city: args.city,
        url: args.url,
        markdown,
        structuralHints: args.structuralHints,
        timeoutMs,
      });
    } catch (e) {
      if (isGroqRateLimitError(e)) {
        if (parseGroqRateLimitKind(e) === 'tpd') throw e;
        if (attempt < GROQ_CLASSIFIER_MAX_ATTEMPTS) {
          const backoffMs = computeGroqRateLimitBackoffMs(attempt - 1, e);
          console.warn(
            `[radar] [top5-scanner] Groq rate limit (tentative ${attempt}/${GROQ_CLASSIFIER_MAX_ATTEMPTS}) — pause ${Math.ceil(backoffMs / 1_000)}s.`,
          );
          await sleep(backoffMs);
          markdown = trimMarkdownForGroq(markdown, Math.max(2_000, Math.floor(markdown.length * 0.5)));
          continue;
        }
        throw e;
      }

      if (isGroqScannerTimeoutError(e) && !timeoutRetried) {
        timeoutRetried = true;
        markdown = trimMarkdownForGroq(markdown, Math.max(2_000, Math.floor(markdown.length / 2)));
        timeoutMs += 8_000;
        continue;
      }

      throw e;
    }
  }

  throw new StrateRadarError(
    'GROQ_TOP5_SCANNER',
    `Top5 Scanner Groq : échec après ${GROQ_CLASSIFIER_MAX_ATTEMPTS} tentatives.`,
  );
}

function ownerSiteFromStructural(args: {
  readonly candidateUrl: string;
  readonly signal: StructuralOwnerSiteSignal;
}): SerpClassifierResult {
  return {
    status: 'owner_site',
    confidence: args.signal.confidence,
    reason: args.signal.reason,
    matchedUrl: args.candidateUrl,
  };
}

async function askGroqOfficialSite(args: {
  readonly config: AppConfig;
  readonly companyName: string;
  readonly city: string | null;
  readonly url: string;
  readonly markdown: string;
  readonly structuralHints?: string | null;
  readonly timeoutMs: number;
}): Promise<{
  readonly parsed: z.infer<typeof officialSiteSchema>;
  readonly rawResponse: string;
  readonly latencyMs: number;
  readonly model: string;
  readonly usage: {
    readonly promptTokens: number | null;
    readonly completionTokens: number | null;
    readonly totalTokens: number | null;
  };
}> {
  if (args.config.STRATE_RADAR_SIMULATION || !args.config.GROQ_API_KEY?.trim()) {
    throw new StrateRadarError(
      'GROQ_TOP5_SCANNER',
      'Top5 Scanner indisponible : GROQ_API_KEY absente ou mode simulation.',
    );
  }

  const groq = new Groq({ apiKey: args.config.GROQ_API_KEY });
  const model = resolveScannerGroqModel(args.config);
  const userPrompt = buildTop5ScannerUserPrompt({
    companyName: args.companyName,
    city: args.city,
    url: args.url,
    markdown: args.markdown,
    structuralHints: args.structuralHints,
  });
  const startedAt = Date.now();

  await awaitGroqScannerThrottle();

  const completion = await Promise.race([
    groq.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 256,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: TOP5_SCANNER_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new StrateRadarError(
              'GROQ_TOP5_SCANNER_TIMEOUT',
              `Top5 Scanner Groq > ${args.timeoutMs}ms`,
            ),
          ),
        args.timeoutMs,
      ),
    ),
  ]);

  const rawResponse = completion.choices[0]?.message?.content?.trim() ?? '';
  if (!rawResponse) {
    throw new StrateRadarError('GROQ_TOP5_SCANNER', 'Réponse Top5 Scanner vide.');
  }

  return {
    parsed: parseOfficialSiteJson(rawResponse),
    rawResponse,
    latencyMs: Date.now() - startedAt,
    model,
    usage: {
      promptTokens: completion.usage?.prompt_tokens ?? null,
      completionTokens: completion.usage?.completion_tokens ?? null,
      totalTokens: completion.usage?.total_tokens ?? null,
    },
  };
}

function buildScannerTrace(args: {
  readonly companyName: string;
  readonly city: string | null;
  readonly urlsInput: readonly string[];
  readonly prep: Top5ScannerCandidatePrep;
  readonly model: string;
  readonly timeoutMs: number;
  readonly startedAt: number;
  readonly rawResponse: string;
  readonly usage: {
    readonly promptTokens: number | null;
    readonly completionTokens: number | null;
    readonly totalTokens: number | null;
  };
}): SerpClassifierDetailedResult['trace'] {
  return {
    companyName: args.companyName,
    city: args.city,
    urlsInput: args.urlsInput,
    urlsSent: [...args.prep.candidates],
    urlsDropped: args.prep.droppedUrls,
    maxUrls: TOP5_SCANNER_MAX_CANDIDATES,
    systemPrompt: TOP5_SCANNER_SYSTEM_PROMPT,
    userPrompt: args.prep.candidates.length > 0 ? `(top5-scanner · ${args.prep.candidates.length} candidat(s))` : '',
    model: args.model,
    timeoutMs: args.timeoutMs,
    temperature: 0,
    rawResponse: args.rawResponse,
    latencyMs: Date.now() - args.startedAt,
    usage: args.usage,
  };
}

export async function scanTop5CandidatesDetailed(args: {
  readonly config: AppConfig;
  readonly companyName: string;
  readonly city: string | null;
  readonly urlsCollected: readonly string[];
  readonly priorityUrls: readonly string[];
  readonly discovery?: Top5WebDiscoveryContext;
  readonly deps?: Top5ScannerDeps;
}): Promise<SerpClassifierDetailedResult> {
  const startedAt = Date.now();
  const urlsInput = args.urlsCollected.map((url) => url.trim()).filter(Boolean);
  const prep = prepareTop5ScannerCandidates({
    urlsCollected: urlsInput,
    priorityUrls: args.priorityUrls,
    companyName: args.companyName,
  });
  const model = resolveScannerGroqModel(args.config);
  const timeoutMs = args.config.RADAR_TOP5_GROQ_TIMEOUT_MS;
  const fetchPage = args.deps?.fetchPage ?? fetchJinaReaderMarkdown;
  const askOfficial = args.deps?.askOfficialSite ?? askGroqOfficialSite;

  const emptyUsage = {
    promptTokens: null as number | null,
    completionTokens: null as number | null,
    totalTokens: null as number | null,
  };

  if (prep.candidates.length === 0) {
    if (prep.platformUrls.length > 0) {
      if (!canConcludePlatformOnlyAbsence(args.discovery)) {
        const detail = args.discovery?.error?.trim()
          ? args.discovery.error.slice(0, 180)
          : args.discovery?.attempted
            ? 'Recherche web sans résultat exploitable'
            : 'Recherche web (Serper/Brave) non configurée';
        const result: SerpClassifierResult = {
          status: 'needs_review',
          confidence: 0,
          reason: `[quarantaine] Impossible de confirmer l'absence de site dédié — ${detail}.`,
          matchedUrl: prep.platformUrls[0] ?? null,
        };
        return {
          result,
          trace: buildScannerTrace({
            companyName: args.companyName,
            city: args.city,
            urlsInput,
            prep,
            model: 'structural',
            timeoutMs,
            startedAt,
            rawResponse: '',
            usage: emptyUsage,
          }),
        };
      }

      const result = platformPresenceResult({
        platformUrls: prep.platformUrls,
        reason: 'Présence sur plateforme tierce uniquement — aucun domaine dédié à analyser',
      });
      return {
        result,
        trace: buildScannerTrace({
          companyName: args.companyName,
          city: args.city,
          urlsInput,
          prep,
          model: 'structural',
          timeoutMs,
          startedAt,
          rawResponse: '',
          usage: emptyUsage,
        }),
      };
    }

    const quarantined = applyQuarantinePolicy({
      status: 'none',
      confidence: 0,
      reason: 'Aucune URL candidate après filtrage plateformes.',
    });
    const result = { ...quarantined, matchedUrl: null } as SerpClassifierResult;

    return {
      result,
      trace: buildScannerTrace({
        companyName: args.companyName,
        city: args.city,
        urlsInput,
        prep,
        model: 'structural',
        timeoutMs,
        startedAt,
        rawResponse: '',
        usage: emptyUsage,
      }),
    };
  }

  let lastRawResponse = '';
  let lastUsage = emptyUsage;
  let jinaSuccessCount = 0;
  const groqFailures: string[] = [];
  const jinaFailures: string[] = [];
  let bestCorporate: { url: string; confidence: number; reason: string } | null = null;

  for (const candidateUrl of prep.candidates) {
    if (isCorporateNetworkUrl(candidateUrl)) {
      const host = hostnameFromUrl(candidateUrl);
      const registrable = host ? getRegistrableDomain(host) : null;
      const result: SerpClassifierResult = {
        status: 'corporate_parent',
        confidence: 0.95,
        reason: registrable
          ? `Page sur réseau national connu (${registrable}) — pas un site indépendant.`
          : 'Page sur réseau national connu — pas un site indépendant.',
        matchedUrl: candidateUrl,
      };
      return {
        result,
        trace: buildScannerTrace({
          companyName: args.companyName,
          city: args.city,
          urlsInput,
          prep,
          model,
          timeoutMs,
          startedAt,
          rawResponse: lastRawResponse,
          usage: lastUsage,
        }),
      };
    }

    const jina = await fetchJinaWithRetry({
      fetchPage,
      url: candidateUrl,
      timeoutMs: args.config.RADAR_JINA_TIMEOUT_MS,
      maxMarkdownChars: args.config.RADAR_JINA_MAX_MARKDOWN_CHARS,
      apiKey: args.config.JINA_API_KEY,
      ...(args.deps?.fetchImpl ? { fetchImpl: args.deps.fetchImpl } : {}),
    });

    if (!jina.ok) {
      jinaFailures.push(`${candidateUrl} → ${jina.error}`);
      continue;
    }
    jinaSuccessCount += 1;

    const structural = assessStructuralOwnerSiteSignal({
      companyName: args.companyName,
      city: args.city,
      url: candidateUrl,
      markdown: jina.markdown,
    });
    if (structural.strong) {
      const result = ownerSiteFromStructural({ candidateUrl, signal: structural });
      return {
        result,
        trace: buildScannerTrace({
          companyName: args.companyName,
          city: args.city,
          urlsInput,
          prep,
          model: 'structure',
          timeoutMs,
          startedAt,
          rawResponse: lastRawResponse,
          usage: lastUsage,
        }),
      };
    }

    const groqHints = formatStructuralHintsForGroq(structural.hints);

    try {
      const groq = await askGroqOfficialSiteWithRetry({
        config: args.config,
        companyName: args.companyName,
        city: args.city,
        url: candidateUrl,
        markdown: jina.markdown,
        structuralHints: groqHints,
        timeoutMs,
        askOfficial,
      });
      lastRawResponse = groq.rawResponse;
      lastUsage = groq.usage;

      if (groq.parsed.official) {
        const corporateAssessment = assessCorporateParentCandidate({
          companyName: args.companyName,
          url: candidateUrl,
          markdown: jina.markdown,
          groqOfficial: true,
          groqReason: groq.parsed.reason,
        });
        if (corporateAssessment.match) {
          const result = corporateParentFromAssessment({
            url: candidateUrl,
            assessment: corporateAssessment,
          });
          return {
            result,
            trace: buildScannerTrace({
              companyName: args.companyName,
              city: args.city,
              urlsInput,
              prep,
              model: groq.model,
              timeoutMs,
              startedAt,
              rawResponse: groq.rawResponse,
              usage: groq.usage,
            }),
          };
        }

        const result: SerpClassifierResult = {
          status: 'owner_site',
          confidence: groq.parsed.confidence,
          reason: `[top5-scanner] ${groq.parsed.reason}`,
          matchedUrl: candidateUrl,
        };
        return {
          result,
          trace: buildScannerTrace({
            companyName: args.companyName,
            city: args.city,
            urlsInput,
            prep,
            model: groq.model,
            timeoutMs,
            startedAt,
            rawResponse: groq.rawResponse,
            usage: groq.usage,
          }),
        };
      }

      const corporateAssessment = assessCorporateParentCandidate({
        companyName: args.companyName,
        url: candidateUrl,
        markdown: jina.markdown,
        groqOfficial: false,
        groqReason: groq.parsed.reason,
      });
      bestCorporate = pickStrongerCorporateCandidate(bestCorporate, {
        url: candidateUrl,
        assessment: corporateAssessment,
      });
    } catch (e) {
      if (isGroqRateLimitError(e)) {
        const reason = formatGroqRateLimitReason(e);
        const result: SerpClassifierResult = {
          status: 'needs_review',
          confidence: 0,
          reason,
          matchedUrl: candidateUrl,
        };
        return {
          result,
          trace: buildScannerTrace({
            companyName: args.companyName,
            city: args.city,
            urlsInput,
            prep,
            model,
            timeoutMs,
            startedAt,
            rawResponse: lastRawResponse,
            usage: lastUsage,
          }),
        };
      }
      const msg = e instanceof Error ? e.message : String(e);
      groqFailures.push(`${candidateUrl} → ${msg.slice(0, 120)}`);
    }
  }

  if (jinaSuccessCount === 0) {
    const result: SerpClassifierResult = {
      status: 'needs_review',
      confidence: 0,
      reason: `[quarantaine] Jina indisponible sur tous les candidats : ${jinaFailures.slice(0, 3).join(' · ')}`,
      matchedUrl: prep.candidates[0] ?? null,
    };
    return {
      result,
      trace: buildScannerTrace({
        companyName: args.companyName,
        city: args.city,
        urlsInput,
        prep,
        model,
        timeoutMs,
        startedAt,
        rawResponse: lastRawResponse,
        usage: lastUsage,
      }),
    };
  }

  if (groqFailures.length > 0 && jinaSuccessCount === groqFailures.length) {
    const result: SerpClassifierResult = {
      status: 'needs_review',
      confidence: 0,
      reason: `[quarantaine] Groq indisponible : ${groqFailures.slice(0, 2).join(' · ')}`,
      matchedUrl: prep.candidates[0] ?? null,
    };
    return {
      result,
      trace: buildScannerTrace({
        companyName: args.companyName,
        city: args.city,
        urlsInput,
        prep,
        model,
        timeoutMs,
        startedAt,
        rawResponse: lastRawResponse,
        usage: lastUsage,
      }),
    };
  }

  const sharedLocatorUrl = resolveSharedParentDomainLocator(
    prep.candidates,
    args.companyName,
  );
  if (sharedLocatorUrl) {
    const result = corporateParentFromLocator({
      url: sharedLocatorUrl,
      companyName: args.companyName,
    });
    return {
      result,
      trace: buildScannerTrace({
        companyName: args.companyName,
        city: args.city,
        urlsInput,
        prep,
        model,
        timeoutMs,
        startedAt,
        rawResponse: lastRawResponse,
        usage: lastUsage,
      }),
    };
  }

  if (bestCorporate) {
    const result: SerpClassifierResult = {
      status: 'corporate_parent',
      confidence: bestCorporate.confidence,
      reason: bestCorporate.reason,
      matchedUrl: bestCorporate.url,
    };
    return {
      result,
      trace: buildScannerTrace({
        companyName: args.companyName,
        city: args.city,
        urlsInput,
        prep,
        model,
        timeoutMs,
        startedAt,
        rawResponse: lastRawResponse,
        usage: lastUsage,
      }),
    };
  }

  const result = platformPresenceResult({
    platformUrls: prep.platformUrls,
    reason: `Aucun site officiel indépendant confirmé (${prep.candidates.length} candidat(s) analysé(s) via Jina+Groq)`,
  });

  return {
    result,
    trace: buildScannerTrace({
      companyName: args.companyName,
      city: args.city,
      urlsInput,
      prep,
      model,
      timeoutMs,
      startedAt,
      rawResponse: lastRawResponse,
      usage: lastUsage,
    }),
  };
}

/** Alias court pour le pipeline website-resolver. */
export async function scanTop5Candidates(args: {
  readonly config: AppConfig;
  readonly companyName: string;
  readonly city: string | null;
  readonly urlsCollected: readonly string[];
  readonly priorityUrls: readonly string[];
  readonly discovery?: Top5WebDiscoveryContext;
  readonly deps?: Top5ScannerDeps;
}): Promise<SerpClassifierResult> {
  const detailed = await scanTop5CandidatesDetailed(args);
  return detailed.result;
}
