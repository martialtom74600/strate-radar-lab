/**
 * Classifieur web — structurel d'abord (plateformes vs domaines dédiés), LLM seulement si ambiguïté.
 */

import Groq, { APIError, RateLimitError } from 'groq-sdk';

import type { AppConfig } from '../../config/index.js';
import {
  assessStructuralWebsitePresence,
  findDedicatedOwnerSiteCandidates,
  hostnameFromUrl,
  prioritizeUrlsForSerpClassification,
} from '../host-presence.js';
import { StrateRadarError } from '../errors.js';
import { sleep } from '../retry.js';
import {
  serpClassificationSchema,
  type SerpClassification,
} from './serp-classification-schema.js';

export {
  findDedicatedOwnerSiteCandidates,
  hostnameFromUrl,
  isMultiTenantPlatformHost,
  presencePlatformFromUrl,
  prioritizeUrlsForSerpClassification,
} from '../host-presence.js';

export type SerpClassifierResult = SerpClassification & {
  readonly matchedUrl: string | null;
};

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
  readonly llmSkipped: boolean;
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
const STRUCTURAL_MODEL_LABEL = 'structural';

export const DEDICATED_DOMAIN_CLASSIFIER_PROMPT = `Tu analyses des URLs à domaine dédié trouvées pour un commerce local.
RÈGLES :
- 'owner_site' : site web propre de CE commerce (ex: lamy-joaillerie.com, annecy-mobilites.fr pour « Annecy Assistance Dépannage »). Le hostname peut différer du nom Google Maps.
- 'corporate_parent' : succursale, franchise ou agence d'un réseau national (fiducial.fr, century21.fr, axa.fr, mcdonalds.fr…).
- 'presence_only' : page tierce qui parle du commerce mais n'est PAS son site (portail municipal annecy-ville.fr, annuaire vertical, média, guide touristique).
- 'none' : URL non pertinente pour ce commerce.

Dans \`reason\`, cite UNE URL décisive. Retourne UNIQUEMENT un JSON brut : {"reason":"...", "confidence":1.0, "status":"..."}`;

export const SERP_CLASSIFIER_SYSTEM_PROMPT = DEDICATED_DOMAIN_CLASSIFIER_PROMPT;

/** Nombre max d'URLs envoyées au LLM (domaines dédiés). */
export const SERP_CLASSIFIER_MAX_URLS = 5;
const GROQ_CLASSIFIER_MAX_TOKENS = 512;
const GROQ_CLASSIFIER_MAX_ATTEMPTS = 3;
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

function parseClassifierJson(raw: string): SerpClassification {
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
  readonly fallback: SerpClassification | null;
};

