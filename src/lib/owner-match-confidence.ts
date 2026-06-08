import { tokenizeBusinessName } from './organic-match.js';
import { fetchHtmlWithTimeout } from './strate-scorer.js';
import {
  classifyWebsiteUrl,
  htmlEmbedsBookingPlatform,
  isKnownPresenceHost,
} from './website-presence-taxonomy.js';

/** Top N résultats Google/Brave examinés (couches 3–4). */
export const EXTENDED_SEARCH_MAX_HITS = 6;

/** Seuil strict : refonte via recherche étendue uniquement si quasi-parfaite (nom + ville). */
export const EXTENDED_SEARCH_OWNER_MIN_CONFIDENCE = 0.85;

function normalizeMatchHaystack(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
}

function cityTokens(cityHint: string | null): string[] {
  const city = cityHint?.split(',')[0]?.trim() ?? '';
  return city ? tokenizeBusinessName(city) : [];
}

function countTokenHits(hay: string, tokens: readonly string[]): number {
  let hits = 0;
  for (const t of tokens) {
    if (hay.includes(t)) hits += 1;
  }
  return hits;
}

function preMatchHaystack(url: string, title?: string, snippet?: string): string {
  return normalizeMatchHaystack([url, title ?? '', snippet ?? ''].join(' '));
}

function hostnameFromUrl(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Le domaine porte au moins un token du nom commercial (signal site propriétaire). */
export function hostnameSharesBusinessTokens(hostname: string, businessName: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^www\./, '');
  if (!host) return false;
  const tokens = tokenizeBusinessName(businessName);
  if (tokens.length === 0) return false;
  const hostFirstLabel = host.split('.')[0] ?? host;
  return tokens.some((token) => host.includes(token) || hostFirstLabel.includes(token));
}

/**
 * Score 0–1 : site propriétaire quasi-parfait (nom commercial + ville dans le contenu).
 * Sous EXTENDED_SEARCH_OWNER_MIN_CONFIDENCE → le prospect reste création / présence.
 */
export async function scoreOwnerMatchConfidence(args: {
  readonly url: string;
  readonly businessName: string;
  readonly cityHint: string | null;
  readonly fetchTimeoutMs: number;
  readonly title?: string;
  readonly snippet?: string;
}): Promise<number> {
  const classified = classifyWebsiteUrl(args.url);
  if (!classified || classified.urlClass !== 'owner') return 0;

  const requestHost = hostnameFromUrl(classified.displayUrl);
  if (requestHost && isKnownPresenceHost(requestHost)) return 0;

  const nameTokens = tokenizeBusinessName(args.businessName);
  if (nameTokens.length === 0) return 0;

  const cities = cityTokens(args.cityHint);
  if (cities.length === 0) return 0;

  const preHay = preMatchHaystack(args.url, args.title, args.snippet);
  const preNameRatio = countTokenHits(preHay, nameTokens) / nameTokens.length;
  const preCityHit = cities.some((t) => preHay.includes(t));
  if (preNameRatio < 0.34 && !preCityHit) return 0;

  const fetchResult = await fetchHtmlWithTimeout(classified.displayUrl, args.fetchTimeoutMs);
  if (!fetchResult.ok || fetchResult.html.trim().length < 80) return 0;

  const finalClassified = classifyWebsiteUrl(fetchResult.finalUrl);
  if (!finalClassified || finalClassified.urlClass !== 'owner') return 0;

  const finalHost = hostnameFromUrl(fetchResult.finalUrl);
  if (finalHost && isKnownPresenceHost(finalHost)) return 0;

  const htmlSample = fetchResult.html.slice(0, 20_000);
  if (htmlEmbedsBookingPlatform(htmlSample)) return 0;

  const hay = normalizeMatchHaystack(`${fetchResult.finalUrl} ${htmlSample}`);

  const nameHits = countTokenHits(hay, nameTokens);
  const nameRatio = nameHits / nameTokens.length;
  const cityHit = cities.some((t) => hay.includes(t));

  const hostSharesName =
    finalHost.length > 0 && hostnameSharesBusinessTokens(finalHost, args.businessName);

  if (!cityHit) return Math.min(0.72, nameRatio * 0.7);
  if (!hostSharesName) return Math.min(0.82, nameRatio * 0.72);
  if (nameRatio >= 0.75) return Math.min(0.98, 0.86 + nameRatio * 0.12);
  if (nameRatio >= 0.5) return 0.78 + nameRatio * 0.08;
  return nameRatio * 0.75;
}
