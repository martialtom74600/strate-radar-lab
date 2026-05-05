import type { AppConfig } from '../config/index.js';
import {
  buildSeedSearchQuery,
  DIAMOND_SEED_CATEGORIES,
} from '../config/categories.js';
import {
  type DiamondPainType,
  type ResolvedWebsite,
} from '../lib/diamond.js';
import { StrateRadarError } from '../lib/errors.js';
import {
  fetchHtmlWithTimeout,
  qualifiesDiamantCreation,
  runStrateMatrixScore,
  STRATE_DIAMOND_THRESHOLD,
  STRATE_DIAMANT_CREATION_SCORE,
  type StrateScoreResult,
} from '../lib/strate-scorer.js';
import {
  assessCommercialProspect,
  collectGatekeeperTypes,
} from '../lib/gatekeeper.js';
import { pickBestOrganicUrlForBusiness, type OrganicSerpHit } from '../lib/organic-match.js';
import { extractLighthouseScoresPercent } from '../lib/lighthouse.js';
import { stablePlaceKey } from '../lib/place-key.js';
import { extractCityLabelForReport } from '../lib/report-city.js';
import { normalizeProspectUrl, toAbsoluteHttpUrl, urlIsThirdPartyPresenceOnly } from '../lib/url.js';
import { formatIsoWeekBucket } from '../lib/week.js';
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

/** Succès API : refonte (matrice) ou création (sans site propriétaire). */
export type ConversionBadge = 'DIAMANT_REFONTE' | 'DIAMANT_CREATION';

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
};

async function resolveProspectWebsite(
  serp: SerpLocalResult,
  serpClient: SerpClient,
  searchLocation: string | null,
  hl: string | undefined,
  gl: string | undefined,
  opts?: { readonly skipOrganic?: boolean },
): Promise<ResolvedWebsite | null> {
  const rawSite = serp.website?.trim();
  if (rawSite) {
    const displayUrl = toAbsoluteHttpUrl(rawSite);
    if (!displayUrl) return null;
    if (urlIsThirdPartyPresenceOnly(displayUrl)) return null;
    const normalizedUrl = normalizeProspectUrl(displayUrl);
    if (!normalizedUrl) return null;
    return { displayUrl, normalizedUrl, source: 'maps_link' };
  }

  if (opts?.skipOrganic) {
    return null;
  }

  const locationHint = searchLocation?.trim() ?? '';
  const deepQuery = [serp.title, locationHint].filter(Boolean).join(' ').trim();
  if (!deepQuery) return null;

  try {
    const organic = await serpClient.searchGoogleOrganic({
      q: deepQuery,
      ...(hl !== undefined ? { hl } : {}),
      ...(gl !== undefined ? { gl } : {}),
    });
    const hits = organic.organic_results ?? [];
    const pickedUrl = pickBestOrganicUrlForBusiness(
      serp.title,
      hits.map((h): OrganicSerpHit => ({
        title: h.title,
        link: h.link,
        ...(h.snippet !== undefined ? { snippet: h.snippet } : {}),
      })),
    );
    if (!pickedUrl) return null;
    const displayUrl = toAbsoluteHttpUrl(pickedUrl);
    if (!displayUrl) return null;
    if (urlIsThirdPartyPresenceOnly(displayUrl)) return null;
    const normalizedUrl = normalizeProspectUrl(displayUrl);
    if (!normalizedUrl) return null;
    return { displayUrl, normalizedUrl, source: 'organic_deep_search' };
  } catch {
    return null;
  }
}

