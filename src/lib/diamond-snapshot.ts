import type { SerpLocalResult } from '../services/serp/schemas.js';
import type { DiamondWebsiteStatus, ProspectRepository } from '../storage/index.js';
import type { GoogleMapsRaw } from './strate-studio/audit-payload.js';

export function googleMapsRawToSerp(raw: GoogleMapsRaw): SerpLocalResult {
  return {
    title: raw.title,
    ...(raw.place_id ? { place_id: raw.place_id } : {}),
    ...(raw.type ? { type: raw.type } : {}),
    ...(raw.types?.length ? { types: [...raw.types] } : {}),
    ...(raw.address ? { address: raw.address } : {}),
    ...(raw.rating !== null && raw.rating !== undefined ? { rating: raw.rating } : {}),
    ...(raw.reviews !== null && raw.reviews !== undefined ? { reviews: raw.reviews } : {}),
    ...(raw.price ? { price: raw.price } : {}),
    ...(raw.gps_coordinates ? { gps_coordinates: raw.gps_coordinates } : {}),
    ...(raw.mapsListingWebsite ? { website: raw.mapsListingWebsite } : {}),
  };
}

/** Persiste un diamant création / présence pour scrub retroactif ultérieur. */
export async function persistDiamondSnapshotForScrub(
  repo: ProspectRepository,
  args: {
    readonly placeKey: string;
    readonly serp: SerpLocalResult;
    readonly searchLocation: string | null;
    readonly websiteStatus: DiamondWebsiteStatus;
    readonly conversionBadge: 'DIAMANT_CREATION' | 'DIAMANT_PRESENCE';
  },
): Promise<void> {
  await repo.upsertDiamondSnapshot({
    placeKey: args.placeKey,
    businessName: args.serp.title,
    websiteStatus: args.websiteStatus,
    conversionBadge: args.conversionBadge,
    searchLocation: args.searchLocation,
    serpRow: args.serp,
  });
}
