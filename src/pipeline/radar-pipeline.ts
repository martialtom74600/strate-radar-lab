import type { AppConfig } from '../config/index.js';
import {
  buildSeedSearchQuery,
  DIAMOND_SEED_CATEGORIES,
} from '../config/categories.js';
import {
  type DiamondPainType,
} from '../lib/diamond.js';
import { StrateRadarError } from '../lib/errors.js';
import {
  fetchHtmlWithTimeout,
  qualifiesDiamantCreation,
  qualifiesDiamantPresence,
  runStrateMatrixScore,
  STRATE_DIAMOND_THRESHOLD,
  STRATE_DIAMANT_CREATION_SCORE,
  type StrateScoreResult,
} from '../lib/strate-scorer.js';
import {
  assessCommercialProspect,
  collectGatekeeperTypes,
} from '../lib/gatekeeper.js';
import { extractLighthouseScoresPercent } from '../lib/lighthouse.js';
import { stablePlaceKey } from '../lib/place-key.js';
import { extractCityLabelForReport } from '../lib/report-city.js';
import { formatIsoWeekBucket } from '../lib/week.js';
import {
  resolveProspectWebsitePresence,
  type WebsiteResolution,
} from '../lib/website-resolver.js';
import { createBraveSearchWebClient, describeWebSearchBoot } from '../services/serp/brave-search.client.js';
import { wrapWebSearchClientWithBudget, WEB_SEARCH_BUDGET_EXHAUSTED_REASON } from '../services/serp/web-search-budget.js';
import {
  catchLocalSearchIntentions,
  padTrendQueries,
} from '../lib/trend-catcher.js';
import { createGroqClient, type GroqClient } from '../services/groq/index.js';
import { createPageSpeedClient, type PageSpeedClient } from '../services/pagespeed/index.js';
import type { PageSpeedInsightsV5 } from '../services/pagespeed/schemas.js';
import {
  createRadarSearchClient,
} from '../lib/google-places.client.js';
import {
  fetchCompanyLegalDataForProspect,
  type CompanyRegistryLegalData,
} from '../services/company-registry.js';
import {
  wrapSerpClientWithBudget,
  type GoogleLocalSearchParams,
  type SerpClient,
} from '../services/serp/index.js';
import type { SerpLocalResult } from '../services/serp/schemas.js';
import {
  applyCampaignSaturationIfNeeded,
  resolveNextCampaignPair,
} from '../lib/campaign-manager.js';
import {
  CampaignRepository,
  closeDatabase,
  migrateCampaignTables,
  migrateDiamondRescanGuard,
  migrateProspectsTable,
  migrateRadarPlaceLastOutcome,
  migrateRadarWeekPlaceOutcome,
  openDatabase,
  ProspectRepository,
  type WebsiteSource,
} from '../storage/database.js';
import {
  pickBestPlacesMatch,
  type TargetProspectSpec,
} from '../lib/targeted-prospect.js';
import {
  fetchNearbyWebsiteCompetitorsForDiamond,
  type RadarNearbyCompetitor,
} from '../lib/nearby-competitors.js';

export type { TargetProspectSpec } from '../lib/targeted-prospect.js';

/** Pas d’offset numérique : Places Text Search pagine via nextPageToken (pageSize 20). */