const CORPORATE_AFFIRMATIVE =
  /\b((statut (est|sera) )?['"]corporate_parent['"]|conclusion.*corporate_parent|classé en corporate_parent)\b/i;

function reasonConcludesCorporateParent(reason: string): boolean {
  const lower = reason.toLowerCase();
  if (/\b(pas de corporate_parent|ne suggère pas.*corporate_parent)\b/i.test(lower)) return false;
  if (CORPORATE_AFFIRMATIVE.test(lower)) return true;
  return (
    /\b(succursale|franchise)\b/i.test(lower) &&
    /\b(réseau national|marque mère|maison[- ]mère)\b/i.test(lower)
  );
}

/** Garde-fou léger sur les réponses LLM (franchise vs site propre). */
export function assessSerpClassificationCoherence(
  classification: SerpClassification,
  urlsCollected: readonly string[] = [],
): SerpClassificationCoherence {
  const { status, confidence, reason } = classification;

  if (confidence === 0 && status !== 'none') {
    return {
      coherent: false,
      note: `confidence=0 avec status=${status}`,
      fallback: { ...classification, status: 'none', confidence: 0 },
    };
  }

  if (
    (status === 'presence_only' || status === 'none') &&
    urlsCollected.length > 0
  ) {
    const dedicated = findDedicatedOwnerSiteCandidates(urlsCollected);
    const primary = dedicated[0];
    const primaryHost = primary ? hostnameFromUrl(primary) : null;
    const reasonLower = reason.toLowerCase();
    if (primary && primaryHost && !reasonLower.includes(primaryHost)) {
      return {
        coherent: false,
        note: `domaine dédié ${primaryHost} ignoré par le LLM`,
        fallback: {
          status: 'owner_site',
          confidence: Math.max(0.78, confidence || 0.78),
          reason: `La URL ${primary} est un domaine indépendant — site probable du commerce.`,
        },
      };
    }
  }

  if (
    status === 'corporate_parent' &&
    !reasonConcludesCorporateParent(reason) &&
    /\b(site (web )?propre|owner_site|domaine indépendant)\b/i.test(reason)
  ) {
    return {
      coherent: false,
      note: 'corporate_parent contredit par la raison',
      fallback: { ...classification, status: 'owner_site', confidence: 0.7 },
    };
  }

  return { coherent: true, note: '', fallback: null };
}

function resolveClassificationAfterCoherenceCheck(
  classification: SerpClassification,
  urlsCollected: readonly string[],
): SerpClassification {
  const coherence = assessSerpClassificationCoherence(classification, urlsCollected);
  if (coherence.coherent) return classification;
  const detail = `status=${classification.status} · conf=${classification.confidence} · ${coherence.note}`;
  console.warn(`[SCRUB] Contradiction IA détectée · fallback immédiat · ${detail}`);
  return coherence.fallback ?? classification;
}

export function buildSerpClassifierUserPrompt(args: {
  readonly companyName: string;
  readonly city: string | null;
  readonly urls: readonly string[];
  readonly platformUrls?: readonly string[];
}): string {
  const cityLine = args.city?.trim()
    ? `Ville : ${args.city.trim()}`
    : 'Ville : (non précisée)';
  const urlBlock =
    args.urls.length > 0
      ? args.urls.map((url, index) => `${index + 1}. ${url}`).join('\n')
      : '(aucune URL dédiée)';
  const platformBlock =
    args.platformUrls && args.platformUrls.length > 0
      ? `\nPrésences tierces déjà détectées (plateformes) :\n${args.platformUrls.map((url, i) => `${i + 1}. ${url}`).join('\n')}`
      : '';
  return `${cityLine}
Commerce : ${args.companyName.trim()}

URLs à domaine dédié :
${urlBlock}${platformBlock}

Analyse et retourne le JSON.`;
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
  classification: SerpClassification,
  urls: readonly string[],
  fallbackUrl: string | null = null,
): SerpClassifierResult {
  if (classification.status === 'none') {
    return { ...classification, matchedUrl: null };
  }
  const matchedUrl =
    extractMatchedUrl(classification.reason, urls) ??
    (classification.status === 'owner_site' || classification.status === 'corporate_parent'
      ? fallbackUrl
      : urls[0] ?? null);
  return { ...classification, matchedUrl };
}

function isGroqRateLimitError(err: unknown): boolean {
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

function groqRateLimitPauseMs(retryIndex: number, err: unknown): number {
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

function buildStructuralDetailedResult(args: {
  readonly companyName: string;
  readonly city: string | null;
  readonly urlsInput: readonly string[];
  readonly urlsSent: readonly string[];
  readonly urlsDropped: readonly string[];
  readonly maxUrls: number;
  readonly classification: SerpClassification;
  readonly matchedUrl: string | null;
}): SerpClassifierDetailedResult {
  const result: SerpClassifierResult = { ...args.classification, matchedUrl: args.matchedUrl };
  return {
    result,
    trace: {
      companyName: args.companyName,
      city: args.city,
      urlsInput: args.urlsInput,
      urlsSent: args.urlsSent,
      urlsDropped: args.urlsDropped,
      maxUrls: args.maxUrls,
      systemPrompt: DEDICATED_DOMAIN_CLASSIFIER_PROMPT,
      userPrompt: '[structural — LLM non sollicité]',
      model: STRUCTURAL_MODEL_LABEL,
      timeoutMs: 0,
      temperature: 0,
      rawResponse: '[structural]',
      latencyMs: 0,
      llmSkipped: true,
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
    },
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
  readonly limitKind?: GroqRateLimitKind;
  readonly dedicatedFallbackUrl?: string | null;
}): SerpClassifierDetailedResult {
  const dedicatedFallback = args.dedicatedFallbackUrl;
  const reason =
    args.limitKind === 'tpd'
      ? `Quota journalier Groq épuisé — ${dedicatedFallback ? 'domaine dédié détecté, prospect disqualifié par sécurité.' : 'prospect conservé par sécurité.'}`
      : `Rate limit Groq après ${GROQ_CLASSIFIER_MAX_ATTEMPTS} tentatives.`;

  if (dedicatedFallback) {
    return buildStructuralDetailedResult({
      companyName: args.companyName,
      city: args.city,
      urlsInput: args.urlsInput,
      urlsSent: args.urlsSent,
      urlsDropped: args.urlsDropped,
      maxUrls: args.maxUrls,
      classification: {
        status: 'owner_site',
        confidence: 0.6,
        reason: `${reason} Fallback structurel sur ${dedicatedFallback}.`,
      },
      matchedUrl: dedicatedFallback,
    });
  }

  return {
    result: { status: 'none', confidence: 0, reason, matchedUrl: null },
    trace: {
      companyName: args.companyName,
      city: args.city,
      urlsInput: args.urlsInput,
      urlsSent: args.urlsSent,
      urlsDropped: args.urlsDropped,
      maxUrls: args.maxUrls,
      systemPrompt: DEDICATED_DOMAIN_CLASSIFIER_PROMPT,
      userPrompt: args.userPrompt,
      model: args.model,
      timeoutMs: args.timeoutMs,
      temperature: 0,
      rawResponse: '',
      latencyMs: Date.now() - args.startedAt,
      llmSkipped: false,
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
        { role: 'system', content: DEDICATED_DOMAIN_CLASSIFIER_PROMPT },
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

async function classifyDedicatedDomainsWithGroq(args: {
  readonly config: AppConfig;
  readonly companyName: string;
  readonly city: string | null;
  readonly dedicatedUrls: readonly string[];
  readonly platformUrls: readonly string[];
  readonly allUrls: readonly string[];
  readonly urlsInput: readonly string[];
  readonly urlsSent: readonly string[];
  readonly urlsDropped: readonly string[];
  readonly maxUrls: number;
}): Promise<SerpClassifierDetailedResult> {
  const llmUrls = args.dedicatedUrls.slice(0, SERP_CLASSIFIER_MAX_URLS);
  const primaryDedicated = llmUrls[0] ?? null;
  const userPrompt = buildSerpClassifierUserPrompt({
    companyName: args.companyName,
    city: args.city,
    urls: llmUrls,
    platformUrls: args.platformUrls,
  });
  const startedAt = Date.now();
  const model = resolveSerpClassifierModel(args.config);
  const timeoutMs = args.config.GROQ_PREFLIGHT_TIMEOUT_MS;
  const groq = new Groq({ apiKey: args.config.GROQ_API_KEY! });

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
      const reconciled = resolveClassificationAfterCoherenceCheck(parsed, args.allUrls);
      const result = attachMatchedUrl(reconciled, args.allUrls, primaryDedicated);

      return {
        result,
        trace: {
          companyName: args.companyName,
          city: args.city,
          urlsInput: args.urlsInput,
          urlsSent: args.urlsSent,
          urlsDropped: args.urlsDropped,
          maxUrls: args.maxUrls,
          systemPrompt: DEDICATED_DOMAIN_CLASSIFIER_PROMPT,
          userPrompt,
          model,
          timeoutMs,
          temperature: 0,
          rawResponse,
          latencyMs: Date.now() - startedAt,
          llmSkipped: false,
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
        if (limitKind === 'tpd' || attempt >= GROQ_CLASSIFIER_MAX_ATTEMPTS) {
          return buildRateLimitExhaustedResult({
            companyName: args.companyName,
            city: args.city,
            urlsInput: args.urlsInput,
            urlsSent: args.urlsSent,
            urlsDropped: args.urlsDropped,
            maxUrls: args.maxUrls,
            userPrompt,
            model,
            timeoutMs,
            startedAt,
            limitKind,
            dedicatedFallbackUrl: primaryDedicated,
          });
        }
        await sleep(groqRateLimitPauseMs(attempt - 1, e));
        continue;
      }
      if (e instanceof StrateRadarError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new StrateRadarError('GROQ_SERP_CLASSIFIER', `Classifieur SERP : ${msg.slice(0, 200)}`, {
        cause: e,
      });
    }
  }

  throw new StrateRadarError('GROQ_SERP_CLASSIFIER', 'Classifieur SERP : échec après retries');
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
  const structural = assessStructuralWebsitePresence(urlsInput);

  if (structural.kind === 'resolved') {
    return buildStructuralDetailedResult({
      companyName: args.companyName,
      city: args.city,
      urlsInput,
      urlsSent,
      urlsDropped,
      maxUrls,
      classification: {
        status: structural.status,
        confidence: structural.confidence,
        reason: structural.reason,
      },
      matchedUrl: structural.matchedUrl,
    });
  }

  const dedicatedUrls =
    structural.dedicatedUrls.length > 0
      ? structural.dedicatedUrls
      : findDedicatedOwnerSiteCandidates(structural.allUrls);

  if (dedicatedUrls.length === 0) {
    return buildStructuralDetailedResult({
      companyName: args.companyName,
      city: args.city,
      urlsInput,
      urlsSent,
      urlsDropped,
      maxUrls,
      classification: {
        status: 'none',
        confidence: 0,
        reason: 'URLs ambiguës sans domaine dédié identifiable.',
      },
      matchedUrl: null,
    });
  }

  if (args.config.STRATE_RADAR_SIMULATION || !args.config.GROQ_API_KEY?.trim()) {
    return buildStructuralDetailedResult({
      companyName: args.companyName,
      city: args.city,
      urlsInput,
      urlsSent,
      urlsDropped,
      maxUrls,
      classification: {
        status: 'owner_site',
        confidence: 0.85,
        reason: `Domaine dédié détecté (${hostnameFromUrl(dedicatedUrls[0]!) ?? dedicatedUrls[0]}) — simulation sans Groq.`,
      },
      matchedUrl: dedicatedUrls[0] ?? null,
    });
  }

  return classifyDedicatedDomainsWithGroq({
    config: args.config,
    companyName: args.companyName,
    city: args.city,
    dedicatedUrls,
    platformUrls: structural.platformUrls,
    allUrls: structural.allUrls,
    urlsInput,
    urlsSent,
    urlsDropped,
    maxUrls,
  });
}
