import type { AppConfig } from '../../config/index.js';
import { withRetry } from '../../lib/retry.js';
import type { OrganicSerpHit } from '../../lib/organic-match.js';

const CUSTOM_SEARCH_URL = 'https://www.googleapis.com/customsearch/v1';

/**
 * Moteur programmable Google « web entier » documenté par Google (exemple REST officiel).
 * Utilisé lorsque GOOGLE_SEARCH_CX n'est pas défini — évite de créer un PSE via l'UI dépréciée.
 * @see https://developers.google.com/custom-search/v1/using_rest
 */
const DEFAULT_GLOBAL_WEB_CX = '017576662512468239146:omuauf_lfve';

export type GoogleCustomSearchWebError = {
  readonly httpStatus: number;
  readonly reason: string | null;
  readonly message: string;
};

export type GoogleCustomSearchWebResult = {
  readonly hits: readonly OrganicSerpHit[];
  readonly error: GoogleCustomSearchWebError | null;
};

function resolveCustomSearchCx(config: AppConfig): string {
  const override = config.GOOGLE_SEARCH_CX?.trim();
  return override || DEFAULT_GLOBAL_WEB_CX;
}

export type GoogleCustomSearchWebClient = {
  readonly searchGoogleWeb: (
    q: string,
    opts?: { readonly hl?: string; readonly gl?: string },
  ) => Promise<GoogleCustomSearchWebResult>;
};

function shouldSkipWebHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  const blocked = [
    'google.',
    'googleusercontent.',
    'gstatic.',
    'youtube.',
    'facebook.',
    'instagram.',
    'linkedin.',
    'twitter.',
    'x.com',
    'tiktok.',
    'wikipedia.org',
    'wikidata.org',
  ];
  return blocked.some((b) => h.includes(b));
}

function mapCustomSearchItems(json: unknown): OrganicSerpHit[] {
  if (!json || typeof json !== 'object') return [];
  const o = json as Record<string, unknown>;
  const items = o.items;
  if (!Array.isArray(items)) return [];

  const out: OrganicSerpHit[] = [];
  for (const row of items) {
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
    if (shouldSkipWebHost(hostname)) continue;
    const title = typeof r.title === 'string' ? r.title : link;
    const snippet = typeof r.snippet === 'string' ? r.snippet : undefined;
    out.push({
      title,
      link,
      ...(snippet !== undefined ? { snippet } : {}),
    });
    if (out.length >= 8) break;
  }
  return out;
}

function parseGoogleCustomSearchApiError(
  json: unknown,
  httpStatus: number,
  rawBody: string,
): GoogleCustomSearchWebError {
  if (json && typeof json === 'object') {
    const root = json as Record<string, unknown>;
    const err = root.error;
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      const message =
        typeof e.message === 'string' && e.message.trim()
          ? e.message.trim()
          : `HTTP ${httpStatus}`;
      let reason: string | null = typeof e.status === 'string' ? e.status : null;
      const errors = e.errors;
      if (Array.isArray(errors) && errors.length > 0) {
        const first = errors[0];
        if (first && typeof first === 'object') {
          const r = (first as Record<string, unknown>).reason;
          if (typeof r === 'string' && r.trim()) {
            reason = r.trim();
          }
        }
      }
      return { httpStatus, reason, message };
    }
  }

  const fallback = rawBody.trim().slice(0, 200);
  return {
    httpStatus,
    reason: null,
    message: fallback || `HTTP ${httpStatus}`,
  };
}

/** Note lisible pour `websiteResolution.attempts` (couche web_search). */
export function formatGoogleCustomSearchErrorNote(error: GoogleCustomSearchWebError): string {
  if (error.httpStatus === 0 && error.reason) {
    return error.message.slice(0, 240);
  }
  const parts: string[] = [`HTTP ${error.httpStatus}`];
  if (error.reason) parts.push(error.reason);
  parts.push(error.message);
  return parts.join(' · ').slice(0, 240);
}

/**
 * Recherche web via Google Custom Search JSON API (couche 4 — website-resolver).
 * GOOGLE_SEARCH_CX est optionnel : sans override, le cx web global documenté par Google est utilisé.
 * @see https://developers.google.com/custom-search/v1/overview
 */
export function createGoogleCustomSearchWebClient(
  config: AppConfig,
): GoogleCustomSearchWebClient | null {
  const apiKey = config.GOOGLE_SEARCH_API_KEY?.trim();
  if (!apiKey || !config.RADAR_WEB_SEARCH_ENABLED) return null;

  const cx = resolveCustomSearchCx(config);

  return {
    async searchGoogleWeb(q, opts) {
      const query = q.trim();
      if (!query) return { hits: [], error: null };

      return withRetry(async () => {
        const params = new URLSearchParams({
          key: apiKey,
          cx,
          q: query,
          num: '8',
          searchType: 'web',
          filter: '0',
        });
        const hl = opts?.hl?.trim();
        if (hl) {
          params.set('hl', hl);
          const lang = hl.slice(0, 2).toLowerCase();
          if (/^[a-z]{2}$/.test(lang)) {
            params.set('lr', `lang_${lang}`);
          }
        }
        const gl = opts?.gl?.trim();
        if (gl) {
          params.set('gl', gl.slice(0, 2).toLowerCase());
        }

        const res = await fetch(`${CUSTOM_SEARCH_URL}?${params.toString()}`, {
          signal: AbortSignal.timeout(20_000),
        });
        const text = await res.text();
        let json: unknown;
        try {
          json = JSON.parse(text) as unknown;
        } catch {
          json = null;
        }

        if (!res.ok) {
          return {
            hits: [],
            error: parseGoogleCustomSearchApiError(json, res.status, text),
          };
        }

        return {
          hits: mapCustomSearchItems(json),
          error: null,
        };
      });
    },
  };
}
