import type { ResolvedWebsite } from './diamond.js';
import {
  pickBestOrganicUrlForBusiness,
  pickOrganicUrlByPlaceId,
  tokenizeBusinessName,
  type OrganicSerpHit,
} from './organic-match.js';
import {
  formatWebSearchErrorNote,
  type WebSearchClient,
} from '../services/serp/web-search.types.js';
import type { SerpClient } from '../services/serp/search-client.types.js';
import type { SerpLocalResult } from '../services/serp/schemas.js';
import { fetchHtmlWithTimeout } from './strate-scorer.js';
import {
  classifyWebsiteUrl,
  type WebsitePresenceStatus,
} from './website-presence-taxonomy.js';

export type WebsiteResolutionSource =
  | 'maps_link'
  | 'place_details'
  | 'places_requery'
  | 'web_search'
  | 'presence_taxonomy';

export type WebsiteResolutionAttempt = {
  readonly layer: string;
  readonly url: string | null;
  readonly outcome: WebsitePresenceStatus | 'skipped' | 'invalid';
  readonly note?: string;
};

export type WebsiteResolution = {
  readonly status: WebsitePresenceStatus;
  readonly confidence: number;
  readonly url: string | null;
  readonly displayUrl: string | null;
  readonly normalizedUrl: string | null;
  readonly source: WebsiteResolutionSource | null;
  readonly mapsListingWebsite: string | null;
  readonly presencePlatform: string | null;
  readonly attempts: readonly WebsiteResolutionAttempt[];
};

export type WebsiteResolutionResult = {
  readonly resolution: WebsiteResolution;
  /** Site propriétaire exploitable (matrice / refonte) — null si presence_only ou none. */
  readonly ownerSite: ResolvedWebsite | null;
};

export type ResolveProspectWebsiteOptions = {
  readonly skipExtendedSearch?: boolean;
  readonly fetchTimeoutMs: number;
};

type CandidateOwner = {
  readonly displayUrl: string;
  readonly normalizedUrl: string;
  readonly source: WebsiteResolutionSource;
  readonly confidence: number;
  readonly layer: string;
};

type CandidatePresence = {
  readonly displayUrl: string;
  readonly normalizedUrl: string;
  readonly platformLabel: string | null;
  readonly source: WebsiteResolutionSource;
  readonly layer: string;
};

function normalizeMatchHaystack(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
}

async function scoreOwnerCandidate(
  url: string,
  businessName: string,
  cityHint: string | null,
  timeoutMs: number,
): Promise<number> {
  const base = 0.62;
  const classified = classifyWebsiteUrl(url);
  if (!classified || classified.urlClass !== 'owner') return 0;

  const tokens = tokenizeBusinessName(businessName);
  if (tokens.length === 0) return base;

  const fetchResult = await fetchHtmlWithTimeout(classified.displayUrl, timeoutMs);
  if (!fetchResult.ok || fetchResult.html.trim().length < 80) {
    return base - 0.08;
  }

  const hay = normalizeMatchHaystack(
    `${fetchResult.finalUrl} ${fetchResult.html.slice(0, 12_000)}`,
  );
  const cityTokens = cityHint
    ? tokenizeBusinessName(cityHint.split(',')[0] ?? cityHint)
    : [];

  let hits = 0;
  for (const t of tokens) {
    if (hay.includes(t)) hits += 1;
  }
  for (const t of cityTokens) {
    if (hay.includes(t)) hits += 0.5;
  }

  const ratio = hits / Math.max(tokens.length, 1);
  if (ratio >= 0.45) return Math.min(0.96, base + 0.28);
  if (ratio >= 0.2) return Math.min(0.88, base + 0.12);
  return base;
}

function recordAttempt(
  attempts: WebsiteResolutionAttempt[],
  layer: string,
  url: string | null,
  outcome: WebsiteResolutionAttempt['outcome'],
  note?: string,
): void {
  attempts.push({ layer, url, outcome, ...(note !== undefined ? { note } : {}) });
}

function toOwnerResolved(c: CandidateOwner): ResolvedWebsite {
  return {
    displayUrl: c.displayUrl,
    normalizedUrl: c.normalizedUrl,
    source:
      c.source === 'places_requery' || c.source === 'web_search'
        ? 'organic_deep_search'
        : 'maps_link',
  };
}

