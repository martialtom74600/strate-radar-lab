/**
 * Classifieur SERP — Groq (llama-3.3-70b) sur toutes les URLs collectées.
 * host-presence sert à prioriser les URLs et bloquer owner_site sur plateformes connues.
 */

import Groq, { APIError, RateLimitError } from 'groq-sdk';

import type { AppConfig } from '../../config/index.js';
import {
  findDedicatedOwnerSiteCandidates,
  hostnameFromUrl,
  isMultiTenantPlatformHost,
  prioritizeUrlsForSerpClassification,
} from '../host-presence.js';
import { StrateRadarError } from '../errors.js';
import { sleep } from '../retry.js';
import {
  serpClassificationSchema,
  type SerpClassification,
  type LlmSerpClassification,
} from './serp-classification-schema.js';
import type { WebsitePresenceStatus } from '../website-presence-types.js';

export {
  findDedicatedOwnerSiteCandidates,
  hostnameFromUrl,
  isMultiTenantPlatformHost,
  presencePlatformFromUrl,
  prioritizeUrlsForSerpClassification,
} from '../host-presence.js';

export type SerpClassifierResult = {
  readonly status: WebsitePresenceStatus;
  readonly confidence: number;
  readonly reason: string;
  readonly matchedUrl: string | null;
};

/** Convertit none / confidence=0 / erreurs en sas de quarantaine manuelle. */
export function applyQuarantinePolicy(
  classification: Pick<SerpClassifierResult, 'status' | 'confidence' | 'reason'>,
): Pick<SerpClassifierResult, 'status' | 'confidence' | 'reason'> {
  if (classification.status === 'needs_review') {
    return classification;
  }
  if (classification.status === 'none' || classification.confidence === 0) {
    return {
      ...classification,
      status: 'needs_review',
      reason:
        classification.status === 'none'
          ? `[quarantaine] ${classification.reason}`
          : `[quarantaine] ${classification.reason} (confidence=0)`,
    };
  }
  return classification;
}

export type SerpClassifierTrace = {
  readonly companyName: string;
  readonly city: string | null;
  readonly urlsInput: readonly string[];
  readonly urlsSent: readonly string[];
  readonly urlsDropped: readonly string[];
  readonly maxUrls: number;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly temperature: number;
  readonly rawResponse: string;
  readonly latencyMs: number;
  readonly usage: {
    readonly promptTokens: number | null;
    readonly completionTokens: number | null;
    readonly totalTokens: number | null;
  };
};

export type SerpClassifierDetailedResult = {
  readonly result: SerpClassifierResult;
  readonly trace: SerpClassifierTrace;
};

export const DEFAULT_SERP_CLASSIFIER_MODEL = 'llama-3.3-70b-versatile';

export const SERP_CLASSIFIER_SYSTEM_PROMPT = `Tu es un expert en data B2B local. Tu dois analyser les URLs organiques trouvées pour un commerce.
RÈGLES ABSOLUES :
- 'owner_site' : Le commerce possède son propre nom de domaine indépendant (ex: lamy-joaillerie.com, annecy-mobilites.fr pour « Annecy Assistance Dépannage »). Le hostname peut différer du nom affiché sur Google Maps.
- 'presence_only' : Le commerce est listé sur un annuaire, une plateforme ou un réseau social (pagesjaunes.fr, site-solocal.com, pappers.fr, petitfute.com, travaux.com, facebook.com, instagram.com…). Un sous-domaine d'annuaire (ex: *.site-solocal.com) n'est PAS un site propriétaire. Un annuaire vertical sur son propre domaine (ex: fleuristes-et-fleurs.com, applivoiture.fr) reste presence_only.
- 'corporate_parent' : Succursale, franchise ou agence d'un réseau national (fiducial.fr, century21.fr, compagnieduvegetal.fr…).
- 'none' : Aucune URL pertinente.

Dans ton explication (\`reason\`), cite UNE SEULE URL décisive et explique brièvement pourquoi — maximum 3 phrases.
IMPORTANT : Rédige \`reason\` en premier. \`status\` doit être la conclusion logique. Retourne UNIQUEMENT un JSON brut : {"reason":"...", "confidence":1.0, "status":"..."}`;

const SYSTEM_PROMPT = SERP_CLASSIFIER_SYSTEM_PROMPT;

