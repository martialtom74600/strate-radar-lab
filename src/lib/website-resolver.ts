import type { AppConfig } from '../config/index.js';
import {
  buildSerpClassifierAuditRecord,
  logSerpClassifierAudit,
  logSerpClassifierFailure,
  type SerpClassifierAuditRecord,
} from './ai/serp-classifier-audit-log.js';
import {
  classifySerpUrlsDetailed,
  presencePlatformFromUrl,
  type SerpClassifierDetailedResult,
} from './ai/serp-classifier.js';
import type { ResolvedWebsite } from './diamond.js';
import type { OrganicSerpHit } from './organic-serp-hit.js';
import { buildOwnerDiscoveryQuery, resolveProspectCity } from './search-location-hint.js';
import {
  formatWebSearchErrorNote,
  type WebSearchClient,
} from '../services/serp/web-search.types.js';
import type { SerpClient } from '../services/serp/search-client.types.js';
import type { SerpLocalResult } from '../services/serp/schemas.js';
import { normalizeProspectUrl, toAbsoluteHttpUrl } from './url.js';
import { parseOwnerWebsiteUrl, type WebsitePresenceStatus } from './website-presence-types.js';

export type WebsiteResolutionSource =
  | 'maps_link'
  | 'place_details'
  | 'places_requery'
  | 'web_search'
  | 'serp_classifier';

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
  readonly classificationReason: string | null;
  readonly classifierAudit: SerpClassifierAuditRecord | null;
  readonly attempts: readonly WebsiteResolutionAttempt[];
};

type WebsiteResolutionResult = {
  readonly resolution: WebsiteResolution;
  /** Site propriétaire exploitable (matrice / refonte) — null si presence_only ou none. */
  readonly ownerSite: ResolvedWebsite | null;
};

type ResolveProspectWebsiteOptions = {
  readonly fetchTimeoutMs: number;
};

