import type { AppConfig } from '../config/index.js';
import type { RadarPipelineResult } from '../pipeline/radar-pipeline.js';
import { WEB_SEARCH_BUDGET_EXHAUSTED_REASON } from '../services/serp/web-search-budget.js';
import { stablePlaceKey } from './place-key.js';
import type {
  StudioIngestFailure,
  StudioIngestSuccess,
} from './strate-studio/audit-ingest.js';

export type RunLeadSummary = {
  readonly name: string;
  readonly badge: string;
  readonly displayUrl: string | null;
  readonly webStatus: string | null;
  readonly presencePlatform: string | null;
  readonly webSource: string | null;
  readonly strateScore: number | null;
  readonly publicAuditUrl: string | null;
  readonly trendingQuery: string;
};

export type RunIngestSummary = {
  readonly configured: boolean;
  readonly successCount: number;
  readonly failureCount: number;
  readonly skippedRefonteCount: number;
  readonly failures: readonly {
    readonly name: string;
    readonly status: number;
    readonly message: string;
    readonly slug: string;
  }[];
  readonly successes: readonly {
    readonly name: string;
    readonly publicUrl: string;
  }[];
};

export type RunTelemetryPayload = {
  readonly lastRunIso: string;
  readonly workflow: string;
  readonly campaign: { readonly city: string; readonly category: string } | null;
  readonly diamondsFound: number;
  readonly creationsFound: number;
  readonly refontesFound: number;
  readonly targetCreationCount: number;
  readonly targetRefonteCount: number;
  readonly totalBusinessesScanned: number;
  readonly placesRequestsUsed: number;
  readonly placesRequestsMax: number;
  readonly webSearchRequestsUsed: number;
  readonly webSearchRequestsMax: number;
  readonly webSearchConfigured: boolean;
  readonly webSearchBootStatus: string;
  readonly placesStoppedEarly: boolean;
  readonly placesStopMessage: string | null;
  readonly placesBudgetExhausted: boolean;
  readonly searchLocation: string | null;
  readonly searchQuery: string;
  readonly weekBucket: string;
  readonly demandDrivenMode: boolean;
  readonly multiCategoryMode: boolean;
  readonly seedCategories: readonly string[];
  readonly trendQueries: readonly string[];
  readonly gatekeeperExclusionCount: number;
  readonly gatekeeperExclusions: readonly { readonly name: string; readonly reason: string }[];
  readonly webSearchIssues: readonly { readonly name: string; readonly note: string }[];
  readonly ingest: RunIngestSummary;
  readonly leads: readonly RunLeadSummary[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly targetedMode: boolean;
  readonly targetedMisses: readonly string[];
  readonly scoreNearMisses: readonly {
    readonly name: string;
    readonly strateScore: number | null;
    readonly threshold: number;
    readonly displayUrl: string | null;
    readonly reason: string;
  }[];
  readonly scoreNearMissesTotal: number;
  readonly creationHuntMode: boolean;
  readonly creationHuntZones?: readonly string[];
  readonly creationHuntSectors?: readonly string[];
  readonly creationHuntExpansionRing?: number;
  readonly creationHuntWeeklyStats?: {
    readonly topSectors: readonly { readonly sector: string; readonly convRate: number }[];
    readonly activeZones: number;
    readonly stagnantZones: number;
    readonly stagnantSectors: readonly string[];
  };
};

function titleByPlaceKey(result: RadarPipelineResult): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of result.lines) {
    map.set(stablePlaceKey(line.serp), line.serp.title);
  }
  return map;
}

function collectWebSearchIssues(
  result: RadarPipelineResult,
): { readonly name: string; readonly note: string }[] {
  const out: { name: string; note: string }[] = [];
  for (const line of result.lines) {
    const attempt = line.websiteResolution?.attempts.find((a) => a.layer === 'web_search');
    const note = attempt?.note?.trim() ?? '';
    if (!note) continue;
    if (
      note.includes('Plafond recherche web') ||
      note.includes(WEB_SEARCH_BUDGET_EXHAUSTED_REASON)
    ) {
      continue;
    }
    if (
      note.startsWith('HTTP ') ||
      note.includes('dailyLimitExceeded') ||
      note.includes('quotaExceeded')
    ) {
      out.push({ name: line.serp.title, note });
    }
  }
  return out;
}

