import type { OrganicSerpHit } from '../../lib/organic-match.js';

export type WebSearchError = {
  readonly httpStatus: number;
  readonly reason: string | null;
  readonly message: string;
};

export type WebSearchResult = {
  readonly hits: readonly OrganicSerpHit[];
  readonly error: WebSearchError | null;
};

export type WebSearchClient = {
  readonly searchWeb: (
    q: string,
    opts?: { readonly hl?: string; readonly gl?: string },
  ) => Promise<WebSearchResult>;
};

export function shouldSkipWebSearchHost(hostname: string): boolean {
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
    'search.brave.com',
  ];
  return blocked.some((b) => h.includes(b));
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
