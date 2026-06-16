import type { AppConfig } from '../../config/index.js';
import type { OrganicSerpHit } from '../../lib/organic-serp-hit.js';
import { withRetry } from '../../lib/retry.js';
import {
  shouldSkipWebSearchHost,
  type WebSearchClient,
  type WebSearchError,
  type WebSearchOptions,
  type WebSearchResult,
} from './web-search.types.js';

const SERPER_SEARCH_URL = 'https://google.serper.dev/search';

function mapSerperOrganicResults(json: unknown): OrganicSerpHit[] {
  if (!json || typeof json !== 'object') return [];
  const organic = (json as Record<string, unknown>).organic;
  if (!Array.isArray(organic)) return [];

  const hits: OrganicSerpHit[] = [];
  for (const row of organic) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const link = typeof r.link === 'string' ? r.link.trim() : '';
    if (!link) continue;
    let hostname = '';
    try {
      hostname = new URL(link).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (shouldSkipWebSearchHost(hostname)) continue;

    const title = typeof r.title === 'string' ? r.title : link;
    const snippet = typeof r.snippet === 'string' ? r.snippet : undefined;
    hits.push({
      title,
      link,
      ...(snippet !== undefined ? { snippet } : {}),
    });
    if (hits.length >= 6) break;
  }
  return hits;
}

function parseSerperApiError(
  json: unknown,
  httpStatus: number,
  rawBody: string,
): WebSearchError {
  if (json && typeof json === 'object') {
    const root = json as Record<string, unknown>;
    const message =
      typeof root.message === 'string' && root.message.trim()
        ? root.message.trim()
        : typeof root.error === 'string' && root.error.trim()
          ? root.error.trim()
          : `HTTP ${httpStatus}`;
    return { httpStatus, reason: 'serper', message };
  }
  return {
    httpStatus,
    reason: 'serper',
    message: rawBody.trim().slice(0, 200) || `HTTP ${httpStatus}`,
  };
}

function resolveSerperCountry(gl: string | undefined): string | undefined {
  const code = gl?.trim().slice(0, 2).toLowerCase();
  return code && /^[a-z]{2}$/.test(code) ? code : undefined;
}

function resolveSerperLanguage(hl: string | undefined): string | undefined {
  const raw = hl?.trim().toLowerCase();
  if (!raw) return undefined;
  const lang = raw.split(/[-_]/)[0];
  return lang && /^[a-z]{2}$/.test(lang) ? lang : undefined;
}

async function postSerperSearch(
  apiKey: string,
  query: string,
  opts?: WebSearchOptions,
): Promise<{ readonly json: unknown; readonly ok: boolean; readonly status: number; readonly text: string }> {
  const body: Record<string, unknown> = {
    q: query,
    num: 10,
  };
  const gl = resolveSerperCountry(opts?.gl);
  if (gl) body.gl = gl;
  const hl = resolveSerperLanguage(opts?.hl);
  if (hl) body.hl = hl;
  const location = opts?.location?.trim();
  if (location) body.location = location;

  const res = await fetch(SERPER_SEARCH_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify(body),
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

/** Client Serper.dev — Google organic SERP (couche 4, priorité SerpManager). */
export function createSerperWebClient(config: AppConfig): WebSearchClient | null {
  const apiKey = config.SERPER_API_KEY?.trim();
  if (!apiKey || !config.RADAR_WEB_SEARCH_ENABLED) return null;

  return {
    async searchWeb(q, opts): Promise<WebSearchResult> {
      const query = q.trim();
      if (!query) return { hits: [], error: null };

      return withRetry(async () => {
        const response = await postSerperSearch(apiKey, query, opts);
        if (!response.ok) {
          return {
            hits: [],
            error: parseSerperApiError(response.json, response.status, response.text),
          };
        }
        return { hits: mapSerperOrganicResults(response.json), error: null };
      });
    },
  };
}
