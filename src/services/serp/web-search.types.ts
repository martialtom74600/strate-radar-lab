import type { OrganicSerpHit } from '../../lib/organic-serp-hit.js';

export type WebSearchError = {
  readonly httpStatus: number;
  readonly reason: string | null;
  readonly message: string;
};

export type WebSearchResult = {
  readonly hits: readonly OrganicSerpHit[];
  readonly error: WebSearchError | null;
};

export type WebSearchOptions = {
  readonly hl?: string;
  readonly gl?: string;
  readonly location?: string;
};

export type WebSearchClient = {
  readonly searchWeb: (q: string, opts?: WebSearchOptions) => Promise<WebSearchResult>;
};

/** Erreurs quota / paiement API (Serper, Brave) — déclenchent fallback ou kill switch. */
export function isWebSearchQuotaError(error: WebSearchError): boolean {
  return error.httpStatus === 402 || error.httpStatus === 403 || error.httpStatus === 429;
}

export function isStaticWebSearchNoiseHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  const blocked = [
    'google.',
    'googleusercontent.',
    'gstatic.',
    'youtube.',
    'wikipedia.org',
    'wikidata.org',
    'search.brave.com',
  ];
  return blocked.some((b) => h.includes(b));
}

export function shouldSkipWebSearchHost(hostname: string): boolean {
  return isStaticWebSearchNoiseHost(hostname);
}

/** Note lisible pour `websiteResolution.attempts` (couche web_search). */
export function formatWebSearchErrorNote(error: WebSearchError): string {
  if (error.httpStatus === 0 && error.reason) {
    return error.message.slice(0, 240);
  }
  const parts: string[] = [`HTTP ${error.httpStatus}`];
  if (error.reason) parts.push(error.reason);
  parts.push(error.message);
  return parts.join(' · ').slice(0, 240);
}
