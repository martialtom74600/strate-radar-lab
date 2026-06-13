/**
 * Agent Qualificateur IA — classification owner_site / presence_only / corporate_parent / none
 * à partir des URLs organiques (sans listes d'annuaires en dur).
 */

import Groq, { APIError, RateLimitError } from 'groq-sdk';

import type { AppConfig } from '../../config/index.js';
import { StrateRadarError } from '../errors.js';
import { sleep } from '../retry.js';
import { toAbsoluteHttpUrl } from '../url.js';
import {
  serpClassificationSchema,
  type SerpClassification,
} from './serp-classification-schema.js';

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
- 'owner_site' : Le commerce possède son propre nom de domaine indépendant (ex: lamy-joaillerie.com, anaisdurykine.fr).
- 'presence_only' : Le commerce est listé sur un annuaire NEUTRE ou un réseau social (pagesjaunes.fr, societe.com, facebook.com...).
- 'corporate_parent' : Le commerce est une succursale, une franchise ou appartient à un réseau national/marque mère (ex: fiducial.fr, axa.fr, century21.fr, mcdonalds.fr). La page est hébergée sur le site de la maison-mère. C'est un critère d'exclusion.
- 'none' : Aucune URL pertinente.

Dans ton explication (\`reason\`), cite UNE SEULE URL décisive (la plus pertinente) et explique brièvement pourquoi — maximum 3 phrases, sans lister toutes les URLs.

IMPORTANT : Tu dois OBLIGATOIREMENT rédiger le champ \`reason\` en premier pour analyser la situation. Le champ \`status\` doit être la conclusion logique de ton raisonnement. Retourne UNIQUEMENT un objet JSON brut sans aucun bloc de code markdown. Exemple exact attendu : {"reason":"...", "confidence":1.0, "status":"..."}`;

const SYSTEM_PROMPT = SERP_CLASSIFIER_SYSTEM_PROMPT;

/** Nombre max d'URLs organiques envoyées au classifieur Groq. */
export const SERP_CLASSIFIER_MAX_URLS = 5;
const GROQ_CLASSIFIER_MAX_TOKENS = 512;
const GROQ_CLASSIFIER_MAX_ATTEMPTS = 3;
/**
 * Pause entre appels Groq — calibrée pour llama-3.3-70b-versatile (plan dev) :
 * 12K TPM · ~600 tok/requête → max ~20 req/min · 4s ≈ 15 req/min (~9K TPM).
 */
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

const PRESENCE_ONLY_SIGNAL =
  /\b(pagesjaunes|societe\.com|facebook\.com|instagram\.com|tripadvisor|mappy\.com|annuaire|réseau social|reseau social|presence_only)\b/i;

const OWNER_SITE_NEGATION =
  /\b(owner_site.*(n'?est pas|pas remplie|non remplie|ne correspond pas|exclu|exclut)|aucune url ne correspond.*owner_site|la règle ['"]owner_site['"] n'?est pas)\b/i;

const PRESENCE_AS_CONCLUSION =
  /\b((statut (est|sera) )?['"]presence_only['"]|correspond à la règle ['"]presence_only['"]|conclusion.*presence_only|presence_only.*(plus proche|la plus adaptée))\b/i;

const CORPORATE_EXCLUSION =
  /\b(exclu(t)? (le )?(statut )?['"]?corporate_parent|aucune (des )?urls? ne suggère.*corporate_parent|ne suggère pas.*corporate_parent|pas de corporate_parent|exclut le statut ['"]corporate_parent)\b/i;

const CORPORATE_AFFIRMATIVE =
  /\b((statut (est|sera) )?['"]corporate_parent['"]|correspond à la règle ['"]corporate_parent['"]|conclusion.*corporate_parent|classé en corporate_parent|donc ['"]?corporate_parent)\b/i;

const NONE_BUT_PRESENCE_SIGNAL =
  /\b(listé sur|présent sur|présence sur|pas de site web indépendant|n'?a pas de site web|aucune.*site web propriétaire)\b/i;

function reasonConcludesCorporateParent(reason: string): boolean {
  const lower = reason.toLowerCase();
  if (CORPORATE_EXCLUSION.test(lower)) return false;
  if (CORPORATE_AFFIRMATIVE.test(lower)) return true;
  return (
    /\b(succursale|franchise)\b/i.test(lower) &&
    /\b(maison[- ]mère|site (de la )?maison-mère|réseau national|marque mère)\b/i.test(lower) &&
    !/\b(aucune|pas de|ne correspond pas)\b/i.test(lower)
  );
}

function reasonConcludesPresenceOnly(reason: string): boolean {
  const lower = reason.toLowerCase();
  return (
    PRESENCE_AS_CONCLUSION.test(lower) ||
    /\b(statut (est|sera) ['"]presence_only['"]|conclusion.*presence_only)\b/i.test(lower)
  );
}

function inferConcludedStatusFromReason(
  reason: string,
): SerpClassification['status'] | null {
  const lower = reason.toLowerCase();
  if (reasonConcludesPresenceOnly(reason)) {
    return 'presence_only';
  }
  if (
    /correspond à la règle ['"]owner_site['"]/i.test(lower) &&
    !/n'?est pas remplie|ne correspond pas/i.test(lower)
  ) {
    return 'owner_site';
  }
  if (reasonConcludesCorporateParent(reason)) {
    return 'corporate_parent';
  }
  if (/aucune url pertinente|statut ['"]none['"]/i.test(lower)) {
    return 'none';
  }
  return null;
}

function inferSafeFallbackFromReason(
  classification: SerpClassification,
): SerpClassification {
  const concluded = inferConcludedStatusFromReason(classification.reason);
  if (concluded) {
    return {
      ...classification,
      status: concluded,
      confidence: concluded === 'none' ? 0 : Math.max(0.5, classification.confidence || 0.6),
      reason: `${classification.reason} [fallback: contradiction corrigée → ${concluded}]`,
    };
  }
  if (classification.status === 'owner_site' || classification.status === 'corporate_parent') {
    if (PRESENCE_ONLY_SIGNAL.test(classification.reason)) {
      return {
        ...classification,
        status: 'presence_only',
        confidence: 0.6,
        reason: `${classification.reason} [fallback: ${classification.status} contredit → presence_only]`,
      };
    }
    return {
      ...classification,
      status: 'none',
      confidence: 0,
      reason: `${classification.reason} [fallback: contradiction → none par sécurité]`,
    };
  }
  return classification;
}

/** Garde-fou déterministe : détecte confidence=0 ou contradiction status/raison. */
export function assessSerpClassificationCoherence(
  classification: SerpClassification,
): SerpClassificationCoherence {
  const { status, confidence, reason } = classification;
  const reasonLower = reason.toLowerCase();

  if (confidence === 0 && status !== 'none') {
    return {
      coherent: false,
      note: `confidence=0 avec status=${status}`,
      fallback: inferSafeFallbackFromReason(classification),
    };
  }

  if (status === 'owner_site') {
    if (OWNER_SITE_NEGATION.test(reasonLower) || PRESENCE_AS_CONCLUSION.test(reasonLower)) {
      return {
        coherent: false,
        note: 'owner_site contredit par la raison',
        fallback: inferSafeFallbackFromReason(classification),
      };
    }
    if (
      PRESENCE_ONLY_SIGNAL.test(reasonLower) &&
      /\b(pas de nom de domaine|aucun nom de domaine|ne possède pas|n'?a pas de site)\b/i.test(
        reasonLower,
      )
    ) {
      return {
        coherent: false,
        note: 'owner_site mais raison décrit une présence tierce',
        fallback: inferSafeFallbackFromReason(classification),
      };
    }
  }

  if (
    status === 'corporate_parent' &&
    reasonConcludesPresenceOnly(reason) &&
    !reasonConcludesCorporateParent(reason)
  ) {
    return {
      coherent: false,
      note: 'corporate_parent contredit par presence_only dans la raison',
      fallback: inferSafeFallbackFromReason(classification),
    };
  }

  if (
    status === 'none' &&
    PRESENCE_ONLY_SIGNAL.test(reasonLower) &&
    NONE_BUT_PRESENCE_SIGNAL.test(reasonLower)
  ) {
    return {
      coherent: false,
      note: 'none mais raison décrit une présence tierce',
      fallback: {
        ...classification,
        status: 'presence_only',
        confidence: Math.max(0.6, confidence || 0.6),
        reason: `${reason} [fallback: none contredit → presence_only]`,
      },
    };
  }

  const concludedStatus = inferConcludedStatusFromReason(reason);
  if (concludedStatus && concludedStatus !== status) {
    return {
      coherent: false,
      note: `status=${status} mais raison conclut ${concludedStatus}`,
      fallback: inferSafeFallbackFromReason(classification),
    };
  }

  return { coherent: true, note: '', fallback: null };
}

function resolveClassificationAfterCoherenceCheck(
  classification: SerpClassification,
): SerpClassification {
  const coherence = assessSerpClassificationCoherence(classification);
  if (coherence.coherent) {
    return classification;
  }

  const detail = `status=${classification.status} · conf=${classification.confidence} · ${coherence.note}`;
  console.warn(`[SCRUB] Contradiction IA détectée · fallback immédiat · ${detail}`);
  return coherence.fallback ?? inferSafeFallbackFromReason(classification);
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

function hostnameFromUrl(raw: string): string | null {
  try {
    const abs = toAbsoluteHttpUrl(raw);
    if (!abs) return null;
    return new URL(abs).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

/** Retrouve l'URL citée dans la raison LLM, sinon la première URL valide. */
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

export function presencePlatformFromUrl(raw: string | null | undefined): string | null {
  const host = raw ? hostnameFromUrl(raw) : null;
  if (!host) return null;
  const parts = host.split('.');
  if (parts.length >= 2) {
    return parts.slice(-2).join('.');
  }
  return host;
}

function attachMatchedUrl(
  classification: SerpClassification,
  urls: readonly string[],
): SerpClassifierResult {
  const matchedUrl =
    classification.status === 'none' ? null : extractMatchedUrl(classification.reason, urls);
  return { ...classification, matchedUrl };
}

function isGroqRateLimitError(err: unknown): boolean {
  if (err instanceof RateLimitError) return true;
  if (err instanceof APIError && err.status === 429) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b|rate.?limit|too many requests/i.test(msg);
}

/** Lit `retry-after` / `retry-after-ms` depuis une erreur Groq 429. */
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
    if (!Number.isNaN(asSeconds) && asSeconds >= 0) {
      return asSeconds * 1000;
    }
    const asDate = Date.parse(retryAfterHeader);
    if (!Number.isNaN(asDate)) {
      return Math.max(0, asDate - Date.now());
    }
  }

  return null;
}

export type GroqRateLimitKind = 'tpd' | 'tpm' | 'rpm' | 'unknown';

/** Distingue quota journalier (TPD) vs minute (TPM/RPM) dans les 429 Groq. */
export function parseGroqRateLimitKind(err: unknown): GroqRateLimitKind {
  const msg = err instanceof Error ? err.message : String(err);
  if (/tokens per day|\bTPD\b/i.test(msg)) return 'tpd';
  if (/tokens per minute|\bTPM\b/i.test(msg)) return 'tpm';
  if (/requests per minute|\bRPM\b/i.test(msg)) return 'rpm';
  return 'unknown';
}

function groqRateLimitPauseMs(retryIndex: number, err: unknown): number {
  const fromHeader = parseGroqRetryAfterDelayMs(err);
  if (fromHeader !== null) {
    return fromHeader + GROQ_RETRY_AFTER_MARGIN_MS;
  }
  const backoff =
    GROQ_RATE_LIMIT_BACKOFF_MS[retryIndex] ??
    GROQ_RATE_LIMIT_BACKOFF_MS[GROQ_RATE_LIMIT_BACKOFF_MS.length - 1]!;
  return backoff;
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
}): SerpClassifierDetailedResult {
  const quotaHint =
    args.limitKind === 'tpd'
      ? 'Quota journalier Groq épuisé (100K tok/jour sur llama-3.3-70b) — reprendre demain ou changer de modèle.'
      : args.limitKind === 'tpm'
        ? 'Quota minute Groq épuisé (12K TPM sur llama-3.3-70b).'
        : 'Rate limit Groq (429)';
  const reason = `${quotaHint} après ${GROQ_CLASSIFIER_MAX_ATTEMPTS} tentatives — prospect conservé par sécurité.`;
  return {
    result: {
      status: 'none',
      confidence: 0,
      reason,
      matchedUrl: null,
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

function prepareClassifierUrls(urls: readonly string[]): {
  readonly urlsSent: readonly string[];
  readonly urlsDropped: readonly string[];
  readonly maxUrls: number;
} {
  const maxUrls = SERP_CLASSIFIER_MAX_URLS;
  const cleaned = urls.map((url) => url.trim()).filter(Boolean);
  return {
    urlsSent: cleaned.slice(0, maxUrls),
    urlsDropped: cleaned.slice(maxUrls),
    maxUrls,
  };
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

  if (urlsSent.length === 0) {
    const emptyResult: SerpClassifierResult = {
      status: 'none',
      confidence: 0,
      reason: 'Aucune URL organique à analyser.',
      matchedUrl: null,
    };
    return {
      result: emptyResult,
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
      const reconciled = resolveClassificationAfterCoherenceCheck(parsed);
      const result = attachMatchedUrl(reconciled, urlsSent);
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
            `[radar] [serp-classifier] Quota journalier Groq épuisé (TPD 100K/jour · llama-3.3-70b) — arrêt des retries. Reprendre le scrub demain ou passer sur un autre modèle.`,
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
            limitKind,
          });
        }

        if (attempt < GROQ_CLASSIFIER_MAX_ATTEMPTS) {
          const pauseMs = groqRateLimitPauseMs(attempt - 1, e);
          const pauseSec = Math.ceil(pauseMs / 1000);
          const kindLabel = limitKind === 'tpm' ? 'TPM 12K/min' : limitKind === 'rpm' ? 'RPM 30/min' : '429';
          console.log(
            `[radar] [serp-classifier] Rate limit Groq (${kindLabel}). Pause de ${pauseSec} secondes avant retry (Tentative ${attempt}/${GROQ_CLASSIFIER_MAX_ATTEMPTS})...`,
          );
          await sleep(pauseMs);
          continue;
        }

        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `[radar] [serp-classifier] Rate limit Groq critique après ${GROQ_CLASSIFIER_MAX_ATTEMPTS} tentatives — prospect conservé (status none). ${msg.slice(0, 160)}`,
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
          limitKind,
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
