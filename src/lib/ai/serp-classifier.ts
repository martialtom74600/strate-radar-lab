/**
 * Agent Qualificateur IA — classification owner_site / presence_only / none
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
- 'presence_only' : Le commerce est listé sur un annuaire, une plateforme ou un réseau social. MÊME SI la page lui est entièrement dédiée, cela RESTE un 'presence_only' car il ne possède pas le domaine. Exemples stricts de presence_only : pagesjaunes.fr, societe.com, facebook.com, instagram.com, tripadvisor.fr, resalib.fr, travaux.com, pappers.fr, villepratique.fr, allogarage.fr.
- 'none' : Aucune URL pertinente.

Dans ton explication (\`reason\`), tu DOIS obligatoirement citer l'URL exacte qui a motivé ta décision finale et expliquer brièvement pourquoi selon ces règles. Réponds UNIQUEMENT avec un JSON valide : {"status":"...","confidence":0.0,"reason":"..."}`;

const SYSTEM_PROMPT = SERP_CLASSIFIER_SYSTEM_PROMPT;

const GROQ_CLASSIFIER_MAX_ATTEMPTS = 3;
const GROQ_RETRY_AFTER_MARGIN_MS = 2_000;
const GROQ_RATE_LIMIT_BACKOFF_MS = [5_000, 10_000, 20_000];

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
}): SerpClassifierDetailedResult {
  const reason = `Groq rate limit (429) après ${GROQ_CLASSIFIER_MAX_ATTEMPTS} tentatives — prospect conservé par sécurité.`;
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
      max_tokens: 256,
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
  const maxUrls = 7;
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

      const result = attachMatchedUrl(parseClassifierJson(rawResponse), urlsSent);
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
        if (attempt < GROQ_CLASSIFIER_MAX_ATTEMPTS) {
          const pauseMs = groqRateLimitPauseMs(attempt - 1, e);
          const pauseSec = Math.ceil(pauseMs / 1000);
          console.log(
            `[radar] [serp-classifier] Rate limit Groq atteint (429). Pause de ${pauseSec} secondes avant retry (Tentative ${attempt}/${GROQ_CLASSIFIER_MAX_ATTEMPTS})...`,
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
