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
  summarizeStrateNearMiss,
  type StrateScoreResult,
} from '../lib/strate-scorer.js';
import {
  assessPreflightCommercialTarget,
  isMapsListingTitlePrefilterExcluded,
} from '../lib/gatekeeper.js';
import { extractLighthouseScoresPercent } from '../lib/lighthouse.js';
import { stablePlaceKey } from '../lib/place-key.js';
import { extractCityLabelForReport } from '../lib/report-city.js';
import { formatIsoWeekBucket } from '../lib/week.js';
import {
  resolveProspectWebsitePresence,
  type WebsiteResolution,
} from '../lib/website-resolver.js';
import { assessWebSearchDoubleCheckGate } from '../lib/web-search-verification.js';
import { createBraveSearchWebClient, describeWebSearchBoot } from '../services/serp/brave-search.client.js';
import type { WebSearchClient } from '../services/serp/web-search.types.js';
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
import {
  CreationHuntRepository,
  describeCreationHuntPlan,
  migrateCreationHuntTables,
  planCreationHuntWave,
  planNextCreationHuntExpansion,
  resolveAnchorZones,
  type CreationHuntPlan,
} from '../lib/creation-hunt/index.js';

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

export type ScoreNearMiss = {
  readonly name: string;
  readonly strateScore: number | null;
  readonly threshold: number;
  readonly displayUrl: string | null;
  readonly reason: string;
};

const SCORE_NEAR_MISS_REPORT_MAX = 8;

/** Garde les near-miss les plus proches du seuil (Telegram / rapport). */
export function trimScoreNearMissesForReport(
  misses: readonly ScoreNearMiss[],
  max = SCORE_NEAR_MISS_REPORT_MAX,
): { readonly shown: ScoreNearMiss[]; readonly total: number } {
  const total = misses.length;
  if (total <= max) {
    return { shown: [...misses], total };
  }
  const shown = [...misses]
    .sort((a, b) => (b.strateScore ?? -1) - (a.strateScore ?? -1))
    .slice(0, max);
  return { shown, total };
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
  /** Refonte avec site mais score matrice sous le seuil (affichage plafonné). */
  readonly scoreNearMisses: readonly ScoreNearMiss[];
  readonly scoreNearMissesTotal: number;
  /** Fiches non qualifiées faute de double vérif Brave (plafond run) — retry prochain run. */
  readonly webSearchGateBlockedCount: number;
  /** Run en mode campagne autonome (matrice ville × métier). */
  readonly campaign?: { readonly city: string; readonly category: string };
  /** Chasse création : grainage artisan + expansion géo. */
  readonly creationHuntMode: boolean;
  readonly creationHuntZones?: readonly string[];
  readonly creationHuntSectors?: readonly string[];
  readonly creationHuntExpansionRing?: number;
};

