/**
 * Client Google Places API (Text Search + Nearby Search).
 * @see https://developers.google.com/maps/documentation/places/web-service/text-search
 * @see https://developers.google.com/maps/documentation/places/web-service/nearby-search
 */

import type { AppConfig } from '../config/index.js';
import { StrateRadarError } from './errors.js';
import { withRetry } from './retry.js';
import { MOCK_SERP_GOOGLE_ORGANIC_RESPONSE } from '../services/serp/organic-mock.js';
import type { SerpGoogleOrganicResponse } from '../services/serp/organic-schemas.js';
import { MOCK_SERP_GOOGLE_LOCAL_RESPONSE } from '../services/serp/mock-data.js';
import type { SerpGoogleLocalResponse, SerpLocalResult } from '../services/serp/schemas.js';
import type {
  GoogleLocalSearchParams,
  GoogleNearbySearchParams,
  GoogleOrganicSearchParams,
  SerpClient,
} from '../services/serp/search-client.types.js';

const PLACES_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const PLACES_NEARBY_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchNearby';

const FIELD_MASK =
  'places.id,places.displayName,places.rating,places.userRatingCount,places.websiteUri,places.formattedAddress,places.priceLevel,places.primaryType,places.types,places.location,places.photos,places.reviews,nextPageToken';

const NEARBY_FIELD_MASK =
  'places.id,places.displayName,places.rating,places.userRatingCount,places.websiteUri,places.formattedAddress,places.primaryType,places.types,places.location,places.reviews';

type PlacesDisplayName = {
  readonly text?: string;
  readonly languageCode?: string;
};

type GooglePlacePhoto = {
  readonly name?: string;
};

type GoogleReviewRaw = {
  readonly rating?: number;
  readonly text?: { readonly text?: string };
  readonly originalText?: { readonly text?: string };
};

type GooglePlaceRaw = {
  readonly id?: string;
  readonly name?: string;
  readonly displayName?: PlacesDisplayName;
  readonly formattedAddress?: string;
  readonly rating?: number;
  readonly userRatingCount?: number;
  readonly websiteUri?: string;
  readonly priceLevel?: string;
  readonly primaryType?: string;
  readonly types?: readonly string[];
  readonly location?: {
    readonly latitude?: number;
    readonly longitude?: number;
  };
  readonly photos?: readonly GooglePlacePhoto[];
  readonly reviews?: readonly GoogleReviewRaw[];
};

type PlacesTextSearchResponseBody = {
  readonly places?: GooglePlaceRaw[];
  readonly nextPageToken?: string;
};

type PlacesNearbySearchResponseBody = {
  readonly places?: GooglePlaceRaw[];
};

function mapPriceLevelToLabel(level: string | undefined): string | undefined {
  if (!level) return undefined;
  const m: Record<string, string> = {
    PRICE_LEVEL_FREE: '',
    PRICE_LEVEL_INEXPENSIVE: '€',
    PRICE_LEVEL_MODERATE: '€€',
    PRICE_LEVEL_EXPENSIVE: '€€€',
    PRICE_LEVEL_VERY_EXPENSIVE: '€€€€',
  };
  return m[level] ?? undefined;
}

export function buildPlacesPhotoMediaUrl(photoResourceName: string, apiKey: string): string {
  const name = photoResourceName.trim().replace(/^\/+|\/+$/g, '');
  const key = apiKey.trim();
  if (!name || !key) return '';
  return `https://places.googleapis.com/v1/${name}/media?maxHeightPx=900&maxWidthPx=1200&key=${encodeURIComponent(key)}`;
}

function pickFirstPhotoName(place: GooglePlaceRaw): string | undefined {
  const list = place.photos;
  if (!list || list.length === 0) return undefined;
  const n = list[0]?.name?.trim();
  return n && n.length > 0 ? n : undefined;
}

function extractPlaceId(place: GooglePlaceRaw): string | undefined {
  const id = place.id?.trim();
  if (id) return id;
  const name = place.name?.trim();
  if (!name) return undefined;
  const m = /^places\/(.+)$/.exec(name);
  return m?.[1]?.trim() || undefined;
}

