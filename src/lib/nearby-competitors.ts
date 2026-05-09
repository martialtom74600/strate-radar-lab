import type { SerpClient } from '../services/serp/search-client.types.js';
import type { SerpLocalResult } from '../services/serp/schemas.js';

/** Concurrents directs (effet FOMO) — ajout optionnel rapport / payload vitrine. */
export type RadarNearbyCompetitor = {
  readonly name: string;
  readonly websiteUrl: string;
  readonly rating: number | null;
  /** Distance orthodromique prospect → concurrent (mètres, arrondi). */
  readonly distanceMeters: number;
};

function normalizeGooglePrimaryTypeForNearby(serp: SerpLocalResult): string | null {
  const out: string[] = [];
  const t = serp.type?.trim().toLowerCase();
  if (t && /^[a-z][a-z0-9_]*$/.test(t)) out.push(t);
  if (serp.types !== undefined) {
    for (const x of serp.types) {
      const s = String(x).trim().toLowerCase();
      if (/^[a-z][a-z0-9_]*$/.test(s)) out.push(s);
    }
  }
  return out[0] ?? null;
}

function haversineMeters(
  a: { readonly latitude: number; readonly longitude: number },
  b: { readonly latitude: number; readonly longitude: number },
): number {
  const R = 6371000;
  const φ1 = (a.latitude * Math.PI) / 180;
  const φ2 = (b.latitude * Math.PI) / 180;
  const Δφ = ((b.latitude - a.latitude) * Math.PI) / 180;
  const Δλ = ((b.longitude - a.longitude) * Math.PI) / 180;
  const s =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function normalizeTitleKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function isSameEstablishmentAsProspect(prospect: SerpLocalResult, candidate: SerpLocalResult): boolean {
  const pId = prospect.place_id?.trim();
  const cId = candidate.place_id?.trim();
  if (pId && cId && pId === cId) return true;
  const pG = prospect.gps_coordinates;
  const cG = candidate.gps_coordinates;
  if (
    pG &&
    cG &&
    typeof pG.latitude === 'number' &&
    typeof pG.longitude === 'number' &&
    typeof cG.latitude === 'number' &&
    typeof cG.longitude === 'number'
  ) {
    const d = haversineMeters(pG, cG);
    if (d < 12 && normalizeTitleKey(prospect.title) === normalizeTitleKey(candidate.title)) {
      return true;
    }
  }
  return false;
}

export type NearbyCompetitorFetchBudget = {
  readonly used: number;
  readonly max: number;
};

/**
 * Nearby Search Places (budget global identique aux autres appels SERP enveloppés).
 *
 * Retour :
 * - `undefined` si aucun appel (pas de GPS, métier inexploitable, budget épuisé avant requête) ;
 * - `[]` si appel tenté mais vide / erreur / filtre ;
 * - jusqu'à 3 entrées sinon.
 *
 * Les erreurs API sont swallowées (`[]`).
 */
export async function fetchNearbyWebsiteCompetitorsForDiamond(args: {
  readonly prospect: SerpLocalResult;
  readonly serpClient: SerpClient;
  readonly placesBudget: NearbyCompetitorFetchBudget;
  readonly radiusMeters: number;
  readonly searchHl?: string;
  readonly searchGl?: string;
}): Promise<readonly RadarNearbyCompetitor[] | undefined> {
  const { prospect, serpClient, placesBudget, radiusMeters, searchHl, searchGl } = args;

  const g = prospect.gps_coordinates;
  if (
    !g ||
    typeof g.latitude !== 'number' ||
    typeof g.longitude !== 'number' ||
    Number.isNaN(g.latitude) ||
    Number.isNaN(g.longitude)
  ) {
    return undefined;
  }

  const primaryType = normalizeGooglePrimaryTypeForNearby(prospect);
  if (!primaryType) {
    return undefined;
  }

  if (placesBudget.used >= placesBudget.max) {
    return undefined;
  }

  try {
    const raw = await serpClient.searchGoogleNearby({
      latitude: g.latitude,
      longitude: g.longitude,
      radiusMeters,
      includedPrimaryTypes: [primaryType],
      ...(searchHl !== undefined ? { hl: searchHl } : {}),
      ...(searchGl !== undefined ? { gl: searchGl } : {}),
      maxResultCount: 20,
    });

    const withSite = raw.filter((row) => {
      const w = row.website?.trim();
      return Boolean(w && w.length > 0);
    });

    const notSelf = withSite.filter((row) => !isSameEstablishmentAsProspect(prospect, row));

    const enriched = notSelf
      .map((row) => {
        const cg = row.gps_coordinates;
        if (
          !cg ||
          typeof cg.latitude !== 'number' ||
          typeof cg.longitude !== 'number' ||
          Number.isNaN(cg.latitude) ||
          Number.isNaN(cg.longitude)
        ) {
          return null;
        }
        return {
          row,
          distanceMeters: haversineMeters(g, cg),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    enriched.sort((a, b) => a.distanceMeters - b.distanceMeters);

    return enriched.slice(0, 3).map(({ row, distanceMeters }) => ({
      name: row.title.trim(),
      websiteUrl: row.website!.trim(),
      rating:
        typeof row.rating === 'number' && !Number.isNaN(row.rating) ? row.rating : null,
      distanceMeters: Math.round(distanceMeters),
    }));
  } catch {
    return [];
  }
}