function buildWarningsAndErrors(args: {
  readonly result: RadarPipelineResult;
  readonly ingest: RunIngestSummary;
  readonly webSearchIssues: readonly { readonly name: string; readonly note: string }[];
  readonly targetedMisses: readonly string[];
}): { warnings: string[]; errors: string[] } {
  const { result, ingest, webSearchIssues, targetedMisses } = args;
  const warnings: string[] = [];
  const errors: string[] = [];

  if (result.targetedMode) {
    warnings.push('Mode audit ciblé (noms précis — pas de prospection large).');
  }
  for (const miss of targetedMisses) {
    errors.push(`Cible introuvable sur Google Places : « ${miss} »`);
  }
  for (const miss of result.targetProspectMisses ?? []) {
    if (!targetedMisses.includes(miss)) {
      errors.push(`Cible introuvable sur Google Places : « ${miss} »`);
    }
  }

  if (result.placesStoppedEarly) {
    warnings.push(
      `Google Places interrompu (quota / HTTP 429)${result.placesStopMessage ? ` : ${result.placesStopMessage}` : ''}`,
    );
  }
  if (result.placesBudgetExhausted) {
    warnings.push(
      `Plafond requêtes Places du run atteint (${result.placesRequestsUsed}/${result.placesRequestsMax}).`,
    );
  }
  if (
    result.webSearchRequestsMax > 0 &&
    result.webSearchRequestsUsed >= result.webSearchRequestsMax
  ) {
    warnings.push(
      `Plafond recherche web du run atteint (${result.webSearchRequestsUsed}/${result.webSearchRequestsMax}).`,
    );
  }
  if (!result.targetedMode && result.creationsFound < result.targetCreationCount) {
    if (!result.creationHuntMode) {
      warnings.push(
        `Quota création non atteint : ${result.creationsFound}/${result.targetCreationCount}.`,
      );
    }
  }
  if (!result.targetedMode && result.refontesFound < result.targetRefonteCount) {
    warnings.push(
      `Quota refonte non atteint : ${result.refontesFound}/${result.targetRefonteCount}.`,
    );
  }
  if (
    result.creationHuntMode &&
    result.creationsFound < result.targetCreationCount &&
    (result.creationHuntExpansionRing ?? 0) >= 0
  ) {
    const zones = result.creationHuntZones?.join(' · ') ?? result.search.location ?? '—';
    warnings.push(
      `Creation Hunt : ${result.creationsFound}/${result.targetCreationCount} après anneau ${result.creationHuntExpansionRing ?? 0} — zones : ${zones}.`,
    );
  }
  if (result.gatekeeperExclusions.length > 0) {
    warnings.push(`${result.gatekeeperExclusions.length} fiche(s) écartée(s) par le Gatekeeper.`);
  }
  const nearMissCount = result.scoreNearMissesTotal ?? result.scoreNearMisses.length;
  if (nearMissCount > 0 && !result.creationHuntMode) {
    const omitted = nearMissCount - result.scoreNearMisses.length;
    warnings.push(
      omitted > 0
        ? `${nearMissCount} fiche(s) sous seuil refonte (${result.scoreNearMisses.length} plus proches du seuil ci-dessous · +${omitted} dans rapport_matinal.md).`
        : `${nearMissCount} fiche(s) sous seuil refonte (détail ci-dessous).`,
    );
  }

  for (const issue of webSearchIssues) {
    errors.push(`Recherche web · ${issue.name} · ${issue.note}`);
  }
  for (const f of ingest.failures) {
    errors.push(`Ingest vitrine · ${f.name} · HTTP ${f.status} · ${f.message}`);
  }
  if (!ingest.configured && ingest.successCount === 0 && result.lines.some((l) => l.conversionBadge === 'DIAMANT_CREATION' || l.conversionBadge === 'DIAMANT_PRESENCE')) {
    warnings.push('RADAR_INGEST_SECRET absent — aucun audit publié vers la vitrine.');
  }

  return { warnings, errors };
}