type PipelineSearchJob = {
  readonly q: string;
  readonly location: string;
  readonly seedCategory?: string;
  readonly trendingQuery: string;
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
  readonly webSearchClient: WebSearchClient | null;
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
  readonly scoreNearMisses: ScoreNearMiss[];
  readonly webSearchGateBlocked: { count: number };
  /** Refonte désactivée — économise Places / Brave / PageSpeed sur les sites existants. */
  readonly creationOnlyMode: boolean;
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
    scoreNearMisses,
    webSearchGateBlocked,
    creationOnlyMode,
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

  const prefilterReason = isMapsListingTitlePrefilterExcluded(serp);
  if (prefilterReason !== null) {
    await repo.recordPlaceOutcome(placeKey, 'disqualified');
    gatekeeperExclusions.push({
      name: serp.title,
      reason: prefilterReason,
    });
    radarVerbose(
      config,
      `${progressTag} ${truncateTitle(serp.title)} · ⊘ Préfiltre Maps · ${truncateTitle(prefilterReason, 88)}`,
    );
    return null;
  }

  const preflight = await assessPreflightCommercialTarget(
    config,
    serp,
    searchLocation ?? config.RADAR_SEARCH_LOCATION,
  );
  if (!preflight.isCommercialTarget) {
    await repo.recordPlaceOutcome(placeKey, 'disqualified');
    gatekeeperExclusions.push({
      name: serp.title,
      reason: `Pre-flight IA · ${preflight.reason}`,
    });
    radarVerbose(
      config,
      `${progressTag} ${truncateTitle(serp.title)} · ⊘ Pre-flight IA · ${truncateTitle(preflight.reason, 88)}`,
    );
    return null;
  }
  if (preflight.fallbackUsed) {
    console.warn(
      `[radar] Pre-flight Groq pass-through · ${truncateTitle(serp.title, 48)} · ${preflight.reason.slice(0, 80)}`,
    );
    radarVerbose(
      config,
      `${progressTag} ${truncateTitle(serp.title)} · ⚠ Pre-flight IA · ${truncateTitle(preflight.reason, 88)}`,
    );
  }

  const skipExtendedSearch = creationOnlyMode
    ? Boolean(serp.website?.trim())
    : !needCreation && needRefonte && !serp.website?.trim();
  if (skipExtendedSearch && config.RADAR_VERBOSE) {
    radarVerbose(
      config,
      `${progressTag} ${truncateTitle(serp.title)} · ◇ ${
        creationOnlyMode
          ? 'Site Maps — cascade web courte (mode chasse création)'
          : 'Quota création atteint · requery Places désactivée (besoin refonte)'
      }`,
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

  if (creationOnlyMode && resolution.status === 'owner_site') {
    await repo.recordPlaceOutcome(placeKey, 'disqualified');
    radarVerbose(
      config,
      `${progressTag} ${truncateTitle(serp.title)} · ◇ Site propriétaire — ignoré (chasse création)`,
    );
    return null;
  }

  const webSearchGate = assessWebSearchDoubleCheckGate({
    resolution,
    skipExtendedSearch,
    webSearchConfigured: webSearchClient !== null,
  });
  if (!webSearchGate.allowed) {
    webSearchGateBlocked.count += 1;
    radarVerbose(
      config,
      `${progressTag} ${truncateTitle(serp.title)} · ◇ ${truncateTitle(webSearchGate.reason, 100)}`,
    );
    return null;
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
    scoreNearMisses.push({
      name: serp.title,
      strateScore: null,
      threshold: config.RADAR_DIAMOND_THRESHOLD,
      displayUrl: resolution.displayUrl,
      reason: 'Présence web insuffisante — ni site owner ni intermédiaire qualifiant',
    });
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

  if (matrixOut.strate.total < config.RADAR_DIAMOND_THRESHOLD) {
    await repo.recordPlaceOutcome(placeKey, 'disqualified');
    scoreNearMisses.push({
      name: serp.title,
      strateScore: matrixOut.strate.total,
      threshold: config.RADAR_DIAMOND_THRESHOLD,
      displayUrl: resolved.displayUrl,
      reason: summarizeStrateNearMiss(matrixOut.strate),
    });
    radarVerbose(
      config,
      `${progressTag} ${truncateTitle(serp.title)} · ○ Strate ${matrixOut.strate.total}/100 < seuil ${config.RADAR_DIAMOND_THRESHOLD}`,
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

function buildSearchJobsFromCreationPlan(plan: CreationHuntPlan): PipelineSearchJob[] {
  const jobs: PipelineSearchJob[] = [];
  for (const wave of plan.waves) {
    for (const query of wave.queries) {
      jobs.push({
        q: query.q,
        location: query.zone,
        seedCategory: query.sector,
        trendingQuery: query.q,
      });
    }
  }
  return jobs;
}

function buildLegacySearchJobs(args: {
  readonly seeds: readonly string[];
  readonly demandDrivenMode: boolean;
  readonly multiCategoryMode: boolean;
  readonly cityLocation: string;
}): PipelineSearchJob[] {
  const { seeds, demandDrivenMode, multiCategoryMode, cityLocation } = args;
  return seeds.map((seed) => {
    const q = demandDrivenMode
      ? seed
      : multiCategoryMode
        ? buildSeedSearchQuery(seed, cityLocation)
        : seed;
    const seedLabel = demandDrivenMode ? undefined : multiCategoryMode ? seed : undefined;
    return {
      q,
      location: cityLocation,
      ...(seedLabel !== undefined ? { seedCategory: seedLabel } : {}),
      trendingQuery: q,
    };
  });
}

export async function runRadarPipeline(
  options: RunRadarPipelineOptions,
): Promise<RadarPipelineResult> {
  const { config } = options;
  const weekBucket = formatIsoWeekBucket(new Date());
  const generatedAtIso = new Date().toISOString();

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

  const creationHuntMode =
    config.RADAR_CREATION_HUNT_MODE && !targetedMode && !config.RADAR_CAMPAIGN_MODE;

  let targetCreationCount =
    options.targetCreationCount ?? config.RADAR_TARGET_CREATION_COUNT;
  let targetRefonteCount = options.targetRefonteCount ?? config.RADAR_TARGET_REFONTE_COUNT;

  if (creationHuntMode) {
    targetRefonteCount = 0;
    targetCreationCount = Math.max(
      config.RADAR_CREATION_HUNT_MIN_PER_NIGHT,
      targetCreationCount,
    );
  }

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
  } else if (creationHuntMode) {
    demandDrivenMode = false;
    multiCategoryMode = true;
    radarVerbose(
      config,
      `\n🎯 Creation Hunt · grainage artisan · quota création ≥ ${targetCreationCount} · refonte off`,
    );
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

  const repo = new ProspectRepository(db);

  let creationHuntPlan: CreationHuntPlan | undefined;
  let creationHuntRepo: CreationHuntRepository | undefined;
  let creationHuntExpansionRing = 0;
  let searchJobs: PipelineSearchJob[] = [];
  const huntQueriesProcessed: string[] = [];
  const huntSectorStats = new Map<string, number>();
  const huntZonesProcessed = new Set<string>();

  const serpBudget = { used: 0, max: placesRequestsMax };
  const webSearchRequestsMax = creationHuntMode
    ? Math.max(config.RADAR_MAX_WEB_SEARCH_REQUESTS_PER_RUN, 120)
    : config.RADAR_MAX_WEB_SEARCH_REQUESTS_PER_RUN;
  const webSearchBudget = { used: 0, max: webSearchRequestsMax };
  const baseSerp = createRadarSearchClient(config);
  const serpClient = wrapSerpClientWithBudget(baseSerp, serpBudget);

  const psiClient = createPageSpeedClient(config);
  const groqClient = createGroqClient(config);

  if (creationHuntMode) {
    await migrateCreationHuntTables(db);
    creationHuntRepo = new CreationHuntRepository(db);

    /* Maintenance SQLite : réactivation zones stales + purge anciens runs */
    const reactivated = await creationHuntRepo.reactivateStaleZones(
      config.RADAR_CREATION_HUNT_ZONE_TTL_DAYS,
    );
    const pruned = await creationHuntRepo.pruneOldSectorRuns(config.RADAR_CREATION_HUNT_DB_TTL_DAYS);
    if (reactivated > 0 || pruned > 0) {
      radarVerbose(
        config,
        `   🔧 Maintenance SQLite · ${reactivated} zone(s) réactivée(s) · ${pruned} run(s) secteur purgé(s)`,
      );
    }

    const anchorZones = resolveAnchorZones(config);
    radarVerbose(
      config,
      `   → ${anchorZones.length} ancre(s) : ${anchorZones.join(' | ')}`,
    );

    creationHuntPlan = await planCreationHuntWave({
      config,
      repo: creationHuntRepo,
      groq: groqClient,
      anchorZones,
      sectorsPerZone: config.RADAR_CREATION_HUNT_SECTORS_PER_ZONE,
      expansionRing: 0,
    });
    seeds = [...creationHuntPlan.sectorsUsed];
    searchJobs = buildSearchJobsFromCreationPlan(creationHuntPlan);
    radarVerbose(
      config,
      `   → ${describeCreationHuntPlan(creationHuntPlan)} · ${searchJobs.length} requête(s)`,
    );
  } else {
    searchJobs = buildLegacySearchJobs({
      seeds,
      demandDrivenMode,
      multiCategoryMode,
      cityLocation,
    });
  }

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
  const scoreNearMisses: ScoreNearMiss[] = [];
  const webSearchGateBlocked = { count: 0 };
  /** Compteur de fiches scannées par clé zone|secteur — pour calcul taux de conversion. */
  const huntSectorScannedCounts = new Map<string, number>();
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
      : creationHuntMode
        ? `Mode : Creation Hunt · ${searchJobs.length} requêtes · expansion max ${config.RADAR_CREATION_HUNT_MAX_EXPANSIONS} anneau(x)`
        : demandDrivenMode
          ? `Mode : demand-driven (${seeds.length} intentions · jusqu’à ${maxPages} pages Places par requête)`
          : multiCategoryMode
            ? `Mode : liste de grainage (${seeds.length} familles · jusqu’à ${maxPages} pages Places par famille)`
            : `Mode : une seule requête`,
  );

  let serpBudgetExhausted = false;
  let placesStoppedEarly = false;
  let placesStopMessage: string | undefined;

  const creationOnlyMode = targetRefonteCount === 0;

  huntExpandLoop: while (true) {
    runOuter: for (const job of searchJobs) {
      if (leadQuotasSatisfied(quotaState)) break huntExpandLoop;
      if (serpBudget.used >= placesRequestsMax) break huntExpandLoop;

      cityLocation = job.location;
      huntZonesProcessed.add(job.location);
      huntQueriesProcessed.push(job.trendingQuery);
      const q = job.q;
      const seedLabel = job.seedCategory;

      if (creationHuntMode && seedLabel !== undefined) {
        const statKey = `${job.location}|${seedLabel}`;
        if (!huntSectorStats.has(statKey)) huntSectorStats.set(statKey, 0);
      }

      radarVerbose(
        config,
        `\n▸ ${creationHuntMode ? `Chasse · ${job.location}` : demandDrivenMode ? 'Tendance' : multiCategoryMode ? `Famille « ${seedLabel ?? q} »` : 'Recherche'} · ${truncateTitle(q, 88)}`,
      );

      let placesPageToken: string | undefined;

      for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
        if (leadQuotasSatisfied(quotaState)) break huntExpandLoop;
        if (serpBudget.used >= placesRequestsMax) break huntExpandLoop;

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
            break huntExpandLoop;
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
            break huntExpandLoop;
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
          if (leadQuotasSatisfied(quotaState)) break huntExpandLoop;
          if (serpBudget.used >= placesRequestsMax) break huntExpandLoop;

          totalBusinessesScanned += 1;
          const progressTag = `[#${totalBusinessesScanned} · req. ${serpBudget.used}/${placesRequestsMax}]`;

          if (creationHuntMode && seedLabel !== undefined) {
            const scanKey = `${cityLocation}|${seedLabel}`;
            huntSectorScannedCounts.set(scanKey, (huntSectorScannedCounts.get(scanKey) ?? 0) + 1);
          }

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
            trendingQuery: job.trendingQuery,
            progressTag,
            gatekeeperExclusions,
            placesBudget: serpBudget,
            quotaState,
            forceRescan,
            scoreNearMisses,
            webSearchGateBlocked,
            creationOnlyMode,
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
              if (creationHuntMode && seedLabel) {
                const statKey = `${cityLocation}|${seedLabel}`;
                huntSectorStats.set(statKey, (huntSectorStats.get(statKey) ?? 0) + 1);
              }
            } else if (line.conversionBadge === 'DIAMANT_REFONTE') {
              quotaState.refontesFound += 1;
            }
            radarVerbose(
              config,
              `   … Progression : création ${quotaState.creationsFound}/${quotaState.targetCreation} · refonte ${quotaState.refontesFound}/${quotaState.targetRefonte}`,
            );
          }

          if (targetedMode) {
            break huntExpandLoop;
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

    if (!creationHuntMode) break;
    if (quotaState.creationsFound >= quotaState.targetCreation) break;
    if (creationHuntExpansionRing >= config.RADAR_CREATION_HUNT_MAX_EXPANSIONS) break;
    if (serpBudget.used >= placesRequestsMax) break;
    if (placesStoppedEarly || serpBudgetExhausted) break;

    const nextPlan = await planNextCreationHuntExpansion({
      config,
      repo: creationHuntRepo!,
      groq: groqClient,
      anchorZones: resolveAnchorZones(config),
      sectorsPerZone: config.RADAR_CREATION_HUNT_SECTORS_PER_ZONE,
      expansionRing: creationHuntExpansionRing,
      currentRing: creationHuntExpansionRing,
      maxExpansions: config.RADAR_CREATION_HUNT_MAX_EXPANSIONS,
    });
    if (nextPlan === null) break;

    creationHuntExpansionRing = nextPlan.expansionRing;
    creationHuntPlan = nextPlan;
    searchJobs = buildSearchJobsFromCreationPlan(nextPlan);
    for (const z of nextPlan.zonesUsed) huntZonesProcessed.add(z);
    radarVerbose(
      config,
      `\n🌍 Expansion géo · anneau ${creationHuntExpansionRing} · ${describeCreationHuntPlan(nextPlan)} · création ${quotaState.creationsFound}/${quotaState.targetCreation}`,
    );
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

  if (creationHuntRepo !== undefined) {
    const allSectorKeys = new Set([...huntSectorStats.keys(), ...huntSectorScannedCounts.keys()]);
    for (const key of allSectorKeys) {
      const sep = key.indexOf('|');
      if (sep <= 0) continue;
      const zone = key.slice(0, sep);
      const sector = key.slice(sep + 1);
      const creationsCount = huntSectorStats.get(key) ?? 0;
      const scannedCount = huntSectorScannedCounts.get(key) ?? 0;
      await creationHuntRepo.recordSectorRun(zone, sector, creationsCount, scannedCount, generatedAtIso);
    }
    for (const zone of huntZonesProcessed) {
      let zoneCreations = 0;
      let zoneTotalScanned = 0;
      for (const key of allSectorKeys) {
        if (key.startsWith(`${zone}|`)) {
          zoneCreations += huntSectorStats.get(key) ?? 0;
          zoneTotalScanned += huntSectorScannedCounts.get(key) ?? 0;
        }
      }
      await creationHuntRepo.recordZoneRun(
        zone,
        zoneCreations,
        zoneTotalScanned,
        generatedAtIso,
        config.RADAR_CREATION_LOW_THRESHOLD,
        config.RADAR_CREATION_SATURATION_RUNS,
      );
    }
  }

  await closeDatabase(db);

  const trendQueriesResolved =
    creationHuntMode && huntQueriesProcessed.length > 0
      ? [...new Set(huntQueriesProcessed)]
      : seeds;

  const searchSummary: RadarSearchParams = {
    q: targetedMode
      ? `Ciblé · ${options.targetProspect!.name.trim()}`
      : creationHuntMode
        ? `Creation Hunt · anneau ${creationHuntExpansionRing} · ${trendQueriesResolved.length} requête(s)`
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

  const nearMissReport = trimScoreNearMissesForReport(scoreNearMisses);

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
    scoreNearMisses: nearMissReport.shown,
    scoreNearMissesTotal: nearMissReport.total,
    webSearchGateBlockedCount: webSearchGateBlocked.count,
    creationHuntMode,
    ...(creationHuntMode
      ? {
          creationHuntZones: [...huntZonesProcessed],
          creationHuntSectors: creationHuntPlan?.sectorsUsed ?? seeds,
          creationHuntExpansionRing,
        }
      : {}),
    ...(campaignPair !== undefined ? { campaign: campaignPair } : {}),
  };
}
