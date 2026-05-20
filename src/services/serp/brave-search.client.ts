import type { AppConfig } from '../../config/index.js';
import type { OrganicSerpHit } from '../../lib/organic-match.js';
import { withRetry } from '../../lib/retry.js';
import {
  formatWebSearchErrorNote,
  shouldSkipWebSearchHost,
  type WebSearchClient,
  type WebSearchError,
  type WebSearchResult,
} from './web-search.types.js';

const BRAVE_WEB_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

export { formatWebSearchErrorNote };

function mapBraveWebResults(json: unknown): OrganicSerpHit[] {
  if (!json || typeof json !== 'object') return [];
  const root = json as Record<string, unknown>;
  const web = root.web;
  if (!web || typeof web !== 'object') return [];
  const results = (web as Record<string, unknown>).results;
  if (!Array.isArray(results)) return [];

  const out: OrganicSerpHit[] = [];
  for (const row of results) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const link = typeof r.url === 'string' ? r.url.trim() : '';
    if (!link) continue;
    let hostname = '';
    try {
      hostname = new URL(link).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (shouldSkipWebSearchHost(hostname)) continue;
    const title = typeof r.title === 'string' ? r.title : link;
    const snippet =
      typeof r.description === 'string'
        ? r.description
        : typeof r.snippet === 'string'
          ? r.snippet
          : undefined;
    out.push({
      title,
      link,
      ...(snippet !== undefined ? { snippet } : {}),
    });
    if (out.length >= 8) break;
  }
  return out;
}

function parseBraveSearchApiError(
  json: unknown,
  httpStatus: number,
  rawBody: string,
): WebSearchError {
  if (json && typeof json === 'object') {
    const root = json as Record<string, unknown>;
    const message =
      typeof root.message === 'string' && root.message.trim()
        ? root.message.trim()
        : typeof root.detail === 'string' && root.detail.trim()
          ? root.detail.trim()
          : `HTTP ${httpStatus}`;
    const reason =
      typeof root.code === 'string' && root.code.trim()
        ? root.code.trim()
        : typeof root.type === 'string' && root.type.trim()
          ? root.type.trim()
          : null;
    return { httpStatus, reason, message };
  }

  const fallback = rawBody.trim().slice(0, 200);
  return {
    httpStatus,
    reason: null,
    message: fallback || `HTTP ${httpStatus}`,
  };
}

function resolveBraveCountry(gl: string | undefined): string | undefined {
  const code = gl?.trim().slice(0, 2).toUpperCase();
  return code && /^[A-Z]{2}$/.test(code) ? code : undefined;
}

function resolveBraveSearchLang(hl: string | undefined): string | undefined {
  const raw = hl?.trim().toLowerCase();
  if (!raw) return undefined;
  const lang = raw.split(/[-_]/)[0];
  return lang && /^[a-z]{2}$/.test(lang) ? lang : undefined;
}

function extractBraveQueryFallback(json: unknown, primaryQuery: string): string | null {
  if (!json || typeof json !== 'object') return null;
  const query = (json as Record<string, unknown>).query;
  if (!query || typeof query !== 'object') return null;
  const q = query as Record<string, unknown>;
  const candidates = [
    typeof q.cleaned === 'string' ? q.cleaned.trim() : '',
    typeof q.altered === 'string' ? q.altered.trim() : '',
  ].filter((c) => c.length > 0 && c !== primaryQuery);
  return candidates[0] ?? null;
}

async function fetchBraveWebSearch(
  apiKey: string,
  query: string,
  opts?: { readonly hl?: string; readonly gl?: string },
): Promise<{ readonly json: unknown; readonly ok: boolean; readonly status: number; readonly text: string }> {
  const params = new URLSearchParams({
    q: query,
    count: '8',
    safesearch: 'moderate',
  });
  const country = resolveBraveCountry(opts?.gl);
  if (country) params.set('country', country);
  const searchLang = resolveBraveSearchLang(opts?.hl);
  if (searchLang) params.set('search_lang', searchLang);

  const res = await fetch(`${BRAVE_WEB_SEARCH_URL}?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }
  return { json, ok: res.ok, status: res.status, text };
}

/**
 * Diagnostic démarrage (sans exposer la clé) — visible dans les logs GitHub Actions.
 */
export function describeWebSearchBoot(
  config: Pick<
    AppConfig,
    'BRAVE_SEARCH_API_KEY' | 'RADAR_WEB_SEARCH_ENABLED' | 'RADAR_MAX_WEB_SEARCH_REQUESTS_PER_RUN'
  >,
): { readonly configured: boolean; readonly statusLine: string } {
  const max = config.RADAR_MAX_WEB_SEARCH_REQUESTS_PER_RUN;
  if (max <= 0) {
    return {
      configured: false,
      statusLine: 'inactif · RADAR_MAX_WEB_SEARCH_REQUESTS_PER_RUN=0',
    };
  }
  const key = config.BRAVE_SEARCH_API_KEY?.trim();
  if (!key) {
    return {
      configured: false,
      statusLine: 'inactif · BRAVE_SEARCH_API_KEY absente ou vide sur le runner',
    };
  }
  if (!config.RADAR_WEB_SEARCH_ENABLED) {
    return {
      configured: false,
      statusLine: 'inactif · RADAR_WEB_SEARCH_ENABLED=false',
    };
  }
  return {
    configured: true,
    statusLine: `actif · plafond ${max} req/run · clé présente (${key.length} car.)`,
  };
}

/**
 * Recherche web via Brave Search API (couche 4 — website-resolver).
 * @see https://api-dashboard.search.brave.com/app/documentation/web-search/get-started
 */
export function createBraveSearchWebClient(config: AppConfig): WebSearchClient | null {
  const apiKey = config.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey || !config.RADAR_WEB_SEARCH_ENABLED) return null;

  return {
    async searchWeb(q, opts): Promise<WebSearchResult> {
      const query = q.trim();
      if (!query) return { hits: [], error: null };

      return withRetry(async () => {
        let activeQuery = query;
        let response = await fetchBraveWebSearch(apiKey, activeQuery, opts);

        if (!response.ok) {
          return {
            hits: [],
            error: parseBraveSearchApiError(response.json, response.status, response.text),
          };
        }

        let hits = mapBraveWebResults(response.json);
        if (hits.length === 0) {
          const fallbackQuery = extractBraveQueryFallback(response.json, activeQuery);
          if (fallbackQuery) {
            activeQuery = fallbackQuery;
            response = await fetchBraveWebSearch(apiKey, activeQuery, opts);
            if (response.ok) {
              hits = mapBraveWebResults(response.json);
            }
          }
        }

        return { hits, error: null };
      });
    },
  };
}
