import type { SerpGoogleLocalResponse } from './schemas.js';
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

export type SerpClient = {
  readonly searchGoogleLocal: (
    params: GoogleLocalSearchParams,
  ) => Promise<SerpGoogleLocalResponse>;
  readonly searchGoogleOrganic: (
    params: GoogleOrganicSearchParams,
  ) => Promise<SerpGoogleOrganicResponse>;
};
