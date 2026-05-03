import type { AppConfig } from '../../config/index.js';
import { StrateRadarError } from '../../lib/errors.js';
import { withRetry } from '../../lib/retry.js';
import { MOCK_SERP_GOOGLE_ORGANIC_RESPONSE } from './organic-mock.js';
import {
  serpGoogleOrganicResponseSchema,
  type SerpGoogleOrganicResponse,
} from './organic-schemas.js';
import { MOCK_SERP_GOOGLE_LOCAL_RESPONSE } from './mock-data.js';
import {
  serpGoogleLocalResponseSchema,
  type SerpGoogleLocalResponse,
} from './schemas.js';

export type GoogleLocalSearchParams = {
  readonly q: string;
  readonly location?: string;
  readonly hl?: string;
  readonly gl?: string;
  /** @deprecated SerpApi — conservé pour mocks ; Places utilise pageToken. */
  readonly start?: number;
  /** Pagination Places Text Search (nextPageToken de la réponse précédente). */
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

const SERPAPI_BASE = 'https://serpapi.com/search.json';

/**
 * SerpApi renvoie parfois un champ `error` en fin de pagination (ex. page 2 vide)
 * au lieu de `local_results: []`. On normalise en « pack vide » pour ne pas casser la pipeline.
 */
function isGoogleLocalNoMoreResultsMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("hasn't returned any results") ||
    m.includes('has not returned any results') ||
    m.includes('returned any results for this query') ||
    m.includes('google local has no results')
  );
}

function emptyGoogleLocalPackResponse(): SerpGoogleLocalResponse {
  return {
    search_metadata: {
      id: 'google-local-empty-end-of-pagination',
      status: 'Success',
    },
    search_parameters: {
      engine: 'google_local',
      q: '',
    },
    local_results: [],
  };
}

async function readSerpApiErrorDetail(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { error?: string };
    if (typeof j.error === 'string' && j.error.trim()) return j.error.trim();
  } catch {
    /* pas du JSON */
  }
  const t = text.trim();
  return t.length > 0 ? t.slice(0, 600) : '(corps de réponse vide)';
}

function parseSerpJson(raw: unknown): SerpGoogleLocalResponse {
  const obj =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)
      : undefined;
  if (obj?.error !== undefined && typeof obj.error === 'string') {
    const err = obj.error.trim();
    if (isGoogleLocalNoMoreResultsMessage(err)) {
      return emptyGoogleLocalPackResponse();
    }
    throw new StrateRadarError('SERPAPI_ERROR', err);
  }
  const parsed = serpGoogleLocalResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StrateRadarError(
      'SERP_PARSE',
      `Réponse SerpApi invalide : ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }
  const data = parsed.data;
  if (data.search_metadata.status !== 'Success') {
    throw new StrateRadarError(
      'SERP_STATUS',
      `SerpApi status=${data.search_metadata.status}`,
    );
  }
  return data;
}

function parseOrganicJson(raw: unknown): SerpGoogleOrganicResponse {
  const obj =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)
      : undefined;
  if (obj?.error !== undefined && typeof obj.error === 'string') {
    throw new StrateRadarError('SERPAPI_ERROR', obj.error);
  }
  const parsed = serpGoogleOrganicResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StrateRadarError(
      'SERP_ORGANIC_PARSE',
      `Réponse SerpApi Google organique invalide : ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }
  const data = parsed.data;
  if (data.search_metadata.status !== 'Success') {
    throw new StrateRadarError(
      'SERP_ORGANIC_STATUS',
      `SerpApi Google status=${data.search_metadata.status}`,
    );
  }
  return data;
}

async function fetchGoogleLocalLive(
  apiKey: string,
  params: GoogleLocalSearchParams,
  googleDomain: string | undefined,
): Promise<SerpGoogleLocalResponse> {
  const url = new URL(SERPAPI_BASE);
  url.searchParams.set('engine', 'google_local');
  url.searchParams.set('q', params.q);
  url.searchParams.set('api_key', apiKey);
  if (params.location) url.searchParams.set('location', params.location);
  if (params.hl) url.searchParams.set('hl', params.hl);
  if (params.gl) url.searchParams.set('gl', params.gl);
  const gd = googleDomain?.trim();
  if (gd) url.searchParams.set('google_domain', gd);
  if (params.start !== undefined) {
    url.searchParams.set('start', String(params.start));
  }

  return withRetry(async () => {
    const res = await fetch(url);

    if (!res.ok) {
      const detail = await readSerpApiErrorDetail(res);
      throw new StrateRadarError(
        'HTTP_STATUS',
        `SerpApi HTTP ${res.status}${detail ? ` — ${detail}` : ''}`,
        { status: res.status },
      );
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new StrateRadarError('SERP_JSON', 'Corps JSON invalide', { cause: e });
    }
    return parseSerpJson(json);
  });
}

async function fetchGoogleOrganicLive(
  apiKey: string,
  params: GoogleOrganicSearchParams,
  googleDomain: string | undefined,
): Promise<SerpGoogleOrganicResponse> {
  const url = new URL(SERPAPI_BASE);
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', params.q);
  url.searchParams.set('api_key', apiKey);
  if (params.hl) url.searchParams.set('hl', params.hl);
  if (params.gl) url.searchParams.set('gl', params.gl);
  const gd = googleDomain?.trim();
  if (gd) url.searchParams.set('google_domain', gd);

  return withRetry(async () => {
    const res = await fetch(url);

    if (!res.ok) {
      const detail = await readSerpApiErrorDetail(res);
      throw new StrateRadarError(
        'HTTP_STATUS',
        `SerpApi HTTP ${res.status}${detail ? ` — ${detail}` : ''}`,
        { status: res.status },
      );
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new StrateRadarError('SERP_JSON', 'Corps JSON invalide', { cause: e });
    }
    return parseOrganicJson(json);
  });
}

export function createSerpClient(config: AppConfig): SerpClient {
  if (config.simulation) {
    return {
      async searchGoogleLocal(params: GoogleLocalSearchParams) {
        const start = params.start ?? 0;
        if (start >= 20 || (params.pageToken !== undefined && params.pageToken !== '')) {
          const base = structuredClone(MOCK_SERP_GOOGLE_LOCAL_RESPONSE);
          base.local_results = [];
          base.search_metadata = { ...base.search_metadata, id: 'mock-local-empty-page' };
          return parseSerpJson(base);
        }
        return parseSerpJson(structuredClone(MOCK_SERP_GOOGLE_LOCAL_RESPONSE));
      },
      async searchGoogleOrganic(_params: GoogleOrganicSearchParams) {
        return parseOrganicJson(structuredClone(MOCK_SERP_GOOGLE_ORGANIC_RESPONSE));
      },
    };
  }

  const apiKey = config.SERPAPI_API_KEY?.trim();
  if (!apiKey) {
    throw new StrateRadarError('CONFIG', 'SERPAPI_API_KEY manquant en mode réel');
  }

  const gd = config.SERPAPI_GOOGLE_DOMAIN;
  return {
    searchGoogleLocal(params: GoogleLocalSearchParams) {
      return fetchGoogleLocalLive(apiKey, params, gd);
    },
    searchGoogleOrganic(params: GoogleOrganicSearchParams) {
      return fetchGoogleOrganicLive(apiKey, params, gd);
    },
  };
}