function buildResult(
  status: WebsitePresenceStatus,
  owner: CandidateOwner | null,
  presence: CandidatePresence | null,
  mapsListingWebsite: string | null,
  attempts: WebsiteResolutionAttempt[],
): WebsiteResolutionResult {
  if (status === 'owner_site' && owner) {
    return {
      ownerSite: toOwnerResolved(owner),
      resolution: {
        status: 'owner_site',
        confidence: owner.confidence,
        url: owner.displayUrl,
        displayUrl: owner.displayUrl,
        normalizedUrl: owner.normalizedUrl,
        source: owner.source,
        mapsListingWebsite,
        presencePlatform: null,
        attempts,
      },
    };
  }

  if (status === 'presence_only' && presence) {
    return {
      ownerSite: null,
      resolution: {
        status: 'presence_only',
        confidence: 0.78,
        url: presence.displayUrl,
        displayUrl: presence.displayUrl,
        normalizedUrl: presence.normalizedUrl,
        source: presence.source,
        mapsListingWebsite,
        presencePlatform: presence.platformLabel,
        attempts,
      },
    };
  }

  return {
    ownerSite: null,
    resolution: {
      status: 'none',
      confidence: 0,
      url: null,
      displayUrl: null,
      normalizedUrl: null,
      source: null,
      mapsListingWebsite,
      presencePlatform: null,
      attempts,
    },
  };
}

function ingestClassifiedUrl(
  raw: string,
  layer: string,
  source: WebsiteResolutionSource,
  attempts: WebsiteResolutionAttempt[],
  ownerCandidates: CandidateOwner[],
  presenceCandidates: CandidatePresence[],
  ownerConfidence: number,
): void {
  const classified = classifyWebsiteUrl(raw);
  if (!classified) {
    recordAttempt(attempts, layer, raw, 'invalid');
    return;
  }
  if (classified.urlClass === 'owner') {
    ownerCandidates.push({
      displayUrl: classified.displayUrl,
      normalizedUrl: classified.normalizedUrl,
      source,
      confidence: ownerConfidence,
      layer,
    });
    recordAttempt(attempts, layer, classified.displayUrl, 'owner_site');
    return;
  }
  presenceCandidates.push({
    displayUrl: classified.displayUrl,
    normalizedUrl: classified.normalizedUrl,
    platformLabel: classified.platformLabel,
    source: source === 'maps_link' ? 'presence_taxonomy' : source,
    layer,
  });
  recordAttempt(attempts, layer, classified.displayUrl, 'presence_only');
}

/** Requête web sans guillemets (Brave renvoie bad_results avec phrase exacte). */
function buildWebSearchQuery(businessName: string, searchLocation: string | null): string {
  const name = businessName.trim();
  if (!name) return '';
  const loc = searchLocation?.trim() ?? '';
  const city = loc.split(',')[0]?.trim() ?? loc;
  return [name, city].filter((part) => part.length > 0).join(' ').trim();
}

/**
 * Cascade de résolution web : Maps → Place Details → Places requery → Brave Search → validation HTTP.
 * Priorité finale : owner_site > presence_only > none.
 */