function extractReviewTextBodies(place: GooglePlaceRaw, maxReviews = 10): readonly string[] {
  const raw = place.reviews;
  if (!raw || raw.length === 0) return [];
  const out: string[] = [];
  for (const r of raw) {
    const combined =
      (typeof r.originalText?.text === 'string' ? r.originalText.text.trim() : '') ||
      (typeof r.text?.text === 'string' ? r.text.text.trim() : '');
    if (combined.length < 3) continue;
    out.push(combined.slice(0, 4000));
    if (out.length >= maxReviews) break;
  }
  return out;
}

function mapPlaceToLocalResult(
  place: GooglePlaceRaw,
  position: number,
  placesApiKey: string | undefined,
): SerpLocalResult {
  const title = place.displayName?.text?.trim() || 'Établissement';
  const placeId = extractPlaceId(place);
  const priceLabel = mapPriceLevelToLabel(place.priceLevel);
  const primary = place.primaryType?.trim();
  const placeTypes = place.types?.map((t) => String(t).trim()).filter((t) => t.length > 0);
  const lat = place.location?.latitude;
  const lng = place.location?.longitude;
  const photoName = pickFirstPhotoName(place);
  const thumb =
    photoName !== undefined && placesApiKey !== undefined && placesApiKey.trim() !== ''
      ? buildPlacesPhotoMediaUrl(photoName, placesApiKey)
      : undefined;
  const reviewBodies = extractReviewTextBodies(place, 10);

  return {
    position,
    title,
    ...(placeId !== undefined ? { place_id: placeId } : {}),
    ...(place.formattedAddress !== undefined && place.formattedAddress !== ''
      ? { address: place.formattedAddress }
      : {}),
    ...(place.websiteUri !== undefined && place.websiteUri !== ''
      ? { website: place.websiteUri }
      : {}),
    ...(typeof place.rating === 'number' && !Number.isNaN(place.rating) ? { rating: place.rating } : {}),
    ...(typeof place.userRatingCount === 'number' && !Number.isNaN(place.userRatingCount)
      ? { reviews: place.userRatingCount }
      : {}),
    ...(priceLabel !== undefined && priceLabel !== '' ? { price: priceLabel } : {}),
    ...(primary !== undefined && primary !== '' ? { type: primary } : {}),
    ...(placeTypes !== undefined && placeTypes.length > 0 ? { types: [...placeTypes] } : {}),
    ...(typeof lat === 'number' &&
    typeof lng === 'number' &&
    !Number.isNaN(lat) &&
    !Number.isNaN(lng)
      ? { gps_coordinates: { latitude: lat, longitude: lng } }
      : {}),
    ...(thumb !== undefined && thumb !== '' ? { thumbnail: thumb } : {}),
    ...(reviewBodies.length > 0 ? { place_review_texts: [...reviewBodies] } : {}),
  };
}

function buildTextQuery(q: string, location: string | undefined): string {
  const parts = [q.trim(), location?.trim()].filter((p) => p && p.length > 0);
  return parts.join(' ').trim();
}

