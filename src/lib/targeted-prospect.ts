import { normalizeForMatch, tokenizeBusinessName } from './organic-match.js';
import type { SerpLocalResult } from '../services/serp/schemas.js';

export type TargetProspectSpec = {
  readonly name: string;
  readonly location?: string;
};

/** Score de correspondance nom cible ↔ fiche Maps (0–1). */
export function scoreProspectNameMatch(targetName: string, mapsTitle: string): number {
  const tokens = tokenizeBusinessName(targetName);
  if (tokens.length === 0) return 0;
  const hay = normalizeForMatch(mapsTitle);
  let hits = 0;
  for (const t of tokens) {
    if (hay.includes(t)) hits += 1;
  }
  return hits / tokens.length;
}

const MIN_TARGET_MATCH_RATIO = 0.45;

/** Meilleure fiche Maps pour un nom cible, ou null si aucun match suffisant. */
export function pickBestPlacesMatch(
  targetName: string,
  locals: readonly SerpLocalResult[],
): SerpLocalResult | null {
  let best: { readonly row: SerpLocalResult; readonly score: number } | null = null;
  for (const row of locals) {
    const score = scoreProspectNameMatch(targetName, row.title);
    if (score >= MIN_TARGET_MATCH_RATIO && (!best || score > best.score)) {
      best = { row, score };
    }
  }
  return best?.row ?? null;
}
