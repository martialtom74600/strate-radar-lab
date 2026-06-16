import type { AppConfig } from '../config/index.js';
import {
  buildSerpClassifierAuditRecord,
  logSerpClassifierAudit,
  logSerpClassifierFailure,
  type SerpClassifierAuditRecord,
} from './ai/serp-classifier-audit-log.js';
import {
  classifySerpUrlsDetailed,
  SERP_CLASSIFIER_MAX_URLS,
  presencePlatformFromUrl,
  type SerpClassifierDetailedResult,
} from './ai/serp-classifier.js';
import { scanTop5CandidatesDetailed, type Top5WebDiscoveryContext } from './ai/top5-scanner.js';
import type { ResolvedWebsite } from './diamond.js';
import type { OrganicSerpHit } from './organic-serp-hit.js';
import {
  buildOwnerDiscoveryQuery,
  cityHintFromSearchLocation,
  resolveProspectCity,
} from './search-location-hint.js';
import {
  formatWebSearchErrorNote,
  type WebSearchClient,
} from '../services/serp/web-search.types.js';
import type { SerpClient } from '../services/serp/search-client.types.js';
import type { SerpLocalResult } from '../services/serp/schemas.js';
import { normalizeProspectUrl, toAbsoluteHttpUrl } from './url.js';
import { parseOwnerWebsiteUrl, type WebsitePresenceStatus } from './website-presence-types.js';
import { isDedicatedOwnerUrl } from './host-presence.js';

export type WebsiteResolutionSource =
  | 'maps_link'
  | 'place_details'
  | 'places_requery'
  | 'web_search'
  | 'serp_classifier'
  | 'top5_scanner';

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

/** Capacité du collecteur URL avant le Top 5 / classifieur (Maps + web + Places). */
const URL_COLLECTOR_BUCKET_MAX = 12;