async function postSearchText(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<PlacesTextSearchResponseBody> {
  return withRetry(async (_ctx) => {
    const res = await fetch(PLACES_TEXT_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new StrateRadarError(
        'PLACES_JSON',
        `Places API : réponse non JSON (HTTP ${res.status})`,
        { status: res.status },
      );
    }

    if (!res.ok) {
      const errObj = json as { error?: { message?: string; status?: string } };
      const msg =
        typeof errObj.error?.message === 'string'
          ? errObj.error.message
          : text.slice(0, 400);
      throw new StrateRadarError(
        'HTTP_STATUS',
        `Places API HTTP ${res.status} — ${msg}`,
        { status: res.status },
      );
    }

    return json as PlacesTextSearchResponseBody;
  });
}

async function postSearchNearby(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<PlacesNearbySearchResponseBody> {
  return withRetry(async (_ctx) => {
    const res = await fetch(PLACES_NEARBY_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': NEARBY_FIELD_MASK,
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new StrateRadarError(
        'PLACES_JSON',
        `Places Nearby API : réponse non JSON (HTTP ${res.status})`,
        { status: res.status },
      );
    }

    if (!res.ok) {
      const errObj = json as { error?: { message?: string; status?: string } };
      const msg =
        typeof errObj.error?.message === 'string'
          ? errObj.error.message
          : text.slice(0, 400);
      throw new StrateRadarError(
        'HTTP_STATUS',
        `Places Nearby API HTTP ${res.status} — ${msg}`,
        { status: res.status },
      );
    }

    return json as PlacesNearbySearchResponseBody;
  });
}

/** Concurrents synthétiques (simulation) — sites web présents pour le rendu rapport / FOMO. */
function buildMockNearbyPlaces(params: GoogleNearbySearchParams): SerpLocalResult[] {
  const lat = params.latitude;
  const lng = params.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  const dLat = (meters: number) => meters / 111320;
  const dLng = (meters: number, atLat: number) =>
    meters / (111320 * Math.cos((atLat * Math.PI) / 180));

  const primary = params.includedPrimaryTypes[0]?.trim() ?? 'bakery';

  const mk = (
    i: number,
    title: string,
    site: string,
    r: number,
    rev: number,
    northM: number,
    eastM: number,
    pid: string,
  ): SerpLocalResult => ({
    position: i + 1,
    title,
    place_id: pid,
    website: site,
    rating: r,
    reviews: rev,
    gps_coordinates: {
      latitude: lat + dLat(northM),
      longitude: lng + dLng(eastM, lat),
    },
    type: primary,
    address: 'Adresse fictive (mock concurrent local)',
  });

  return [
    mk(0, 'Concurrence mock — Le Fournil du Lac', 'https://mock-concurrent-1.example', 4.72, 190, 95, -60, 'ChIJmockcomp000000001'),
    mk(1, 'Pain & Chocolat Cran (mock)', 'https://mock-concurrent-2.example', 4.61, 88, -120, 180, 'ChIJmockcomp000000002'),
    mk(2, 'Boulangerie des Alpes mock', 'https://mock-concurrent-3.example', 4.55, 156, 200, -40, 'ChIJmockcomp000000003'),
  ];
}

function emptyLocalPack(q: string, location: string | undefined): SerpGoogleLocalResponse {
  return {
    search_metadata: { id: 'google-places-empty', status: 'Success' },
    search_parameters: {
      engine: 'google_places_text',
      q,
      ...(location !== undefined ? { location } : {}),
    },
    local_results: [],
  };
}

function createGooglePlacesSimulationClient(): SerpClient {
  return {
    async searchGoogleLocal(params: GoogleLocalSearchParams): Promise<SerpGoogleLocalResponse> {
      if (params.pageToken !== undefined && params.pageToken !== '') {
        const base = structuredClone(MOCK_SERP_GOOGLE_LOCAL_RESPONSE) as Record<string, unknown>;
        base.local_results = [];
        const sm = base.search_metadata as Record<string, unknown>;
        base.search_metadata = { ...sm, id: 'mock-places-empty-page' };
        return base as SerpGoogleLocalResponse;
      }
      return structuredClone(MOCK_SERP_GOOGLE_LOCAL_RESPONSE) as SerpGoogleLocalResponse;
    },
    async searchGoogleOrganic(
      _params: GoogleOrganicSearchParams,
    ): Promise<SerpGoogleOrganicResponse> {
      return structuredClone(MOCK_SERP_GOOGLE_ORGANIC_RESPONSE) as SerpGoogleOrganicResponse;
    },
    async searchGoogleNearby(params: GoogleNearbySearchParams): Promise<readonly SerpLocalResult[]> {
      return buildMockNearbyPlaces(params);
    },
  };
}

function createGooglePlacesLiveClient(config: AppConfig): SerpClient {
  const apiKey = config.GOOGLE_PLACES_API_KEY?.trim();
  if (!apiKey) {
    throw new StrateRadarError('CONFIG', 'GOOGLE_PLACES_API_KEY manquant en mode réel');
  }

  return {
    async searchGoogleLocal(params: GoogleLocalSearchParams): Promise<SerpGoogleLocalResponse> {
      const textQuery = buildTextQuery(params.q, params.location);
      if (!textQuery) {
        return emptyLocalPack(params.q, params.location);
      }

      const body: Record<string, unknown> = {
        textQuery,
        pageSize: 20,
      };
      const token = params.pageToken?.trim();
      if (token) body.pageToken = token;
      if (params.hl?.trim()) body.languageCode = params.hl.trim();
      if (params.gl?.trim()) {
        body.regionCode = params.gl.trim().toUpperCase().slice(0, 2);
      }

      const data = await postSearchText(apiKey, body);
      const rawPlaces = data.places ?? [];
      const local_results: SerpLocalResult[] = rawPlaces.map((p, i) =>
        mapPlaceToLocalResult(p, i + 1, apiKey),
      );

      return {
        search_metadata: {
          id: `places-text-${Date.now()}`,
          status: 'Success',
        },
        search_parameters: {
          engine: 'google_places_text',
          q: params.q,
          ...(params.location !== undefined ? { location: params.location } : {}),
          ...(params.hl !== undefined ? { hl: params.hl } : {}),
          ...(params.gl !== undefined ? { gl: params.gl } : {}),
        },
        local_results,
        ...(data.nextPageToken !== undefined && data.nextPageToken !== ''
          ? { next_page_token: data.nextPageToken }
          : {}),
      };
    },

    async searchGoogleOrganic(params: GoogleOrganicSearchParams): Promise<SerpGoogleOrganicResponse> {
      const textQuery = params.q.trim();
      if (!textQuery) {
        return {
          search_metadata: { id: 'places-organic-empty', status: 'Success' },
          search_parameters: { engine: 'google_places_text', q: params.q },
          organic_results: [],
        };
      }

      const body: Record<string, unknown> = {
        textQuery,
        pageSize: 10,
      };

      const data = await postSearchText(apiKey, body);
      const rawPlaces = data.places ?? [];
      const organic_results = rawPlaces
        .map((p, idx) => {
          const uri = p.websiteUri?.trim();
          if (!uri) return null;
          const title = p.displayName?.text?.trim() ?? '';
          return {
            position: idx + 1,
            title: title.length > 0 ? title : uri,
            link: uri,
            ...(p.formattedAddress !== undefined && p.formattedAddress !== ''
              ? { snippet: p.formattedAddress }
              : {}),
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      return {
        search_metadata: { id: `places-organic-${Date.now()}`, status: 'Success' },
        search_parameters: { engine: 'google_places_text', q: params.q },
        organic_results,
      };
    },

    async searchGoogleNearby(params: GoogleNearbySearchParams): Promise<readonly SerpLocalResult[]> {
      const lat = params.latitude;
      const lng = params.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];

      const types = [...params.includedPrimaryTypes].map((t) => t.trim()).filter((t) => t.length > 0);
      if (types.length === 0) return [];

      const r = Number(params.radiusMeters);
      if (!Number.isFinite(r) || r <= 0) return [];

      const maxRc = Math.min(Math.max(Number(params.maxResultCount ?? 20), 1), 20);

      const body: Record<string, unknown> = {
        locationRestriction: {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: r,
          },
        },
        includedPrimaryTypes: types,
        rankPreference: 'DISTANCE',
        maxResultCount: maxRc,
      };
      const hlTr = params.hl?.trim();
      if (hlTr) body.languageCode = hlTr;
      const glTr = params.gl?.trim();
      if (glTr) body.regionCode = glTr.toUpperCase().slice(0, 2);

      const data = await postSearchNearby(apiKey, body);
      const rawPlaces = data.places ?? [];
      return rawPlaces.map((p, i) => mapPlaceToLocalResult(p, i + 1, apiKey));
    },
  };
}

export function createRadarSearchClient(config: AppConfig): SerpClient {
  if (config.simulation) {
    return createGooglePlacesSimulationClient();
  }
  return createGooglePlacesLiveClient(config);
}
