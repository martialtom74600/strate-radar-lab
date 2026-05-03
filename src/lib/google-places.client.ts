/**
 * Client Google Places API (Text Search — nouveau endpoint REST).
 * @see https://developers.google.com/maps/documentation/places/web-service/text-search
 */

import type { AppConfig } from '../config/index.js';
import { StrateRadarError } from './errors.js';
import { withRetry } from './retry.js';
import { createSerpClient, type SerpClient } from '../services/serp/serp.client.js';
import type {
  SerpGoogleLocalResponse,
  SerpLocalResult,
} from '../services/serp/schemas.js';
import type { SerpGoogleOrganicResponse } from '../services/serp/organic-schemas.js';
import type { GoogleLocalSearchParams, GoogleOrganicSearchParams } from '../services/serp/serp.client.js';

const PLACES_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

/** Sans espace (exigence Google FieldMask). + id / primaryType / nextPageToken pour pagination et clé stable. */
const FIELD_MASK =
  'places.id,places.displayName,places.rating,places.userRatingCount,places.websiteUri,places.formattedAddress,places.priceLevel,places.primaryType,places.types,nextPageToken';

type PlacesDisplayName = {
  readonly text?: string;
  readonly languageCode?: string;
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
};

type PlacesTextSearchResponseBody = {
  readonly places?: GooglePlaceRaw[];
  readonly nextPageToken?: string;
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

function extractPlaceId(place: GooglePlaceRaw): string | undefined {
  const id = place.id?.trim();
  if (id) return id;
  const name = place.name?.trim();
  if (!name) return undefined;
  const m = /^places\/(.+)$/.exec(name);
  return m?.[1]?.trim() || undefined;
}

function mapPlaceToLocalResult(place: GooglePlaceRaw, position: number): SerpLocalResult {
  const title = place.displayName?.text?.trim() || 'Établissement';
  const placeId = extractPlaceId(place);
  const priceLabel = mapPriceLevelToLabel(place.priceLevel);
  const primary = place.primaryType?.trim();
  const placeTypes = place.types?.map((t) => String(t).trim()).filter((t) => t.length > 0);

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
        mapPlaceToLocalResult(p, i + 1),
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
  };
}

/**
 * Mode réel : Google Places Text Search (+ même API pour le « deep » site web).
 * Mode simulation : conserve les mocks SerpApi existants (aucune clé Places requise).
 */
export function createRadarSearchClient(config: AppConfig): SerpClient {
  if (config.simulation) {
    return createSerpClient(config);
  }
  return createGooglePlacesLiveClient(config);
}