export const SERP_CLASSIFIER_MAX_URLS = 5;
const GROQ_CLASSIFIER_MAX_TOKENS = 512;
export const GROQ_CLASSIFIER_MAX_ATTEMPTS = 3;
export const GROQ_CLASSIFIER_INTER_REQUEST_DELAY_MS = 4_000;
const GROQ_RETRY_AFTER_MARGIN_MS = 2_000;
const GROQ_RATE_LIMIT_BACKOFF_MS = [5_000, 10_000, 20_000];

let lastGroqClassifierRequestAt = 0;

async function awaitGroqClassifierThrottle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastGroqClassifierRequestAt;
  if (lastGroqClassifierRequestAt > 0 && elapsed < GROQ_CLASSIFIER_INTER_REQUEST_DELAY_MS) {
    await sleep(GROQ_CLASSIFIER_INTER_REQUEST_DELAY_MS - elapsed);
  }
  lastGroqClassifierRequestAt = Date.now();
}

function resolveSerpClassifierModel(config: AppConfig): string {
  const fromEnv = config.GROQ_MODEL?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_SERP_CLASSIFIER_MODEL;
}

function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(trimmed);
  if (fence?.[1]) return fence[1].trim();
  return trimmed;
}

function parseClassifierJson(raw: string): LlmSerpClassification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(raw));
  } catch (e) {
    throw new StrateRadarError('GROQ_JSON', 'Réponse classifieur SERP non JSON', { cause: e });
  }
  let candidate: unknown = parsed;
  if (Array.isArray(candidate)) {
    candidate = candidate[0];
  }
  const result = serpClassificationSchema.safeParse(candidate);
  if (!result.success) {
    throw new StrateRadarError(
      'GROQ_SERP_CLASSIFIER_PARSE',
      `JSON classifieur invalide : ${result.error.message.slice(0, 160)}`,
    );
  }
  return result.data;
}

export type SerpClassificationCoherence = {
  readonly coherent: boolean;
  readonly note: string;
  readonly fallback: SerpClassifierResult | null;
};

/** Garde-fous minimaux — la décision principale reste celle du LLM. */
export function assessSerpClassificationCoherence(
  classification: SerpClassifierResult,
  urlsCollected: readonly string[] = [],
): SerpClassificationCoherence {
  const { status, confidence, reason } = classification;

  if (confidence === 0 && status !== 'none' && status !== 'needs_review') {
    return {
      coherent: false,
      note: `confidence=0 avec status=${status}`,
      fallback: {
        ...classification,
        status: 'needs_review',
        confidence: 0,
        reason: `${reason} [fallback: quarantaine confidence=0]`,
        matchedUrl: classification.matchedUrl,
      },
    };
  }

  if (status === 'owner_site' || status === 'corporate_parent') {
    const matchedInReason = extractMatchedUrl(reason, urlsCollected);
    const host = matchedInReason ? hostnameFromUrl(matchedInReason) : null;
    if (host && isMultiTenantPlatformHost(host)) {
      return {
        coherent: false,
        note: `owner_site/corporate sur plateforme ${host}`,
        fallback: {
          ...classification,
          status: 'presence_only',
          confidence: Math.max(0.7, confidence || 0.7),
          reason: `${reason} [fallback: ${host} est une plateforme tierce → presence_only]`,
          matchedUrl: classification.matchedUrl,
        },
      };
    }
  }

  if (
    (status === 'presence_only' || status === 'none') &&
    urlsCollected.length > 0
  ) {
    const dedicated = findDedicatedOwnerSiteCandidates(urlsCollected);
    const primary = dedicated[0];
    const primaryHost = primary ? hostnameFromUrl(primary) : null;
    const reasonLower = reason.toLowerCase();
    if (
      primary &&
      primaryHost &&
      !reasonLower.includes(primaryHost) &&
      /\b(pagesjaunes|pappers|site-solocal|solocal\.com|facebook\.com|instagram\.com)\b/i.test(reasonLower)
    ) {
      return {
        coherent: false,
        note: `domaine dédié ${primaryHost} ignoré alors que la raison cite une plateforme`,
        fallback: {
          status: 'owner_site',
          confidence: Math.max(0.78, confidence || 0.78),
          reason: `La URL ${primary} est un nom de domaine indépendant — site probable du commerce (hostname peut différer du nom Maps).`,
          matchedUrl: primary,
        },
      };
    }
  }

  return { coherent: true, note: '', fallback: null };
}

