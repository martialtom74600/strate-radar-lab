import type { SerpLocalResult } from '../services/serp/schemas.js';

import type { WebsiteSource } from '../storage/database.js';

/** Nombre minimal d’avis (strictement supérieur à 50). */
export const DIAMOND_MIN_REVIEWS_EXCLUSIVE = 50;

/** Note minimale Maps (strictement supérieure à 4.2). */
export const DIAMOND_MIN_RATING_EXCLUSIVE = 4.2;

export type DiamondPainType =
  | 'no_website'
  | 'site_not_linked_to_maps'
  | 'mobile_performance_critical'
  /** Bypass : flux Maps sans aucun site — score forcé 100, pas d’analyse technique. */
  | 'diamant_brut'
  /** Diamant qualifié par la matrice Strate (≥ seuil Strate hors bypass). */
  | 'strate_matrix';

/** Parse RADAR_DIAMOND_LOCATION_HINTS : sous-chaînes à retrouver dans adresse / titre. */
export function parseDiamondLocationHints(raw: string | undefined): readonly string[] {
  const fallback = ['annecy', 'chambéry'];
  if (!raw?.trim()) return fallback;
  const parsed = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

export function isProspectInTargetZone(
  serp: SerpLocalResult,
  hints: readonly string[],
): boolean {
  if (hints.length === 0) return true;
  const haystack = [serp.address, serp.title].filter(Boolean).join(' ').toLowerCase();
  return hints.some((h) => haystack.includes(h));
}

/** Preuve de flux + zone cible. */
export function hasTreasuryAndZone(
  serp: SerpLocalResult,
  locationHints: readonly string[],
): boolean {
  if ((serp.reviews ?? 0) <= DIAMOND_MIN_REVIEWS_EXCLUSIVE) return false;
  if ((serp.rating ?? 0) <= DIAMOND_MIN_RATING_EXCLUSIVE) return false;
  return isProspectInTargetZone(serp, locationHints);
}

export type ResolvedWebsite = {
  readonly displayUrl: string;
  readonly normalizedUrl: string;
  readonly source: WebsiteSource;
};