export async function resolveProspectWebsitePresence(args: {
  readonly serp: SerpLocalResult;
  readonly serpClient: SerpClient;
  readonly webSearchClient: WebSearchClient | null;
  readonly searchLocation: string | null;
  readonly hl: string | undefined;
  readonly gl: string | undefined;
  readonly opts: ResolveProspectWebsiteOptions;
}): Promise<WebsiteResolutionResult> {
  const { serp, serpClient, webSearchClient, searchLocation, hl, gl, opts } = args;
  const attempts: WebsiteResolutionAttempt[] = [];
  const ownerCandidates: CandidateOwner[] = [];
  const presenceCandidates: CandidatePresence[] = [];
  const mapsListingWebsite = serp.website?.trim() || null;
  const placeId = serp.place_id?.trim() || null;

  if (mapsListingWebsite) {
    ingestClassifiedUrl(
      mapsListingWebsite,
      'maps_listing',
      'maps_link',
      attempts,
      ownerCandidates,
      presenceCandidates,
      0.85,
    );
  }

  if (placeId) {
    try {
      const detailsUri = await serpClient.fetchPlaceWebsiteUri(placeId);
      if (detailsUri) {
        ingestClassifiedUrl(
          detailsUri,
          'place_details',
          'place_details',
          attempts,
          ownerCandidates,
          presenceCandidates,
          0.88,
        );
      } else {
        recordAttempt(attempts, 'place_details', null, 'skipped', 'websiteUri absent');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      recordAttempt(attempts, 'place_details', null, 'skipped', msg.slice(0, 120));
    }
  }

  const locationHint = searchLocation?.trim() ?? '';
  const deepQuery = [serp.title, locationHint].filter(Boolean).join(' ').trim();
  const gps = serp.gps_coordinates;
  const organicBias =
    gps &&
    typeof gps.latitude === 'number' &&
    typeof gps.longitude === 'number' &&
    !Number.isNaN(gps.latitude) &&
    !Number.isNaN(gps.longitude)
      ? {
          latitude: gps.latitude,
          longitude: gps.longitude,
          radiusMeters: 2500,
        }
      : {};

  if (!opts.skipExtendedSearch) {
    if (deepQuery) {
      try {
        const organic = await serpClient.searchGoogleOrganic({
          q: deepQuery,
          ...(hl !== undefined ? { hl } : {}),
          ...(gl !== undefined ? { gl } : {}),
          ...organicBias,
        });
        const hits: OrganicSerpHit[] = (organic.organic_results ?? []).map((h) => ({
          title: h.title,
          link: h.link,
          ...(h.snippet !== undefined ? { snippet: h.snippet } : {}),
          ...(h.place_id !== undefined ? { place_id: h.place_id } : {}),
        }));

        const byPlaceId = placeId !== null ? pickOrganicUrlByPlaceId(placeId, hits) : null;
        const pickedUrl = byPlaceId ?? pickBestOrganicUrlForBusiness(serp.title, hits);
        if (pickedUrl) {
          ingestClassifiedUrl(
            pickedUrl,
            'places_requery',
            'places_requery',
            attempts,
            ownerCandidates,
            presenceCandidates,
            0.72,
          );
        } else {
          recordAttempt(attempts, 'places_requery', null, 'skipped', 'aucun lien');
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        recordAttempt(attempts, 'places_requery', null, 'skipped', msg.slice(0, 120));
      }
    }

    if (webSearchClient && deepQuery) {
      try {
        const webQuery = buildWebSearchQuery(serp.title, searchLocation);
        if (!webQuery) {
          recordAttempt(attempts, 'web_search', null, 'skipped', 'requête vide');
        } else {
          const webResult = await webSearchClient.searchWeb(webQuery, {
            ...(hl !== undefined ? { hl } : {}),
            ...(gl !== undefined ? { gl } : {}),
          });
          if (webResult.error) {
            recordAttempt(
              attempts,
              'web_search',
              null,
              'skipped',
              formatWebSearchErrorNote(webResult.error),
            );
          } else {
            const pickedWeb = pickBestOrganicUrlForBusiness(serp.title, webResult.hits);
            if (pickedWeb) {
              const confidence = await scoreOwnerCandidate(
                pickedWeb,
                serp.title,
                searchLocation,
                opts.fetchTimeoutMs,
              );
              if (confidence >= 0.55) {
                const classified = classifyWebsiteUrl(pickedWeb);
                if (classified?.urlClass === 'owner') {
                  ownerCandidates.push({
                    displayUrl: classified.displayUrl,
                    normalizedUrl: classified.normalizedUrl,
                    source: 'web_search',
                    confidence,
                    layer: 'web_search',
                  });
                  recordAttempt(attempts, 'web_search', classified.displayUrl, 'owner_site');
                } else if (classified?.urlClass === 'presence') {
                  presenceCandidates.push({
                    displayUrl: classified.displayUrl,
                    normalizedUrl: classified.normalizedUrl,
                    platformLabel: classified.platformLabel,
                    source: 'web_search',
                    layer: 'web_search',
                  });
                  recordAttempt(attempts, 'web_search', classified.displayUrl, 'presence_only');
                }
              } else {
                recordAttempt(attempts, 'web_search', pickedWeb, 'invalid', 'confiance insuffisante');
              }
            } else {
              recordAttempt(attempts, 'web_search', null, 'skipped', 'aucun lien');
            }
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        recordAttempt(attempts, 'web_search', null, 'skipped', msg.slice(0, 240));
      }
    } else if (!webSearchClient) {
      recordAttempt(
        attempts,
        'web_search',
        null,
        'skipped',
        'Recherche web désactivée, clé Brave absente ou plafond run à 0',
      );
    }
  } else {
    recordAttempt(attempts, 'places_requery', null, 'skipped', 'recherche étendue désactivée');
    recordAttempt(attempts, 'web_search', null, 'skipped', 'recherche étendue désactivée');
  }

  const bestOwner = ownerCandidates.sort((a, b) => b.confidence - a.confidence)[0] ?? null;
  if (bestOwner) {
    return buildResult('owner_site', bestOwner, null, mapsListingWebsite, attempts);
  }

  const bestPresence = presenceCandidates[0] ?? null;
  if (bestPresence) {
    return buildResult('presence_only', null, bestPresence, mapsListingWebsite, attempts);
  }

  return buildResult('none', null, null, mapsListingWebsite, attempts);
}