function pushUniqueUrl(bucket: string[], raw: string | null | undefined): void {
  const trimmed = raw?.trim();
  if (!trimmed || bucket.length >= URL_COLLECTOR_BUCKET_MAX) return;
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

  if (classification.status === 'corporate_parent' && parsed) {
    return {
      ownerSite: null,
      resolution: {
        status: 'corporate_parent',
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

  if (classification.status === 'needs_review') {
    const reviewUrl = parsed?.displayUrl ?? matched ?? null;
    return {
      ownerSite: null,
      resolution: {
        status: 'needs_review',
        confidence: classification.confidence,
        url: reviewUrl,
        displayUrl: reviewUrl,
        normalizedUrl: reviewUrl ? parseOwnerWebsiteUrl(reviewUrl)?.normalizedUrl ?? null : null,
        source,
        mapsListingWebsite,
        presencePlatform: reviewUrl ? presencePlatformFromUrl(reviewUrl) : null,
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

  if (classification.status === 'corporate_parent') {
    return {
      ownerSite: null,
      resolution: {
        status: 'corporate_parent',
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
    .filter((row) => row.layer !== 'serp_classifier' && row.layer !== 'top5_scanner')
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

function buildWebSearchQuery(
  businessName: string,
  prospectCity: string | null,
  searchLocation: string | null,
  fallbackLocation: string,
): string {
  return buildOwnerDiscoveryQuery(
    businessName,
    prospectCity ?? searchLocation,
    fallbackLocation,
  );
}

async function runOwnerDiscoveryWebSearch(args: {
  readonly config: AppConfig;
  readonly serp: SerpLocalResult;
  readonly webSearchClient: WebSearchClient | null;
  readonly searchLocation: string | null;
  readonly prospectCity: string | null;
  readonly hl: string | undefined;
  readonly gl: string | undefined;
  readonly urlBucket: string[];
  readonly attempts: WebsiteResolutionAttempt[];
}): Promise<{ readonly context: Top5WebDiscoveryContext; readonly sourceSet: boolean }> {
  const discoveryQuery = buildWebSearchQuery(
    args.serp.title,
    args.prospectCity,
    args.searchLocation,
    args.config.RADAR_SEARCH_LOCATION,
  );
  const serpLocation = args.prospectCity
    ? `${args.prospectCity}, France`
    : cityHintFromSearchLocation(args.searchLocation, args.config.RADAR_SEARCH_LOCATION);

  if (!args.webSearchClient || !discoveryQuery) {
    const reason = !args.webSearchClient
      ? 'Recherche web désactivée, clé Serper/Brave absente ou plafond run à 0'
      : 'requête vide';
    recordAttempt(args.attempts, 'web_search', null, 'skipped', reason);
    return {
      context: { attempted: false, ok: false, hits: 0, error: reason },
      sourceSet: false,
    };
  }

  try {
    const searchOpts = {
      ...(args.hl !== undefined ? { hl: args.hl } : {}),
      ...(args.gl !== undefined ? { gl: args.gl } : {}),
      location: serpLocation,
    };

    const runQuery = async (query: string) => args.webSearchClient!.searchWeb(query, searchOpts);

    const webResult = await runQuery(discoveryQuery);
    if (webResult.error) {
      const note = formatWebSearchErrorNote(webResult.error);
      recordAttempt(args.attempts, 'web_search', null, 'skipped', note);
      return {
        context: { attempted: true, ok: false, hits: 0, error: note },
        sourceSet: false,
      };
    }

    let totalHits = 0;
    let dedicatedHits = 0;
    const ingestHits = (hits: readonly { readonly link: string }[]) => {
      const dedicated = hits.filter((hit) => isDedicatedOwnerUrl(hit.link));
      const platforms = hits.filter((hit) => !isDedicatedOwnerUrl(hit.link));
      for (const hit of [...dedicated, ...platforms]) {
        totalHits += 1;
        if (isDedicatedOwnerUrl(hit.link)) dedicatedHits += 1;
        pushUniqueUrl(args.urlBucket, hit.link);
      }
    };

    ingestHits(webResult.hits);

    let queryNote = `${webResult.hits.length} hit(s) · q=${discoveryQuery.slice(0, 72)}`;

    if (dedicatedHits === 0) {
      const fallbackQuery = `${discoveryQuery} site`.trim();
      const fallback = await runQuery(fallbackQuery);
      if (!fallback.error && fallback.hits.length > 0) {
        const beforeDedicated = dedicatedHits;
        ingestHits(fallback.hits);
        if (dedicatedHits > beforeDedicated) {
          queryNote += ` · fallback site +${fallback.hits.length} hit(s)`;
        }
      }
    }

    recordAttempt(args.attempts, 'web_search', null, 'skipped', queryNote);
    return {
      context: {
        attempted: true,
        ok: true,
        hits: totalHits,
        error: null,
      },
      sourceSet: totalHits > 0,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    recordAttempt(args.attempts, 'web_search', null, 'skipped', msg.slice(0, 240));
    return {
      context: { attempted: true, ok: false, hits: 0, error: msg.slice(0, 200) },
      sourceSet: false,
    };
  }
}

/**
 * Cascade de résolution web : collecte URLs (Maps, Details, SERP) → routage structurel puis Groq si domaine dédié.
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
  const priorityUrls: string[] = [];
  let placeDetailsUri: string | null = null;

  pushUniqueUrl(urlBucket, mapsListingWebsite);
  if (mapsListingWebsite) {
    priorityUrls.push(mapsListingWebsite);
    recordAttempt(attempts, 'maps_listing', mapsListingWebsite, 'skipped', 'URL transmise au classifieur');
  }

  if (placeId) {
    try {
      const detailsUri = await serpClient.fetchPlaceWebsiteUri(placeId);
      if (detailsUri) {
        placeDetailsUri = detailsUri;
        pushUniqueUrl(urlBucket, detailsUri);
        if (!priorityUrls.some((u) => u.toLowerCase() === detailsUri.toLowerCase())) {
          priorityUrls.push(detailsUri);
        }
        recordAttempt(attempts, 'place_details', detailsUri, 'skipped', 'URL transmise au classifieur');
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

  let classifierSource: WebsiteResolutionSource = config.RADAR_TOP5_SCANNER
    ? 'top5_scanner'
    : 'serp_classifier';
  let organicProbeIndex = -1;
  let webDiscovery: Top5WebDiscoveryContext = {
    attempted: false,
    ok: false,
    hits: 0,
    error: null,
  };

  if (config.RADAR_TOP5_SCANNER) {
    const webOut = await runOwnerDiscoveryWebSearch({
      config,
      serp,
      webSearchClient,
      searchLocation,
      prospectCity,
      hl,
      gl,
      urlBucket,
      attempts,
    });
    webDiscovery = webOut.context;
    if (webOut.sourceSet) {
      classifierSource = 'web_search';
    }
  }

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

  if (!config.RADAR_TOP5_SCANNER) {
    const webOut = await runOwnerDiscoveryWebSearch({
      config,
      serp,
      webSearchClient,
      searchLocation,
      prospectCity,
      hl,
      gl,
      urlBucket,
      attempts,
    });
    webDiscovery = webOut.context;
    if (webOut.sourceSet) {
      classifierSource = 'web_search';
    }
  }

  const urlsForClassifier = urlBucket.slice(0, SERP_CLASSIFIER_MAX_URLS);
  const urlsDropped = urlBucket.slice(SERP_CLASSIFIER_MAX_URLS);

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
        status: 'needs_review',
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
  const classifierLayer = config.RADAR_TOP5_SCANNER ? 'top5_scanner' : 'serp_classifier';
  try {
    detailed = config.RADAR_TOP5_SCANNER
      ? await scanTop5CandidatesDetailed({
          config,
          companyName: serp.title,
          city: prospectCity,
          urlsCollected: urlBucket,
          priorityUrls,
          discovery: webDiscovery,
        })
      : await classifySerpUrlsDetailed({
          config,
          companyName: serp.title,
          city: prospectCity,
          urls: urlBucket,
        });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    recordAttempt(attempts, classifierLayer, null, 'skipped', msg.slice(0, 200));
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
        status: 'needs_review',
        confidence: 0,
        reason: `[quarantaine] Erreur classifieur : ${msg.slice(0, 220)}`,
        matchedUrl: urlsForClassifier[0] ?? null,
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
    classifierLayer,
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
      : classification.status === 'owner_site' && placeDetailsUri &&
          classification.matchedUrl &&
          normalizeProspectUrl(classification.matchedUrl) === normalizeProspectUrl(placeDetailsUri)
        ? 'place_details'
      : classifierSource === 'web_search'
        ? 'web_search'
        : organicProbeIndex >= 0
          ? 'places_requery'
          : mapsListingWebsite
            ? 'maps_link'
            : classifierSource;

  return buildResultFromClassification({
    classification,
    classifierAudit,
    mapsListingWebsite,
    attempts,
    source,
  });
}