function resolveClassificationAfterCoherenceCheck(
  classification: LlmSerpClassification,
  urlsCollected: readonly string[],
  matchedUrl: string | null,
): SerpClassifierResult {
  const withMatch: SerpClassifierResult = { ...classification, matchedUrl };
  const coherence = assessSerpClassificationCoherence(withMatch, urlsCollected);
  const reconciled = coherence.coherent ? withMatch : (coherence.fallback ?? withMatch);
  if (!coherence.coherent) {
    const detail = `status=${classification.status} · conf=${classification.confidence} · ${coherence.note}`;
    console.warn(`[SCRUB] Contradiction IA détectée · fallback immédiat · ${detail}`);
  }
  return applyQuarantinePolicy(reconciled) as SerpClassifierResult;
}

export function buildSerpClassifierUserPrompt(args: {
  readonly companyName: string;
  readonly city: string | null;
  readonly urls: readonly string[];
}): string {
  const cityLine = args.city?.trim()
    ? `Ville : ${args.city.trim()}`
    : 'Ville : (non précisée)';
  const urlBlock =
    args.urls.length > 0
      ? args.urls.map((url, index) => `${index + 1}. ${url}`).join('\n')
      : '(aucune URL)';
  return `${cityLine}
Commerce : ${args.companyName.trim()}

URLs organiques :
${urlBlock}

Analyse ces URLs et retourne le JSON.`;
}

export function extractMatchedUrl(reason: string, urls: readonly string[]): string | null {
  const reasonLower = reason.toLowerCase();
  for (const url of urls) {
    const host = hostnameFromUrl(url);
    if (!host) continue;
    if (reasonLower.includes(host) || reasonLower.includes(url.toLowerCase())) {
      return url;
    }
  }
  return null;
}

function attachMatchedUrl(
  classification: LlmSerpClassification,
  urls: readonly string[],
): SerpClassifierResult {
  if (classification.status === 'none') {
    return applyQuarantinePolicy({
      ...classification,
      matchedUrl: null,
    }) as SerpClassifierResult;
  }
  const matchedUrl = extractMatchedUrl(classification.reason, urls) ?? urls[0] ?? null;
  return applyQuarantinePolicy({
    ...classification,
    matchedUrl,
  }) as SerpClassifierResult;
}

export function isGroqRateLimitError(err: unknown): boolean {
  if (err instanceof RateLimitError) return true;
  if (err instanceof APIError && err.status === 429) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b|rate.?limit|too many requests/i.test(msg);
}

export function parseGroqRetryAfterDelayMs(err: unknown): number | null {
  if (!(err instanceof APIError) || !err.headers) return null;
  const headers = err.headers;

  const retryAfterMsHeader = headers['retry-after-ms'];
  if (retryAfterMsHeader) {
    const ms = Number.parseFloat(retryAfterMsHeader);
    if (!Number.isNaN(ms) && ms >= 0) return ms;
  }

  const retryAfterHeader = headers['retry-after'];
  if (retryAfterHeader) {
    const asSeconds = Number.parseFloat(retryAfterHeader);
    if (!Number.isNaN(asSeconds) && asSeconds >= 0) return asSeconds * 1000;
    const asDate = Date.parse(retryAfterHeader);
    if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  }
  return null;
}

export type GroqRateLimitKind = 'tpd' | 'tpm' | 'rpm' | 'unknown';

export function parseGroqRateLimitKind(err: unknown): GroqRateLimitKind {
  const msg = err instanceof Error ? err.message : String(err);
  if (/tokens per day|\bTPD\b/i.test(msg)) return 'tpd';
  if (/tokens per minute|\bTPM\b/i.test(msg)) return 'tpm';
  if (/requests per minute|\bRPM\b/i.test(msg)) return 'rpm';
  return 'unknown';
}

const GROQ_LIMIT_LABELS: Record<GroqRateLimitKind, string> = {
  tpd: 'TPD (tokens/jour)',
  tpm: 'TPM (tokens/minute)',
  rpm: 'RPM (requêtes/minute)',
  unknown: 'rate limit (type non identifié)',
};

function formatGroqRetryHint(err: unknown, kind: GroqRateLimitKind): string {
  const retryMs = parseGroqRetryAfterDelayMs(err);
  if (retryMs !== null) {
    if (retryMs >= 60_000) {
      return ` — réessayer dans ~${Math.ceil(retryMs / 60_000)} min`;
    }
    return ` — réessayer dans ~${Math.ceil(retryMs / 1_000)} s`;
  }
  if (kind === 'tpd') return ' — réessayer demain (reset journalier UTC)';
  if (kind === 'tpm' || kind === 'rpm') return ' — réessayer dans 1–2 min';
  return '';
}

