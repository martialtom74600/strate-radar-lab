import type { SerpGoogleLocalResponse, SerpLocalResult } from './schemas.js';
import type { SerpGoogleOrganicResponse } from './organic-schemas.js';

export type GoogleLocalSearchParams = {
  readonly q: string;
  readonly location?: string;
  readonly hl?: string;
  readonly gl?: string;
  /** Pagination Places Text Search (nextPageToken). */
  readonly pageToken?: string;
};

export type GoogleOrganicSearchParams = {
  readonly q: string;
  readonly hl?: string;
  readonly gl?: string;
};

/** Places API (New) — `places:searchNearby`. */
export type GoogleNearbySearchParams = {
  readonly latitude: number;
  readonly longitude: number;
  /** Rayon du cercle (mètres) — valeur API typique « max » 50000. */
  readonly radiusMeters: number;
  /** Types primaires Places (table A). Au moins 1 pour guider les concurrents « même métier ». */
  readonly includedPrimaryTypes: readonly string[];
  readonly hl?: string;
  readonly gl?: string;
  /** 1–20 (défaut API si absent ~20). */
  readonly maxResultCount?: number;
};

export type SerpClient = {
  readonly searchGoogleLocal: (
    params: GoogleLocalSearchParams,
  ) => Promise<SerpGoogleLocalResponse>;
  readonly searchGoogleOrganic: (
    params: GoogleOrganicSearchParams,
  ) => Promise<SerpGoogleOrganicResponse>;
  readonly searchGoogleNearby: (
    params: GoogleNearbySearchParams,
  ) => Promise<readonly SerpLocalResult[]>;
};
