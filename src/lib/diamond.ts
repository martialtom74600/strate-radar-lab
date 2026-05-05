import type { SerpLocalResult } from '../services/serp/schemas.js';

import type { WebsiteSource } from '../storage/database.js';

/** Seuils trésorerie / pilier 1 matrice (site présent) — inchangés vs ancien « filtre luxe ». */
export const DIAMOND_MIN_REVIEWS_EXCLUSIVE = 50;

/** Note minimale Maps pour le bonus « trésorerie » en matrice (strictement supérieur). */
export const DIAMOND_MIN_RATING_EXCLUSIVE = 4.2;

/**
 * Seuil « Diamant création » : pas de site web propriétaire, uniquement réputation Maps légère.
 * Strictement supérieur à ces valeurs.
 */
export const DIAMANT_CREATION_MIN_REVIEWS_EXCLUSIVE = 5;

export const DIAMANT_CREATION_MIN_RATING_EXCLUSIVE = 3.5;

export type DiamondPainType =
  | 'no_website'
  | 'site_not_linked_to_maps'
  | 'mobile_performance_critical'
  /** Pas de site propriétaire (ou seulement réseau / annuaire) + réputation minimale — score forcé, pas de matrice. */
  | 'diamant_creation'
  /** Diamant qualifié par la matrice Strate (≥ seuil) — refonte / dette technique. */
  | 'strate_matrix';

export type ResolvedWebsite = {
  readonly displayUrl: string;
  readonly normalizedUrl: string;
  readonly source: WebsiteSource;
};

/** Réputation Maps minimale pour le chemin Diamant création (sans filtre géographique sur l’adresse). */
export function hasCreationReputation(serp: SerpLocalResult): boolean {
  if ((serp.reviews ?? 0) <= DIAMANT_CREATION_MIN_REVIEWS_EXCLUSIVE) return false;
  if ((serp.rating ?? 0) <= DIAMANT_CREATION_MIN_RATING_EXCLUSIVE) return false;
  return true;
}