/** Message lisible pour logs scrub / quarantaine (type de limite + délai retry-after). */
export function formatGroqRateLimitReason(err: unknown, context?: string): string {
  const kind = parseGroqRateLimitKind(err);
  const ctx = context?.trim() ? ` · ${context.trim()}` : '';
  return `[quarantaine] Groq ${GROQ_LIMIT_LABELS[kind]}${formatGroqRetryHint(err, kind)}${ctx} — vérification manuelle requise.`;
}

/** Délai avant retry Groq : `retry-after` + marge, sinon backoff fixe. */
export function computeGroqRateLimitBackoffMs(retryIndex: number, err: unknown): number {
  const fromHeader = parseGroqRetryAfterDelayMs(err);
  if (fromHeader !== null) return fromHeader + GROQ_RETRY_AFTER_MARGIN_MS;
  return (
    GROQ_RATE_LIMIT_BACKOFF_MS[retryIndex] ??
    GROQ_RATE_LIMIT_BACKOFF_MS[GROQ_RATE_LIMIT_BACKOFF_MS.length - 1]!
  );
}

function prepareClassifierUrls(urls: readonly string[]): {
  readonly urlsSent: readonly string[];
  readonly urlsDropped: readonly string[];
  readonly maxUrls: number;
} {
  const maxUrls = SERP_CLASSIFIER_MAX_URLS;
  const prioritized = prioritizeUrlsForSerpClassification(urls);
  return {
    urlsSent: prioritized.slice(0, maxUrls),
    urlsDropped: prioritized.slice(maxUrls),
    maxUrls,
  };
}

function buildRateLimitExhaustedResult(args: {
  readonly companyName: string;
  readonly city: string | null;
  readonly urlsInput: readonly string[];
  readonly urlsSent: readonly string[];
  readonly urlsDropped: readonly string[];
  readonly maxUrls: number;
  readonly userPrompt: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly startedAt: number;
  readonly err: unknown;
}): SerpClassifierDetailedResult {
  const reason = formatGroqRateLimitReason(
    args.err,
    `après ${GROQ_CLASSIFIER_MAX_ATTEMPTS} tentatives`,
  );
  return {
    result: {
      status: 'needs_review',
      confidence: 0,
      reason,
      matchedUrl: args.urlsSent[0] ?? null,
    },
    trace: {
      companyName: args.companyName,
      city: args.city,
      urlsInput: args.urlsInput,
      urlsSent: args.urlsSent,
      urlsDropped: args.urlsDropped,
      maxUrls: args.maxUrls,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: args.userPrompt,
      model: args.model,
      timeoutMs: args.timeoutMs,
      temperature: 0,
      rawResponse: '',
      latencyMs: Date.now() - args.startedAt,
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
    },
  };
}

async function createGroqClassifierCompletion(args: {
  readonly groq: Groq;
  readonly config: AppConfig;
  readonly userPrompt: string;
  readonly timeoutMs: number;
}) {
  return Promise.race([
    args.groq.chat.completions.create({
      model: resolveSerpClassifierModel(args.config),
      temperature: 0,
      max_tokens: GROQ_CLASSIFIER_MAX_TOKENS,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: args.userPrompt },
      ],
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new StrateRadarError(
              'GROQ_SERP_CLASSIFIER_TIMEOUT',
              `Classifieur SERP Groq > ${args.timeoutMs}ms`,
            ),
          ),
        args.timeoutMs,
      ),
    ),
  ]);
}

export async function classifySerpUrls(args: {
  readonly config: AppConfig;
  readonly companyName: string;
  readonly city: string | null;
  readonly urls: readonly string[];
}): Promise<SerpClassifierResult> {
  const detailed = await classifySerpUrlsDetailed(args);
  return detailed.result;
}