function truncateTitle(title: string, max = 56): string {
  const t = title.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function radarVerbose(config: AppConfig, msg: string): void {
  if (config.RADAR_VERBOSE) console.log(msg);
}

export type RadarSearchParams = {
  readonly q: string;
  readonly location?: string;
  readonly hl?: string;
  readonly gl?: string;
};

/** Succès pipeline : refonte, création (aucune présence), présence tierce (Doctolib…). */
export type ConversionBadge = 'DIAMANT_REFONTE' | 'DIAMANT_CREATION' | 'DIAMANT_PRESENCE';

export type PipelineStrateScore = {
  readonly total: number;
  /** True si pas de matrice (chemin création — score symbolique 100). */
  readonly isDiamantCreation: boolean;
  readonly matrix: StrateScoreResult | null;
};

export type GatekeeperExclusion = {
  readonly name: string;
  readonly reason: string;
};

export type RadarPipelineLine = {
  readonly serp: SerpLocalResult;
  readonly normalizedUrl: string | null;
  readonly displayUrl: string | null;
  readonly websiteSource?: WebsiteSource;
  readonly seedCategory?: string;
  /** Requête d’intention (Trend Catcher / grainage + ville) ayant mené à cette fiche. */
  readonly trendingQuery: string;
  readonly conversionBadge?: ConversionBadge;
  readonly diamondPain?: DiamondPainType;
  readonly strateScore?: PipelineStrateScore;
  readonly weekBucket: string;
  readonly fromCache: boolean;
  readonly psiStrategy: 'mobile';
  readonly pageSpeed: PageSpeedInsightsV5 | null;
  /** Concurrents à proximité (Nearby Places, site web Maps) pour effet FOMO ; absent si non applicable. */
  readonly nearbyCompetitors?: readonly RadarNearbyCompetitor[];
  /**
   * Données registre officielles (État via `annuaire-entreprises` / recherche ouverte).
   * Renseignée pour les passes `DIAMANT_*` après Gatekeeper lorsque la requête retourne un match fiable ;
   * `null` sinon (aucune invention).
   */
  readonly legalData?: CompanyRegistryLegalData | null;
  readonly websiteResolution?: WebsiteResolution;
};

export type LeadQuotaState = {
  creationsFound: number;
  refontesFound: number;
  targetCreation: number;
  targetRefonte: number;
};

function leadQuotasSatisfied(q: LeadQuotaState): boolean {
  return q.creationsFound >= q.targetCreation && q.refontesFound >= q.targetRefonte;
}

export type RadarPipelineResult = {
  readonly lines: readonly RadarPipelineLine[];
  readonly weekBucket: string;
  readonly search: RadarSearchParams;
  readonly generatedAtIso: string;
  readonly targetCreationCount: number;
  readonly targetRefonteCount: number;
  readonly creationsFound: number;
  readonly refontesFound: number;
  readonly totalBusinessesScanned: number;
  readonly placesRequestsUsed: number;
  readonly placesRequestsMax: number;
  readonly webSearchRequestsUsed: number;
  readonly webSearchRequestsMax: number;
  /** Client Brave instancié (clé + plafond > 0 + RADAR_WEB_SEARCH_ENABLED). */
  readonly webSearchConfigured: boolean;
  readonly webSearchBootStatus: string;
  readonly reportCityDisplayName: string;
  readonly seedCategoriesResolved: readonly string[];
  readonly multiCategoryMode: boolean;
  /** True si les intentions viennent du Trend Catcher (Suggest). */
  readonly demandDrivenMode: boolean;
  /** Liste des requêtes « q » effectivement utilisées pour ce run (ordre de parcours). */
  readonly trendQueriesResolved: readonly string[];
  /** Arrêt anticipé Places API (ex. HTTP 429 quota) — le run se termine avec les résultats partiels. */
  readonly placesStoppedEarly: boolean;
  readonly placesStopMessage?: string;
  readonly placesBudgetExhausted: boolean;
  /** Mode audit ciblé (nom précis) — pas de prospection trend / grainage. */
  readonly targetedMode: boolean;
  readonly targetProspectMisses?: readonly string[];
  /** Fiches écartées par le Gatekeeper IA (non-commercial / institutionnel). */
  readonly gatekeeperExclusions: readonly GatekeeperExclusion[];
  /** Run en mode campagne autonome (matrice ville × métier). */
  readonly campaign?: { readonly city: string; readonly category: string };
};

export type RunRadarPipelineOptions = {
  readonly config: AppConfig;
  readonly search: RadarSearchParams;
  /** Surcharges (tests) — sinon `config.RADAR_TARGET_*`. */
  readonly targetCreationCount?: number;
  readonly targetRefonteCount?: number;
  readonly seedCategories?: readonly string[];
  /** Audit d’un commerce précis (Google Places) — ignore trend / grainage / campagne. */
  readonly targetProspect?: TargetProspectSpec;
  /** Ignore le cache SQLite « déjà vu » (défaut true si targetProspect). */
  readonly forceRescan?: boolean;
};

type ProcessLocalContext = {
  readonly config: AppConfig;
  readonly serp: SerpLocalResult;
  readonly weekBucket: string;
  readonly recentDays: number;
  readonly repo: ProspectRepository;
  readonly psiClient: PageSpeedClient;
  readonly groqClient: GroqClient;
  readonly serpClient: SerpClient;
  readonly webSearchClient: ReturnType<typeof createBraveSearchWebClient>;
  readonly searchLocation: string | null;
  readonly searchHl: string | undefined;
  readonly searchGl: string | undefined;
  readonly seedCategory: string | undefined;
  /** Requête google_local exacte (tendance ou grain statique). */
  readonly trendingQuery: string;
  readonly progressTag: string;
  readonly gatekeeperExclusions: GatekeeperExclusion[];
  /** Référence au budget Places du run (`used` augmenté aussi par Nearby Search concurrents). */
  readonly placesBudget: { used: number; max: number };
  /** Compteurs mutables (quotas création / refonte). */
  readonly quotaState: LeadQuotaState;
  readonly forceRescan: boolean;
};


async function processLocalRow(ctx: ProcessLocalContext): Promise<RadarPipelineLine | null> {
  const {
    config,
    serp,
    weekBucket,
    recentDays,
    repo,
    psiClient,
    groqClient,
    serpClient,
    webSearchClient,
    searchLocation,
    searchHl,
    searchGl,
    seedCategory,
    trendingQuery,
    progressTag,
    gatekeeperExclusions,
    placesBudget,
    quotaState,
    forceRescan,
  } = ctx;

  if (leadQuotasSatisfied(quotaState)) {
    return null;
  }

  const needCreation = quotaState.creationsFound < quotaState.targetCreation;
  const needRefonte = quotaState.refontesFound < quotaState.targetRefonte;
  const placeKey = stablePlaceKey(serp);

  if (!forceRescan) {
    const recent = await repo.getOutcomeWithinLastDays(placeKey, recentDays);
    if (recent === 'disqualified' || recent === 'diamond') {
      radarVerbose(
        config,
        `${progressTag} ${truncateTitle(serp.title)} · ⊗ SQLite · ${recent === 'diamond' ? 'déjà diamant' : 'déjà disqualifié'} (< ${recentDays} j)`,
      );
      return null;
    }
  }

  const gkTypes = collectGatekeeperTypes(serp);
  const gate = await assessCommercialProspect(config, serp, gkTypes);
  if (!gate.isCommercial) {
    await repo.recordPlaceOutcome(placeKey, 'disqualified');
    gatekeeperExclusions.push({
      name: serp.title,
      reason: gate.reason,
    });
    radarVerbose(
      config,
      `${progressTag} ${truncateTitle(serp.title)} · ⊘ Gatekeeper · ${truncateTitle(gate.reason, 88)}`,
    );
    return null;
  }

  const skipExtendedSearch = !needCreation && needRefonte && !serp.website?.trim();
  if (skipExtendedSearch && config.RADAR_VERBOSE) {
    radarVerbose(
      config,
      `${progressTag} ${truncateTitle(serp.title)} · ◇ Quota création atteint · recherche web étendue désactivée (besoin refonte)`,
    );
  }

  const websiteOut = await resolveProspectWebsitePresence({
    serp,
    serpClient,
    webSearchClient,
    searchLocation,
    hl: searchHl,
    gl: searchGl,
    opts: {
      skipExtendedSearch,
      fetchTimeoutMs: config.RADAR_FETCH_TIMEOUT_MS,
    },
  });
  const { resolution, ownerSite: resolved } = websiteOut;

  if (config.RADAR_VERBOSE) {
    const webAttempt = resolution.attempts.find((a) => a.layer === 'web_search');
    const webNote = webAttempt?.note ?? '';
    if (
      webNote.startsWith('HTTP ') ||
      webNote.includes('Plafond recherche web') ||
      webNote.includes(WEB_SEARCH_BUDGET_EXHAUSTED_REASON) ||
      webNote.includes('dailyLimitExceeded') ||
      webNote.includes('quotaExceeded')
    ) {
      radarVerbose(
        config,
        `${progressTag} ${truncateTitle(serp.title)} · ⚠ Brave Search · ${truncateTitle(webNote, 100)}`,
      );
    }
  }

  if (config.RADAR_VERBOSE && resolution.status !== 'none') {
    radarVerbose(
      config,
      `${progressTag} ${truncateTitle(serp.title)} · web ${resolution.status}${resolution.presencePlatform ? ` (${resolution.presencePlatform})` : ''}${resolution.url ? ` · ${truncateTitle(resolution.url, 72)}` : ''}`,
    );
  }

  const seed = seedCategory !== undefined ? { seedCategory } : {};

  async function enrichDiamondLine(
    badge: ConversionBadge,
    pain: DiamondPainType,
    urls: { normalizedUrl: string | null; displayUrl: string | null; websiteSource?: WebsiteSource },
  ): Promise<RadarPipelineLine> {
    const legalData = await fetchCompanyLegalDataForProspect({
      establishmentTitle: serp.title,
      searchLocationHint: searchLocation,
      mapsAddress: serp.address,
    });
    const nearbyCompetitors = await fetchNearbyWebsiteCompetitorsForDiamond({
      prospect: serp,
      serpClient,
      placesBudget,
      radiusMeters: config.RADAR_COMPETITOR_RADIUS_METERS,
      ...(searchHl !== undefined ? { searchHl } : {}),
      ...(searchGl !== undefined ? { searchGl } : {}),
    });
    return {
      serp,
      normalizedUrl: urls.normalizedUrl,
      displayUrl: urls.displayUrl,
      ...(urls.websiteSource !== undefined ? { websiteSource: urls.websiteSource } : {}),
      trendingQuery,
      ...seed,
      conversionBadge: badge,
      diamondPain: pain,
      strateScore: {
        total: STRATE_DIAMANT_CREATION_SCORE,
        isDiamantCreation: true,
        matrix: null,
      },
      weekBucket,
      fromCache: false,
      psiStrategy: 'mobile',
      pageSpeed: null,
      legalData,
      websiteResolution: resolution,
      ...(nearbyCompetitors !== undefined ? { nearbyCompetitors } : {}),
    };
  }

  if (qualifiesDiamantPresence(serp, resolution.status)) {
    if (quotaState.creationsFound >= quotaState.targetCreation) {
      radarVerbose(
        config,
        `${progressTag} ${truncateTitle(serp.title)} · ◇ Diamant présence ignoré · quota création atteint`,
      );
      return null;
    }
    await repo.recordPlaceOutcome(placeKey, 'diamond');
    await repo.recordDiamondEncounter(placeKey);
    radarVerbose(
      config,
      `${progressTag} ${truncateTitle(serp.title)} · 💎 DIAMANT PRÉSENCE · ${resolution.presencePlatform ?? 'intermédiaire'}${seedCategory !== undefined ? ` · grain « ${seedCategory} »` : ''}`,
    );
    return await enrichDiamondLine('DIAMANT_PRESENCE', 'presence_intermediary', {
      normalizedUrl: resolution.normalizedUrl,
      displayUrl: resolution.displayUrl,
    });
  }

  /** Diamant création : aucune présence web + réputation Maps (seuils bas) — pas de matrice. */
  if (qualifiesDiamantCreation(serp, resolution.status)) {
    if (quotaState.creationsFound >= quotaState.targetCreation) {
      radarVerbose(
        config,
        `${progressTag} ${truncateTitle(serp.title)} · ◇ Diamant création ignoré · quota création atteint`,
      );
      return null;
    }
    await repo.recordPlaceOutcome(placeKey, 'diamond');
    await repo.recordDiamondEncounter(placeKey);
    radarVerbose(
      config,
      `${progressTag} ${truncateTitle(serp.title)} · 💎 DIAMANT CRÉATION · ${STRATE_DIAMANT_CREATION_SCORE}/${STRATE_DIAMANT_CREATION_SCORE}${seedCategory !== undefined ? ` · grain « ${seedCategory} »` : ''}`,
    );
    return await enrichDiamondLine('DIAMANT_CREATION', 'diamant_creation', {
      normalizedUrl: null,
      displayUrl: null,
    });
  }

  if (resolved !== null && !needRefonte) {
    radarVerbose(
      config,
      `${progressTag} ${truncateTitle(serp.title)} · ◇ Fiche avec site ignorée · quota refonte atteint`,
    );
    return null;
  }

  if (resolved === null) {
    await repo.recordPlaceOutcome(placeKey, 'disqualified');
    radarVerbose(
      config,
      `${progressTag} ${truncateTitle(serp.title)} · ○ Présence web insuffisante — réputation OK mais ni site ni intermédiaire détecté`,
    );
    return null;
  }

  const websiteSource: WebsiteSource = resolved.source;

  const fetchResult = await fetchHtmlWithTimeout(
    resolved.displayUrl,
    config.RADAR_FETCH_TIMEOUT_MS,
  );
  if (!fetchResult.ok && config.RADAR_VERBOSE) {
    radarVerbose(
      config,
      `${progressTag} ${truncateTitle(serp.title)} · fetch HTML : ${truncateTitle(fetchResult.error ?? 'échec', 48)}`,
    );
  }

  const matrixOut = await runStrateMatrixScore({
    serp,
    resolved,
    fetchResult,
    analyzeDeadBrochure: (htmlExcerpt, businessName) =>
      groqClient.analyzeConversionBrochure({
        htmlExcerpt,
        businessName,
        ...(serp.type !== undefined && serp.type !== '' ? { mapsCategory: serp.type } : {}),
      }),
    loadOrRunPageSpeed: async () => {
      const cached = await repo.findByUrlAndWeek(resolved.normalizedUrl, weekBucket);
      if (cached) {
        const perf = extractLighthouseScoresPercent(cached.psi).performance;
        return { psi: cached.psi, mobilePercent: perf };
      }
      try {
        const psi = await psiClient.runPagespeed({
          url: resolved.displayUrl,
          strategy: 'mobile',
        });
        return {
          psi,
          mobilePercent: extractLighthouseScoresPercent(psi).performance,
        };
      } catch {
        return { psi: null, mobilePercent: null };
      }
    },
  });

  if (matrixOut.strate.total < STRATE_DIAMOND_THRESHOLD) {
    await repo.recordPlaceOutcome(placeKey, 'disqualified');
    radarVerbose(
      config,
      `${progressTag} ${truncateTitle(serp.title)} · ○ Strate ${matrixOut.strate.total}/100 < seuil ${STRATE_DIAMOND_THRESHOLD}`,
    );
    return null;
  }

  if (quotaState.refontesFound >= quotaState.targetRefonte) {
    radarVerbose(
      config,
      `${progressTag} ${truncateTitle(serp.title)} · ◇ Diamant refonte ignoré · quota refonte atteint (strate ${matrixOut.strate.total})`,
    );
    return null;
  }

  await repo.recordPlaceOutcome(placeKey, 'diamond');
  await repo.recordDiamondEncounter(placeKey);

  radarVerbose(
    config,
    `${progressTag} ${truncateTitle(serp.title)} · 💎 DIAMANT REFONTE · strate ${matrixOut.strate.total}/100${seedCategory !== undefined ? ` · grain « ${seedCategory} »` : ''}`,
  );

  const legalData = await fetchCompanyLegalDataForProspect({
    establishmentTitle: serp.title,
    searchLocationHint: searchLocation,
    mapsAddress: serp.address,
  });

  const nearbyCompetitors = await fetchNearbyWebsiteCompetitorsForDiamond({
    prospect: serp,
    serpClient,
    placesBudget,
    radiusMeters: config.RADAR_COMPETITOR_RADIUS_METERS,
    ...(searchHl !== undefined ? { searchHl } : {}),
    ...(searchGl !== undefined ? { searchGl } : {}),
  });

  return {
    serp,
    normalizedUrl: resolved.normalizedUrl,
    displayUrl: resolved.displayUrl,
    websiteSource,
    trendingQuery,
    ...seed,
    conversionBadge: 'DIAMANT_REFONTE',
    diamondPain: 'strate_matrix',
    strateScore: {
      total: matrixOut.strate.total,
      isDiamantCreation: false,
      matrix: matrixOut.strate,
    },
    weekBucket,
    fromCache: false,
    psiStrategy: 'mobile',
    pageSpeed: matrixOut.pageSpeed,
    legalData,
    websiteResolution: resolution,
    ...(nearbyCompetitors !== undefined ? { nearbyCompetitors } : {}),
  };
}

export async function runRadarPipeline(
  options: RunRadarPipelineOptions,
): Promise<RadarPipelineResult> {
  const { config } = options;
  const weekBucket = formatIsoWeekBucket(new Date());
  const generatedAtIso = new Date().toISOString();

  const targetCreationCount =
    options.targetCreationCount ?? config.RADAR_TARGET_CREATION_COUNT;
  const targetRefonteCount = options.targetRefonteCount ?? config.RADAR_TARGET_REFONTE_COUNT;
  const maxPages = config.RADAR_SERP_MAX_PAGES;
  const placesRequestsMax = config.RADAR_MAX_PLACES_REQUESTS_PER_RUN;
  const recentDays = config.RADAR_SQLITE_RECENT_DAYS;
  let cityLocation = options.search.location ?? config.RADAR_SEARCH_LOCATION;
  let demandDrivenMode = config.RADAR_TREND_DRIVEN;
  let seeds: string[] = [];
  let multiCategoryMode = false;
  let campaignPair: { city: string; category: string } | undefined;
  let campaignRepo: CampaignRepository | undefined;

  const targetedMode = options.targetProspect !== undefined;
  const forceRescan = options.forceRescan ?? targetedMode;
  const targetProspectMisses: string[] = [];
  let targetProspectHandled = false;

  if (targetedMode) {
    demandDrivenMode = false;
    multiCategoryMode = false;
    seeds = [options.targetProspect!.name.trim()];
    if (options.targetProspect!.location?.trim()) {
      cityLocation = options.targetProspect!.location.trim();
    }
    radarVerbose(
      config,
      `\n🎯 Audit ciblé · « ${truncateTitle(options.targetProspect!.name, 72)} » · ${cityLocation}`,
    );
  } else if (config.RADAR_CAMPAIGN_MODE) {
    demandDrivenMode = false;
    multiCategoryMode = true;
  } else if (demandDrivenMode) {
    radarVerbose(
      config,
      '\n📈 Trend Catcher · intentions locales (Google Suggest, gratuit)…',
    );
    const fallbackQ = options.search.q ?? config.RADAR_SEARCH_Q;
    const rawTrends = await catchLocalSearchIntentions(cityLocation, {
      simulation: config.simulation,
      fallbackQuery: fallbackQ,
    });
    const padded =
      rawTrends.length < 4 ? padTrendQueries(rawTrends, cityLocation, fallbackQ) : rawTrends;
    seeds = padded.slice(0, 10);
    multiCategoryMode = seeds.length > 1;
    radarVerbose(
      config,
      `   → ${seeds.length} requête(s) : ${seeds.map((s) => truncateTitle(s, 36)).join(' | ')}`,
    );
  } else if (config.RADAR_USE_SEED_LIST) {
    seeds = [...(options.seedCategories ?? [...DIAMOND_SEED_CATEGORIES])];
    multiCategoryMode = true;
  } else {
    seeds = [options.search.q];
    multiCategoryMode = false;
  }

  const db = await openDatabase(config.STRATE_RADAR_DB_PATH);
  await migrateProspectsTable(db);
  await migrateDiamondRescanGuard(db);
  await migrateRadarPlaceLastOutcome(db);
  await migrateRadarWeekPlaceOutcome(db);

  if (config.RADAR_CAMPAIGN_MODE && !targetedMode) {
    await migrateCampaignTables(db);
    campaignRepo = new CampaignRepository(db);
    const groqCampaign = createGroqClient(config);
    const pair = await resolveNextCampaignPair(config, campaignRepo, groqCampaign, {
      bootstrapAnchorCity: options.search.location ?? config.RADAR_SEARCH_LOCATION,
    });
    campaignPair = pair;
    cityLocation = pair.city;
    seeds = [pair.category];
    radarVerbose(
      config,
      `\n🎯 Campagne autonome · couple : « ${pair.city} » × « ${pair.category} »`,
    );
  }

  const seedCategoriesResolved = seeds;
  const trendQueriesResolved = seeds;

  const repo = new ProspectRepository(db);

  const serpBudget = { used: 0, max: placesRequestsMax };
  const webSearchRequestsMax = config.RADAR_MAX_WEB_SEARCH_REQUESTS_PER_RUN;
  const webSearchBudget = { used: 0, max: webSearchRequestsMax };
  const baseSerp = createRadarSearchClient(config);
  const serpClient = wrapSerpClientWithBudget(baseSerp, serpBudget);

  const psiClient = createPageSpeedClient(config);
  const groqClient = createGroqClient(config);
  const webSearchBoot = describeWebSearchBoot(config);
  const baseWebSearchClient =
    webSearchRequestsMax > 0 ? createBraveSearchWebClient(config) : null;
  const webSearchClient =
    baseWebSearchClient !== null
      ? wrapWebSearchClientWithBudget(baseWebSearchClient, webSearchBudget)
      : null;

  console.log(`[radar] Brave Search : ${webSearchBoot.statusLine}`);

  const lines: RadarPipelineLine[] = [];
  const gatekeeperExclusions: GatekeeperExclusion[] = [];
  const quotaState: LeadQuotaState = {
    creationsFound: 0,
    refontesFound: 0,
    targetCreation: targetCreationCount,
    targetRefonte: targetRefonteCount,
  };
  let totalBusinessesScanned = 0;

  const reportCityDisplayName = extractCityLabelForReport(cityLocation);

  radarVerbose(
    config,
    `\n—— Strate Radar · ${reportCityDisplayName} · quotas création ${targetCreationCount} · refonte ${targetRefonteCount} · plafond Places ${placesRequestsMax} · Brave Search ${webSearchRequestsMax}/run ——`,
  );
  radarVerbose(
    config,
    targetedMode
      ? `Mode : audit ciblé · jusqu’à ${maxPages} pages Places`
      : demandDrivenMode
        ? `Mode : demand-driven (${seeds.length} intentions · jusqu’à ${maxPages} pages Places par requête)`
        : multiCategoryMode
          ? `Mode : liste de grainage (${seeds.length} familles · jusqu’à ${maxPages} pages Places par famille)`
          : `Mode : une seule requête`,
  );

  let serpBudgetExhausted = false;
  let placesStoppedEarly = false;
  let placesStopMessage: string | undefined;

  runOuter: for (const seed of seeds) {
    if (leadQuotasSatisfied(quotaState)) break;
    if (serpBudget.used >= placesRequestsMax) break;

    const q = demandDrivenMode
      ? seed
      : multiCategoryMode
        ? buildSeedSearchQuery(seed, cityLocation)
        : seed;
    const seedLabel = demandDrivenMode ? seed : multiCategoryMode ? seed : undefined;

    radarVerbose(
      config,
      `\n▸ ${demandDrivenMode ? 'Tendance' : multiCategoryMode ? `Famille « ${seed} »` : 'Recherche'} · ${truncateTitle(q, 88)}`,
    );

    let placesPageToken: string | undefined;

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      if (leadQuotasSatisfied(quotaState)) break runOuter;
      if (serpBudget.used >= placesRequestsMax) break runOuter;

      radarVerbose(
        config,
        `   Places Text Search · page ${pageIndex + 1}/${maxPages} · consommés ${serpBudget.used}/${placesRequestsMax}`,
      );

      const serpParams: GoogleLocalSearchParams = {
        q,
        location: cityLocation,
        ...(options.search.hl !== undefined ? { hl: options.search.hl } : {}),
        ...(options.search.gl !== undefined ? { gl: options.search.gl } : {}),
        ...(placesPageToken !== undefined ? { pageToken: placesPageToken } : {}),
      };

      let maps;
      try {
        maps = await serpClient.searchGoogleLocal(serpParams);
      } catch (e) {
        if (e instanceof StrateRadarError && e.code === 'SERP_BUDGET') {
          serpBudgetExhausted = true;
          radarVerbose(config, `\n⚠ ${e.message}`);
          break runOuter;
        }
        if (
          e instanceof StrateRadarError &&
          e.code === 'HTTP_STATUS' &&
          e.status === 429
        ) {
          placesStoppedEarly = true;
          placesStopMessage = e.message;
          radarVerbose(
            config,
            `\n⚠ Google Places : quota ou limite (HTTP 429) — fin du run avec résultats partiels.\n   ${truncateTitle(e.message, 120)}`,
          );
          break runOuter;
        }
        throw e;
      }

      const locals = maps.local_results ?? [];
      radarVerbose(config, `   → ${locals.length} résultat(s) Maps`);
      if (locals.length === 0) {
        radarVerbose(config, `   (plus de résultats pour cette famille → suivante)`);
        break;
      }

      let rowsToScan: SerpLocalResult[] = [...locals];
      if (targetedMode) {
        const match = pickBestPlacesMatch(options.targetProspect!.name, locals);
        if (!match) {
          radarVerbose(
            config,
            `   ◇ Aucun match suffisant pour « ${truncateTitle(options.targetProspect!.name, 56)} » sur cette page`,
          );
          placesPageToken =
            maps.next_page_token !== undefined && maps.next_page_token !== ''
              ? maps.next_page_token
              : undefined;
          if (!placesPageToken) break;
          continue;
        }
        rowsToScan = [match];
        radarVerbose(
          config,
          `   ✓ Match Maps : « ${truncateTitle(match.title, 72)} »`,
        );
      }

      for (const row of rowsToScan) {
        if (leadQuotasSatisfied(quotaState)) break runOuter;
        if (serpBudget.used >= placesRequestsMax) break runOuter;

        totalBusinessesScanned += 1;
        const progressTag = `[#${totalBusinessesScanned} · req. ${serpBudget.used}/${placesRequestsMax}]`;

        const line = await processLocalRow({
          config,
          serp: row,
          weekBucket,
          recentDays,
          repo,
          psiClient,
          groqClient,
          serpClient,
          webSearchClient,
          searchLocation: cityLocation,
          searchHl: options.search.hl,
          searchGl: options.search.gl,
          seedCategory: seedLabel,
          trendingQuery: q,
          progressTag,
          gatekeeperExclusions,
          placesBudget: serpBudget,
          quotaState,
          forceRescan,
        });

        if (targetedMode) {
          targetProspectHandled = true;
        }

        if (line !== null) {
          lines.push(line);
          if (
            line.conversionBadge === 'DIAMANT_CREATION' ||
            line.conversionBadge === 'DIAMANT_PRESENCE'
          ) {
            quotaState.creationsFound += 1;
          } else if (line.conversionBadge === 'DIAMANT_REFONTE') {
            quotaState.refontesFound += 1;
          }
          radarVerbose(
            config,
            `   … Progression : création ${quotaState.creationsFound}/${quotaState.targetCreation} · refonte ${quotaState.refontesFound}/${quotaState.targetRefonte}`,
          );
        }

        if (targetedMode) {
          break runOuter;
        }
      }

      if (targetedMode) {
        break;
      }

      placesPageToken =
        maps.next_page_token !== undefined && maps.next_page_token !== ''
          ? maps.next_page_token
          : undefined;
      if (!placesPageToken) {
        break;
      }
    }
  }

  if (targetedMode && !targetProspectHandled) {
    targetProspectMisses.push(options.targetProspect!.name.trim());
    radarVerbose(
      config,
      `\n⚠ Cible introuvable sur Google Places : « ${options.targetProspect!.name} »`,
    );
  }

  radarVerbose(
    config,
    `\n—— Fin · création ${quotaState.creationsFound}/${quotaState.targetCreation} · refonte ${quotaState.refontesFound}/${quotaState.targetRefonte} · ${totalBusinessesScanned} fiches · Places ${serpBudget.used}/${placesRequestsMax} · Brave Search ${webSearchBudget.used}/${webSearchRequestsMax}${
      serpBudgetExhausted ? ' (plafond budget Places)' : ''
    }${placesStoppedEarly ? ' (arrêt HTTP 429 Places)' : ''} ——\n`,
  );

  if (campaignPair !== undefined && campaignRepo !== undefined) {
    await campaignRepo.recordRun(
      campaignPair.city,
      campaignPair.category,
      quotaState.creationsFound + quotaState.refontesFound,
      generatedAtIso,
    );
    await applyCampaignSaturationIfNeeded(campaignRepo, campaignPair.city);
  }

  await closeDatabase(db);

  const searchSummary: RadarSearchParams = {
    q: targetedMode
      ? `Ciblé · ${options.targetProspect!.name.trim()}`
      : campaignPair !== undefined
        ? `Campagne · ${campaignPair.category}`
        : demandDrivenMode
          ? `Demand-driven · ${seeds.length} intention(s) Suggest`
          : multiCategoryMode
            ? `Grainage multi-métiers (${seeds.length} familles)`
            : options.search.q,
    location: options.search.location ?? cityLocation,
    ...(options.search.hl !== undefined ? { hl: options.search.hl } : {}),
    ...(options.search.gl !== undefined ? { gl: options.search.gl } : {}),
  };

  return {
    lines,
    weekBucket,
    search: searchSummary,
    generatedAtIso,
    targetCreationCount,
    targetRefonteCount,
    creationsFound: quotaState.creationsFound,
    refontesFound: quotaState.refontesFound,
    totalBusinessesScanned,
    placesRequestsUsed: serpBudget.used,
    placesRequestsMax,
    webSearchRequestsUsed: webSearchBudget.used,
    webSearchRequestsMax,
    webSearchConfigured: webSearchBoot.configured,
    webSearchBootStatus: webSearchBoot.statusLine,
    reportCityDisplayName,
    seedCategoriesResolved,
    multiCategoryMode,
    demandDrivenMode,
    trendQueriesResolved,
    placesStoppedEarly,
    placesBudgetExhausted: serpBudgetExhausted,
    targetedMode,
    ...(targetProspectMisses.length > 0 ? { targetProspectMisses } : {}),
    ...(placesStopMessage !== undefined ? { placesStopMessage } : {}),
    gatekeeperExclusions,
    ...(campaignPair !== undefined ? { campaign: campaignPair } : {}),
  };
}