type ProcessLocalContext = {
  readonly config: AppConfig;
  readonly serp: SerpLocalResult;
  readonly weekBucket: string;
  readonly recentDays: number;
  readonly repo: ProspectRepository;
  readonly psiClient: PageSpeedClient;
  readonly groqClient: GroqClient;
  readonly serpClient: SerpClient;
  readonly searchLocation: string | null;
  readonly searchHl: string | undefined;
  readonly searchGl: string | undefined;
  readonly seedCategory: string | undefined;
  /** Requête google_local exacte (tendance ou grain statique). */
  readonly trendingQuery: string;
  readonly progressTag: string;
  readonly gatekeeperExclusions: GatekeeperExclusion[];
  /** Compteurs mutables (quotas création / refonte). */
  readonly quotaState: LeadQuotaState;
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
    searchLocation,
    searchHl,
    searchGl,
    seedCategory,
    trendingQuery,
    progressTag,
    gatekeeperExclusions,
    quotaState,
  } = ctx;

  if (leadQuotasSatisfied(quotaState)) {
    return null;
  }

  const needCreation = quotaState.creationsFound < quotaState.targetCreation;
  const needRefonte = quotaState.refontesFound < quotaState.targetRefonte;
  const placeKey = stablePlaceKey(serp);

  const recent = await repo.getOutcomeWithinLastDays(placeKey, recentDays);
  if (recent === 'disqualified' || recent === 'diamond') {
    radarVerbose(
      config,
      `${progressTag} ${truncateTitle(serp.title)} · ⊗ SQLite · ${recent === 'diamond' ? 'déjà diamant' : 'déjà disqualifié'} (< ${recentDays} j)`,
    );
    return null;
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

  const skipOrganic = !needCreation && needRefonte && !serp.website?.trim();
  if (skipOrganic && config.RADAR_VERBOSE) {
    radarVerbose(
      config,
      `${progressTag} ${truncateTitle(serp.title)} · ◇ Quota création atteint · pas de recherche organique (besoin refonte)`,
    );
  }

  const resolved = await resolveProspectWebsite(
    serp,
    serpClient,
    searchLocation,
    searchHl,
    searchGl,
    { skipOrganic },
  );

  const seed = seedCategory !== undefined ? { seedCategory } : {};

  /** Diamant création : aucun site propriétaire + réputation Maps (seuils bas) — pas de matrice. */
  if (qualifiesDiamantCreation(serp, resolved)) {
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
    return {
      serp,
      normalizedUrl: null,
      displayUrl: null,
      trendingQuery,
      ...seed,
      conversionBadge: 'DIAMANT_CREATION',
      diamondPain: 'diamant_creation',
      strateScore: {
        total: STRATE_DIAMANT_CREATION_SCORE,
        isDiamantCreation: true,
        matrix: null,
      },
      weekBucket,
      fromCache: false,
      psiStrategy: 'mobile',
      pageSpeed: null,
    };
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
      `${progressTag} ${truncateTitle(serp.title)} · ○ Sans site web résolu — réputation insuffisante pour Diamant création`,
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

  if (config.RADAR_CAMPAIGN_MODE) {
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

  if (config.RADAR_CAMPAIGN_MODE) {
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
  const baseSerp = createRadarSearchClient(config);
  const serpClient = wrapSerpClientWithBudget(baseSerp, serpBudget);

  const psiClient = createPageSpeedClient(config);
  const groqClient = createGroqClient(config);

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
    `\n—— Strate Radar · ${reportCityDisplayName} · quotas création ${targetCreationCount} · refonte ${targetRefonteCount} · plafond requêtes run ${placesRequestsMax} ——`,
  );
  radarVerbose(
    config,
    demandDrivenMode
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

      for (const row of locals) {
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
          searchLocation: cityLocation,
          searchHl: options.search.hl,
          searchGl: options.search.gl,
          seedCategory: seedLabel,
          trendingQuery: q,
          progressTag,
          gatekeeperExclusions,
          quotaState,
        });

        if (line !== null) {
          lines.push(line);
          if (line.conversionBadge === 'DIAMANT_CREATION') {
            quotaState.creationsFound += 1;
          } else if (line.conversionBadge === 'DIAMANT_REFONTE') {
            quotaState.refontesFound += 1;
          }
          radarVerbose(
            config,
            `   … Progression : création ${quotaState.creationsFound}/${quotaState.targetCreation} · refonte ${quotaState.refontesFound}/${quotaState.targetRefonte}`,
          );
        }
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

  radarVerbose(
    config,
    `\n—— Fin · création ${quotaState.creationsFound}/${quotaState.targetCreation} · refonte ${quotaState.refontesFound}/${quotaState.targetRefonte} · ${totalBusinessesScanned} fiches · requêtes ${serpBudget.used}/${placesRequestsMax}${
      serpBudgetExhausted ? ' (plafond budget run)' : ''
    }${placesStoppedEarly ? ' (arrêt HTTP 429)' : ''} ——\n`,
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
    q:
      campaignPair !== undefined
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
    reportCityDisplayName,
    seedCategoriesResolved,
    multiCategoryMode,
    demandDrivenMode,
    trendQueriesResolved,
    placesStoppedEarly,
    ...(placesStopMessage !== undefined ? { placesStopMessage } : {}),
    gatekeeperExclusions,
    ...(campaignPair !== undefined ? { campaign: campaignPair } : {}),
  };
}