type ResolveProspectWebsitePresenceArgs = {
  readonly config: AppConfig;
  readonly serp: SerpLocalResult;
  readonly serpClient: SerpClient;
  readonly webSearchClient: WebSearchClient | null;
  readonly searchLocation: string | null;
  readonly hl: string | undefined;
  readonly gl: string | undefined;
  readonly opts: ResolveProspectWebsiteOptions;
  /** Préfixe des lignes `[serp-classifier]` (ex. `[SCRUB] `). */
  readonly logPrefix?: string;
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

function pushUniqueUrl(bucket: string[], raw: string | null | undefined): void {
  const trimmed = raw?.trim();
  if (!trimmed || bucket.length >= 7) return;
  if (bucket.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) return;
  if (!toAbsoluteHttpUrl(trimmed)) return;
  bucket.push(trimmed);
}

function organicHitsFromSerpRows(
  rows: readonly { readonly title: string; readonly link: string; readonly snippet?: string }[],
): OrganicSerpHit[] {
  return rows.map((row) => ({
    title: row.title,
    link: row.link,
    ...(row.snippet !== undefined ? { snippet: row.snippet } : {}),
  }));
}

function buildResultFromClassification(args: {
  readonly classification: SerpClassifierDetailedResult['result'];
  readonly classifierAudit: SerpClassifierAuditRecord | null;
  readonly mapsListingWebsite: string | null;
  readonly attempts: WebsiteResolutionAttempt[];
  readonly source: WebsiteResolutionSource;
}): WebsiteResolutionResult {
  const { classification, classifierAudit, mapsListingWebsite, attempts, source } = args;
  const matched = classification.matchedUrl;
  const parsed = matched ? parseOwnerWebsiteUrl(matched) : null;

  if (classification.status === 'owner_site' && parsed) {
    return {
      ownerSite: {
        displayUrl: parsed.displayUrl,
        normalizedUrl: parsed.normalizedUrl,
        source: source === 'places_requery' || source === 'web_search' ? 'organic_deep_search' : 'maps_link',
      },
      resolution: {
        status: 'owner_site',
        confidence: classification.confidence,
        url: parsed.displayUrl,
        displayUrl: parsed.displayUrl,
        normalizedUrl: parsed.normalizedUrl,
        source,
        mapsListingWebsite,
        presencePlatform: null,
        classificationReason: classification.reason,
        classifierAudit,
        attempts,
      },
    };
  }

  if (classification.status === 'presence_only' && parsed) {
    return {
      ownerSite: null,
      resolution: {
        status: 'presence_only',
        confidence: classification.confidence,
        url: parsed.displayUrl,
        displayUrl: parsed.displayUrl,
        normalizedUrl: parsed.normalizedUrl,
        source,
        mapsListingWebsite,
        presencePlatform: presencePlatformFromUrl(parsed.displayUrl),
        classificationReason: classification.reason,
        classifierAudit,
        attempts,
      },
    };
  }

  if (classification.status === 'presence_only') {
    return {
      ownerSite: null,
      resolution: {
        status: 'presence_only',
        confidence: classification.confidence,
        url: null,
        displayUrl: null,
        normalizedUrl: null,
        source,
        mapsListingWebsite,
        presencePlatform: null,
        classificationReason: classification.reason,
        classifierAudit,
        attempts,
      },
    };
  }

  if (classification.status === 'owner_site') {
    return {
      ownerSite: null,
      resolution: {
        status: 'owner_site',
        confidence: classification.confidence,
        url: null,
        displayUrl: null,
        normalizedUrl: null,
        source,
        mapsListingWebsite,
        presencePlatform: null,
        classificationReason: classification.reason,
        classifierAudit,
        attempts,
      },
    };
  }

  return {
    ownerSite: null,
    resolution: {
      status: 'none',
      confidence: classification.confidence,
      url: null,
      displayUrl: null,
      normalizedUrl: null,
      source: null,
      mapsListingWebsite,
      presencePlatform: null,
      classificationReason: classification.reason,
      classifierAudit,
      attempts,
    },
  };
}

function summarizeCascadeForAudit(attempts: readonly WebsiteResolutionAttempt[]): string {
  return attempts
    .filter((row) => row.layer !== 'serp_classifier')
    .map((row) => `${row.layer}=${row.outcome}${row.note ? `(${row.note.slice(0, 40)})` : ''}`)
    .join(' · ');
}

function emitClassifierAuditLog(args: {
  readonly config: AppConfig;
  readonly businessName: string;
  readonly city: string | null;
  readonly audit: SerpClassifierAuditRecord;
  readonly logTag: string;
  readonly attempts: readonly WebsiteResolutionAttempt[];
}): void {
  if (!args.config.RADAR_VERBOSE) return;
  logSerpClassifierAudit({
    logPrefix: args.logTag,
    businessName: args.businessName,
    city: args.city,
    audit: args.audit,
    cascadeNote: summarizeCascadeForAudit(args.attempts),
  });
}

function buildWebSearchQuery(businessName: string, searchLocation: string | null): string {
  return buildOwnerDiscoveryQuery(businessName, searchLocation, '');
}

/**
 * Cascade de résolution web : collecte URLs (Maps, Details, Google, Brave) → classifieur IA.
 */
export async function resolveProspectWebsitePresence(
  args: ResolveProspectWebsitePresenceArgs,
): Promise<WebsiteResolutionResult> {
  const { config, serp, serpClient, webSearchClient, searchLocation, hl, gl, opts } = args;
  const logTag = args.logPrefix ?? '[radar] ';
  const attempts: WebsiteResolutionAttempt[] = [];
  const urlBucket: string[] = [];
  const mapsListingWebsite = serp.website?.trim() || null;
  const placeId = serp.place_id?.trim() || null;
  const prospectCity = resolveProspectCity(serp, searchLocation);

  pushUniqueUrl(urlBucket, mapsListingWebsite);
  if (mapsListingWebsite) {
    recordAttempt(attempts, 'maps_listing', mapsListingWebsite, 'skipped', 'URL transmise au classifieur IA');
  }

  if (placeId) {
    try {
      const detailsUri = await serpClient.fetchPlaceWebsiteUri(placeId);
      if (detailsUri) {
        pushUniqueUrl(urlBucket, detailsUri);
        recordAttempt(attempts, 'place_details', detailsUri, 'skipped', 'URL transmise au classifieur IA');
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

  let classifierSource: WebsiteResolutionSource = 'serp_classifier';
  let organicProbeIndex = -1;

  if (deepQuery) {
    try {
      const organic = await serpClient.searchGoogleOrganic({
        q: deepQuery,
        ...(hl !== undefined ? { hl } : {}),
        ...(gl !== undefined ? { gl } : {}),
        ...organicBias,
      });
      const hits = organicHitsFromSerpRows(organic.organic_results ?? []);
      for (const hit of hits) {
        pushUniqueUrl(urlBucket, hit.link);
      }
      recordAttempt(
        attempts,
        'places_requery',
        null,
        'none',
        `${hits.length} hit(s) organique(s) collecté(s)`,
      );
      organicProbeIndex = attempts.length - 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      recordAttempt(attempts, 'places_requery', null, 'skipped', msg.slice(0, 120));
    }
  } else {
    recordAttempt(attempts, 'places_requery', null, 'skipped', 'requête vide');
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
          for (const hit of webResult.hits) {
            pushUniqueUrl(urlBucket, hit.link);
          }
          classifierSource = 'web_search';
          recordAttempt(
            attempts,
            'web_search',
            null,
            'skipped',
            `${webResult.hits.length} hit(s) Brave → classifieur IA`,
          );
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

  const urlsForClassifier = urlBucket.slice(0, 7);
  const urlsDropped = urlBucket.slice(7);

  if (urlsForClassifier.length === 0) {
    recordAttempt(attempts, 'serp_classifier', null, 'none', 'Aucune URL collectée');
    if (config.RADAR_VERBOSE) {
      logSerpClassifierFailure({
        logPrefix: logTag,
        businessName: serp.title,
        city: prospectCity,
        urlsSent: [],
        error: 'Aucune URL collectée pour ce commerce.',
      });
    }
    return buildResultFromClassification({
      classification: {
        status: 'none',
        confidence: 0,
        reason: 'Aucune URL collectée pour ce commerce.',
        matchedUrl: null,
      },
      classifierAudit: null,
      mapsListingWebsite,
      attempts,
      source: classifierSource,
    });
  }

  let detailed: SerpClassifierDetailedResult;
  try {
    detailed = await classifySerpUrlsDetailed({
      config,
      companyName: serp.title,
      city: prospectCity,
      urls: urlsForClassifier,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    recordAttempt(attempts, 'serp_classifier', null, 'skipped', msg.slice(0, 200));
    if (config.RADAR_VERBOSE) {
      logSerpClassifierFailure({
        logPrefix: logTag,
        businessName: serp.title,
        city: prospectCity,
        urlsSent: urlsForClassifier,
        error: msg,
      });
    }
    return buildResultFromClassification({
      classification: {
        status: 'none',
        confidence: 0,
        reason: msg.slice(0, 240),
        matchedUrl: null,
      },
      classifierAudit: null,
      mapsListingWebsite,
      attempts,
      source: classifierSource,
    });
  }

  const classification = detailed.result;
  const classifierAudit: SerpClassifierAuditRecord = {
    ...buildSerpClassifierAuditRecord(detailed),
    urlsDropped: urlsDropped.length > 0 ? urlsDropped : [...detailed.trace.urlsDropped],
  };

  recordAttempt(
    attempts,
    'serp_classifier',
    classification.matchedUrl,
    classification.status,
    classification.reason,
  );

  emitClassifierAuditLog({
    config,
    businessName: serp.title,
    city: prospectCity,
    audit: classifierAudit,
    logTag,
    attempts,
  });

  if (organicProbeIndex >= 0) {
    attempts[organicProbeIndex] = {
      layer: 'places_requery',
      url: classification.matchedUrl,
      outcome: classification.status,
      note: classification.reason,
    };
  }

  const source =
    classification.status === 'owner_site' && mapsListingWebsite &&
    classification.matchedUrl &&
    normalizeProspectUrl(classification.matchedUrl) === normalizeProspectUrl(mapsListingWebsite)
      ? 'maps_link'
      : classifierSource === 'web_search'
        ? 'web_search'
        : organicProbeIndex >= 0
          ? 'places_requery'
          : mapsListingWebsite
            ? 'maps_link'
            : 'serp_classifier';

  return buildResultFromClassification({
    classification,
    classifierAudit,
    mapsListingWebsite,
    attempts,
    source,
  });
}
