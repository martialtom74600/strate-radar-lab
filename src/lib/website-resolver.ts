import type { ResolvedWebsite } from './diamond.js';
import { resolveStrictFromExtendedHits } from './extended-search-resolve.js';
import type { OrganicSerpHit } from './organic-match.js';
import {
  formatWebSearchErrorNote,
  type FilteredBravePresenceHit,
  type WebSearchClient,
} from '../services/serp/web-search.types.js';
import type { SerpClient } from '../services/serp/search-client.types.js';
import type { SerpLocalResult } from '../services/serp/schemas.js';
import {
  classifyWebsiteUrl,
  isBookingPresenceClassified,
  OWNER_OVERRIDE_BOOKING_MIN_CONFIDENCE,
  pickBestPresenceCandidate,
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
  /** Désactive uniquement Brave (couche 4). Google organique tourne toujours. */
  readonly skipBraveSearch?: boolean;
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

function ingestBookingPresenceHits(
  hits: readonly {
    readonly displayUrl: string;
    readonly normalizedUrl: string;
    readonly platformLabel: string | null;
  }[],
  layer: string,
  source: WebsiteResolutionSource,
  attempts: WebsiteResolutionAttempt[],
  presenceCandidates: CandidatePresence[],
  notePrefix: string,
): void {
  const seen = new Set(presenceCandidates.map((candidate) => candidate.normalizedUrl));
  for (const hit of hits) {
    if (seen.has(hit.normalizedUrl)) continue;
    seen.add(hit.normalizedUrl);
    presenceCandidates.push({
      displayUrl: hit.displayUrl,
      normalizedUrl: hit.normalizedUrl,
      platformLabel: hit.platformLabel,
      source,
      layer,
    });
    recordAttempt(
      attempts,
      layer,
      hit.displayUrl,
      'presence_only',
      `${notePrefix} · ${hit.platformLabel ?? 'plateforme RDV'}`,
    );
  }
}

function ingestBraveFilteredPresenceHits(
  filtered: readonly FilteredBravePresenceHit[],
  attempts: WebsiteResolutionAttempt[],
  presenceCandidates: CandidatePresence[],
): void {
  const seen = new Set(presenceCandidates.map((candidate) => candidate.normalizedUrl));
  for (const row of filtered) {
    const classified = classifyWebsiteUrl(row.link);
    if (!classified) continue;
    if (seen.has(classified.normalizedUrl)) continue;
    seen.add(classified.normalizedUrl);
    presenceCandidates.push({
      displayUrl: classified.displayUrl,
      normalizedUrl: classified.normalizedUrl,
      platformLabel: classified.platformLabel,
      source: 'web_search',
      layer: 'web_search',
    });
    recordAttempt(
      attempts,
      'web_search',
      classified.displayUrl,
      'presence_only',
      `Brave · host filtré · ${classified.platformLabel ?? row.platformLabel ?? 'plateforme RDV'}`,
    );
  }
}

function mergeExtendedSearchResult(
  resolved: Awaited<ReturnType<typeof resolveStrictFromExtendedHits>>,
  layer: string,
  source: WebsiteResolutionSource,
  attempts: WebsiteResolutionAttempt[],
  ownerCandidates: CandidateOwner[],
  presenceCandidates: CandidatePresence[],
): void {
  ingestBookingPresenceHits(
    resolved.bookingPresenceHits,
    layer,
    source,
    attempts,
    presenceCandidates,
    'plateforme RDV SERP',
  );

  if (resolved.owner) {
    ownerCandidates.push({
      displayUrl: resolved.owner.displayUrl,
      normalizedUrl: resolved.owner.normalizedUrl,
      source,
      confidence: resolved.owner.confidence,
      layer,
    });
    recordAttempt(
      attempts,
      layer,
      resolved.owner.displayUrl,
      'owner_site',
      resolved.summaryNote ?? undefined,
    );
    return;
  }

  if (resolved.presence) {
    const alreadyTracked = presenceCandidates.some(
      (candidate) => candidate.normalizedUrl === resolved.presence?.normalizedUrl,
    );
    if (!alreadyTracked) {
      presenceCandidates.push({
        displayUrl: resolved.presence.displayUrl,
        normalizedUrl: resolved.presence.normalizedUrl,
        platformLabel: resolved.presence.platformLabel,
        source,
        layer,
      });
      recordAttempt(
        attempts,
        layer,
        resolved.presence.displayUrl,
        'presence_only',
        resolved.summaryNote ?? undefined,
      );
    }
    return;
  }

  recordAttempt(
    attempts,
    layer,
    null,
    'skipped',
    resolved.summaryNote ? `probe_ok · ${resolved.summaryNote}` : 'probe_ok',
  );
}

/** Diamant création autorisé seulement si la sonde Google organique a abouti. */
export function assessGoogleOrganicProbeGate(resolution: WebsiteResolution): {
  readonly allowed: boolean;
  readonly reason: string;
} {
  const attempt = resolution.attempts.find((row) => row.layer === 'places_requery');
  if (!attempt) {
    return { allowed: false, reason: 'Google organique non exécuté' };
  }
  if (attempt.outcome === 'owner_site' || attempt.outcome === 'presence_only') {
    return { allowed: true, reason: '' };
  }
  if (attempt.outcome === 'skipped' && (attempt.note?.includes('probe_ok') ?? false)) {
    return { allowed: true, reason: '' };
  }
  const note = attempt.note?.trim() ?? 'échec';
  return { allowed: false, reason: `Google organique non confirmé · ${note.slice(0, 100)}` };
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
 * Cascade de résolution web : Maps → Place Details → Google organique → Brave Search.
 * Couche 3 (Google) : toujours active. Couches 3–4 : top 6 résultats.
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

      const requeryOut = await resolveStrictFromExtendedHits({
        hits,
        businessName: serp.title,
        cityHint: searchLocation,
        placeId,
        source: 'places_requery',
        layer: 'places_requery',
        fetchTimeoutMs: opts.fetchTimeoutMs,
      });
      mergeExtendedSearchResult(
        requeryOut,
        'places_requery',
        'places_requery',
        attempts,
        ownerCandidates,
        presenceCandidates,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      recordAttempt(attempts, 'places_requery', null, 'skipped', msg.slice(0, 120));
    }
  } else {
    recordAttempt(attempts, 'places_requery', null, 'skipped', 'requête vide');
  }

  if (!opts.skipBraveSearch && webSearchClient && deepQuery) {
    try {
      const webQuery = buildWebSearchQuery(serp.title, searchLocation);
      if (!webQuery) {
        recordAttempt(attempts, 'web_search', null, 'skipped', 'requête vide');
      } else {
        const webResult = await webSearchClient.searchWeb(webQuery, {
          ...(hl !== undefined ? { hl } : {}),
          ...(gl !== undefined ? { gl } : {}),
        });
        ingestBraveFilteredPresenceHits(
          webResult.filteredPresenceHits,
          attempts,
          presenceCandidates,
        );
        if (webResult.error) {
          recordAttempt(
            attempts,
            'web_search',
            null,
            'skipped',
            formatWebSearchErrorNote(webResult.error),
          );
        } else {
          const webOut = await resolveStrictFromExtendedHits({
            hits: webResult.hits,
            businessName: serp.title,
            cityHint: searchLocation,
            placeId,
            source: 'web_search',
            layer: 'web_search',
            fetchTimeoutMs: opts.fetchTimeoutMs,
          });
          mergeExtendedSearchResult(
            webOut,
            'web_search',
            'web_search',
            attempts,
            ownerCandidates,
            presenceCandidates,
          );
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      recordAttempt(attempts, 'web_search', null, 'skipped', msg.slice(0, 240));
    }
  } else if (opts.skipBraveSearch) {
    recordAttempt(attempts, 'web_search', null, 'skipped', 'Brave désactivé pour cette fiche');
  } else if (!webSearchClient) {
    recordAttempt(
      attempts,
      'web_search',
      null,
      'skipped',
      'Recherche web désactivée, clé Brave absente ou plafond run à 0',
    );
  }

  const bestOwner = ownerCandidates.sort((a, b) => b.confidence - a.confidence)[0] ?? null;
  const bestPresence = pickBestPresenceCandidate(presenceCandidates);
  const hasBookingPresence = presenceCandidates.some((candidate) =>
    isBookingPresenceClassified(classifyWebsiteUrl(candidate.displayUrl)),
  );

  if (bestOwner) {
    const authoritative =
      bestOwner.source === 'maps_link' || bestOwner.source === 'place_details';
    if (
      !authoritative &&
      hasBookingPresence &&
      bestOwner.confidence < OWNER_OVERRIDE_BOOKING_MIN_CONFIDENCE &&
      bestPresence
    ) {
      return buildResult('presence_only', null, bestPresence, mapsListingWebsite, attempts);
    }
    return buildResult('owner_site', bestOwner, null, mapsListingWebsite, attempts);
  }

  if (bestPresence) {
    return buildResult('presence_only', null, bestPresence, mapsListingWebsite, attempts);
  }

  return buildResult('none', null, null, mapsListingWebsite, attempts);
}