export async function classifySerpUrlsDetailed(args: {
  readonly config: AppConfig;
  readonly companyName: string;
  readonly city: string | null;
  readonly urls: readonly string[];
}): Promise<SerpClassifierDetailedResult> {
  const urlsInput = args.urls.map((url) => url.trim()).filter(Boolean);
  const { urlsSent, urlsDropped, maxUrls } = prepareClassifierUrls(urlsInput);
  const allUrls = [...urlsSent, ...urlsDropped];

  if (urlsSent.length === 0) {
    return {
      result: applyQuarantinePolicy({
        status: 'none',
        confidence: 0,
        reason: 'Aucune URL organique à analyser.',
        matchedUrl: null,
      }) as SerpClassifierResult,
      trace: {
        companyName: args.companyName,
        city: args.city,
        urlsInput,
        urlsSent,
        urlsDropped,
        maxUrls,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: buildSerpClassifierUserPrompt({
          companyName: args.companyName,
          city: args.city,
          urls: urlsSent,
        }),
        model: resolveSerpClassifierModel(args.config),
        timeoutMs: args.config.GROQ_PREFLIGHT_TIMEOUT_MS,
        temperature: 0,
        rawResponse: '',
        latencyMs: 0,
        usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      },
    };
  }

  if (args.config.STRATE_RADAR_SIMULATION || !args.config.GROQ_API_KEY?.trim()) {
    throw new StrateRadarError(
      'GROQ_SERP_CLASSIFIER',
      'Classifieur SERP indisponible : GROQ_API_KEY absente ou mode simulation.',
    );
  }

  const groq = new Groq({ apiKey: args.config.GROQ_API_KEY });
  const timeoutMs = args.config.GROQ_PREFLIGHT_TIMEOUT_MS;
  const userPrompt = buildSerpClassifierUserPrompt({
    companyName: args.companyName,
    city: args.city,
    urls: urlsSent,
  });
  const startedAt = Date.now();
  const model = resolveSerpClassifierModel(args.config);

  for (let attempt = 1; attempt <= GROQ_CLASSIFIER_MAX_ATTEMPTS; attempt += 1) {
    try {
      await awaitGroqClassifierThrottle();
      const completion = await createGroqClassifierCompletion({
        groq,
        config: args.config,
        userPrompt,
        timeoutMs,
      });

      const rawResponse = completion.choices[0]?.message?.content?.trim() ?? '';
      if (!rawResponse) {
        throw new StrateRadarError('GROQ_SERP_CLASSIFIER', 'Réponse classifieur SERP vide.');
      }

      const parsed = parseClassifierJson(rawResponse);
      const reconciled = resolveClassificationAfterCoherenceCheck(
        parsed,
        allUrls,
        extractMatchedUrl(parsed.reason, allUrls) ?? allUrls[0] ?? null,
      );
      const result = reconciled;

      return {
        result,
        trace: {
          companyName: args.companyName,
          city: args.city,
          urlsInput,
          urlsSent,
          urlsDropped,
          maxUrls,
          systemPrompt: SYSTEM_PROMPT,
          userPrompt,
          model,
          timeoutMs,
          temperature: 0,
          rawResponse,
          latencyMs: Date.now() - startedAt,
          usage: {
            promptTokens: completion.usage?.prompt_tokens ?? null,
            completionTokens: completion.usage?.completion_tokens ?? null,
            totalTokens: completion.usage?.total_tokens ?? null,
          },
        },
      };
    } catch (e) {
      if (isGroqRateLimitError(e)) {
        const limitKind = parseGroqRateLimitKind(e);

        if (limitKind === 'tpd') {
          console.error(
            `[radar] [serp-classifier] Quota journalier Groq épuisé (TPD) — arrêt des retries.`,
          );
          return buildRateLimitExhaustedResult({
            companyName: args.companyName,
            city: args.city,
            urlsInput,
            urlsSent,
            urlsDropped,
            maxUrls,
            userPrompt,
            model,
            timeoutMs,
            startedAt,
            err: e,
          });
        }

        if (attempt < GROQ_CLASSIFIER_MAX_ATTEMPTS) {
          await sleep(computeGroqRateLimitBackoffMs(attempt - 1, e));
          continue;
        }

        return buildRateLimitExhaustedResult({
          companyName: args.companyName,
          city: args.city,
          urlsInput,
          urlsSent,
          urlsDropped,
          maxUrls,
          userPrompt,
          model,
          timeoutMs,
          startedAt,
          err: e,
        });
      }

      if (e instanceof StrateRadarError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new StrateRadarError('GROQ_SERP_CLASSIFIER', `Classifieur SERP : ${msg.slice(0, 200)}`, {
        cause: e,
      });
    }
  }

  throw new StrateRadarError(
    'GROQ_SERP_CLASSIFIER',
    `Classifieur SERP : rate limit Groq après ${GROQ_CLASSIFIER_MAX_ATTEMPTS} tentatives`,
  );
}