export function buildRunTelemetry(args: {
  readonly result: RadarPipelineResult;
  readonly ingestSuccesses: ReadonlyMap<string, StudioIngestSuccess>;
  readonly ingestFailures: readonly StudioIngestFailure[];
  readonly config: Pick<AppConfig, 'RADAR_INGEST_SECRET'>;
  readonly workflow: string;
  readonly targetedMisses?: readonly string[];
}): RunTelemetryPayload {
  const { result, ingestSuccesses, ingestFailures, config, workflow, targetedMisses = [] } = args;
  const titleMap = titleByPlaceKey(result);

  const diamondLines = result.lines.filter(
    (l) =>
      l.conversionBadge === 'DIAMANT_CREATION' ||
      l.conversionBadge === 'DIAMANT_PRESENCE' ||
      l.conversionBadge === 'DIAMANT_REFONTE',
  );

  const leads: RunLeadSummary[] = diamondLines.map((line) => {
    const pk = stablePlaceKey(line.serp);
    const vitrine = ingestSuccesses.get(pk);
    const wr = line.websiteResolution;
    return {
      name: line.serp.title,
      badge: line.conversionBadge ?? '—',
      displayUrl: line.displayUrl,
      webStatus: wr?.status ?? null,
      presencePlatform: wr?.presencePlatform ?? null,
      webSource: wr?.source ?? null,
      strateScore: line.strateScore?.total ?? null,
      publicAuditUrl: vitrine?.publicUrl ?? null,
      trendingQuery: line.trendingQuery,
    };
  });

  const skippedRefonteCount = result.lines.filter(
    (l) => l.conversionBadge === 'DIAMANT_REFONTE',
  ).length;

  const ingest: RunIngestSummary = {
    configured: Boolean(config.RADAR_INGEST_SECRET?.trim()),
    successCount: ingestSuccesses.size,
    failureCount: ingestFailures.length,
    skippedRefonteCount,
    failures: ingestFailures.map((f) => ({
      name: titleMap.get(f.placeKey) ?? f.placeKey,
      status: f.status,
      message: f.message,
      slug: f.slug,
    })),
    successes: [...ingestSuccesses.values()].map((s) => ({
      name: titleMap.get(s.placeKey) ?? s.placeKey,
      publicUrl: s.publicUrl,
    })),
  };

  const webSearchIssues = collectWebSearchIssues(result);
  const { warnings, errors } = buildWarningsAndErrors({
    result,
    ingest,
    webSearchIssues,
    targetedMisses,
  });

  return {
    lastRunIso: result.generatedAtIso,
    workflow,
    campaign: result.campaign ?? null,
    diamondsFound: result.creationsFound + result.refontesFound,
    creationsFound: result.creationsFound,
    refontesFound: result.refontesFound,
    targetCreationCount: result.targetCreationCount,
    targetRefonteCount: result.targetRefonteCount,
    totalBusinessesScanned: result.totalBusinessesScanned,
    placesRequestsUsed: result.placesRequestsUsed,
    placesRequestsMax: result.placesRequestsMax,
    webSearchRequestsUsed: result.webSearchRequestsUsed,
    webSearchRequestsMax: result.webSearchRequestsMax,
    webSearchConfigured: result.webSearchConfigured,
    webSearchBootStatus: result.webSearchBootStatus,
    placesStoppedEarly: result.placesStoppedEarly,
    placesStopMessage: result.placesStopMessage ?? null,
    placesBudgetExhausted: result.placesBudgetExhausted,
    searchLocation: result.search.location ?? null,
    searchQuery: result.search.q,
    weekBucket: result.weekBucket,
    demandDrivenMode: result.demandDrivenMode,
    multiCategoryMode: result.multiCategoryMode,
    seedCategories: result.seedCategoriesResolved,
    trendQueries: result.trendQueriesResolved,
    gatekeeperExclusionCount: result.gatekeeperExclusions.length,
    gatekeeperExclusions: result.gatekeeperExclusions.slice(0, 30),
    webSearchIssues,
    ingest,
    leads,
    warnings,
    errors,
    targetedMode: result.targetedMode,
    targetedMisses: [...new Set([...targetedMisses, ...(result.targetProspectMisses ?? [])])],
    scoreNearMisses: result.scoreNearMisses ?? [],
    scoreNearMissesTotal: result.scoreNearMissesTotal ?? result.scoreNearMisses.length,
    creationHuntMode: result.creationHuntMode,
    ...(result.creationHuntZones !== undefined ? { creationHuntZones: result.creationHuntZones } : {}),
    ...(result.creationHuntSectors !== undefined
      ? { creationHuntSectors: result.creationHuntSectors }
      : {}),
    ...(result.creationHuntExpansionRing !== undefined
      ? { creationHuntExpansionRing: result.creationHuntExpansionRing }
      : {}),
    ...(result.creationHuntWeeklyStats !== undefined
      ? { creationHuntWeeklyStats: result.creationHuntWeeklyStats }
      : {}),
  };
}
