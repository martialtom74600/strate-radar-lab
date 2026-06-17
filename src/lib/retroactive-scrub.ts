import fs from 'node:fs/promises';
import path from 'node:path';

import type { AppConfig } from '../config/index.js';
import { stablePlaceKey } from './place-key.js';
import type { ShadowSiteExportRecord } from '../pipeline/shadow-export.js';
import type { SerpClient } from '../services/serp/search-client.types.js';
import type { SerpLocalResult } from '../services/serp/schemas.js';
import type { WebSearchClient } from '../services/serp/web-search.types.js';
import { resolveProspectCity } from './search-location-hint.js';
import {
  evaluateDiamondWebsitePresence,
  shouldDisqualifyWebsitePresenceForScrub,
} from './diamond-website-detection.js';
import { TOP5_GROQ_INTER_REQUEST_DELAY_MS } from './ai/top5-scanner.js';
import { sleep } from './retry.js';
import {
  isScrubDisqualifiedStatus,
  isScrubNeedsReview,
  isScrubReadyProspect,
  printScrubTriageSummary,
  writeScrubTriageExport,
  type ScrubTriageEntry,
} from './scrub-triage.js';
import {
  persistClassifierDecision,
  type ScrubClassifierPersistInput,
} from './scrub-classifier-persistence.js';
import type { DiamondSnapshotUpsert, ProspectRepository, ScrubCandidateRow } from '../storage/index.js';
import {
  createSupabaseScrubClient,
  type SupabaseScrubCandidate,
  type SupabaseScrubClient,
} from '../storage/supabase-scrub.js';
import { isSerpQuotasExhaustedError } from '../services/serp/serp-manager.js';
import { googleMapsRawToSerp } from './diamond-snapshot.js';

function parseSerpRow(json: string): SerpLocalResult | null {
  try {
    const parsed = JSON.parse(json) as SerpLocalResult;
    if (!parsed || typeof parsed.title !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function conversionBadgeToWebsiteStatus(
  badge: ShadowSiteExportRecord['conversion_badge'],
): 'none' | 'presence_only' | null {
  if (badge === 'DIAMANT_CREATION') return 'none';
  if (badge === 'DIAMANT_PRESENCE') return 'presence_only';
  return null;
}

/** Place IDs fictifs du mode simulation (`ChIJdiam…`). */
export function isSimulationMockPlaceKey(placeKey: string): boolean {
  const id = placeKey.startsWith('pid:') ? placeKey.slice(4) : placeKey;
  return /^ChIJdiam/i.test(id);
}

function placeIdFromPlaceKey(placeKey: string): string | null {
  if (!placeKey.startsWith('pid:')) return null;
  const id = placeKey.slice(4).trim();
  return id.length > 0 ? id : null;
}

export async function importShadowExportSnapshots(
  repo: ProspectRepository,
  exportPath: string,
  searchLocationFallback: string,
): Promise<number> {
  const resolved = path.resolve(process.cwd(), exportPath);
  let raw: string;
  try {
    raw = await fs.readFile(resolved, 'utf8');
  } catch {
    return 0;
  }

  let payload: { diamonds?: ShadowSiteExportRecord[] };
  try {
    payload = JSON.parse(raw) as { diamonds?: ShadowSiteExportRecord[] };
  } catch {
    return 0;
  }

  const diamonds = payload.diamonds ?? [];
  if (diamonds.length === 0) {
    console.log(`[SCRUB] Shadow export vide · ${exportPath} (0 diamant création/présence)`);
    return 0;
  }

  let imported = 0;
  for (const diamond of diamonds) {
    const websiteStatus = conversionBadgeToWebsiteStatus(diamond.conversion_badge);
    if (!websiteStatus) continue;

    const serp = googleMapsRawToSerp(diamond.google_maps_raw);
    const placeKey = stablePlaceKey(serp);
    const conversionBadge =
      diamond.conversion_badge === 'DIAMANT_PRESENCE'
        ? 'DIAMANT_PRESENCE'
        : 'DIAMANT_CREATION';
    const snapshot: DiamondSnapshotUpsert = {
      placeKey,
      businessName: serp.title,
      websiteStatus,
      conversionBadge,
      searchLocation: searchLocationFallback,
      serpRow: serp,
    };
    await repo.upsertDiamondSnapshot(snapshot);
    await repo.recordPlaceOutcome(placeKey, 'diamond');
    imported += 1;
  }
  return imported;
}

/** Même cascade que le pipeline journalier (`evaluateDiamondWebsitePresence`). */
export async function evaluateScrubCandidateWithWebsiteResolver(args: {
  readonly config: AppConfig;
  readonly serp: SerpLocalResult;
  readonly serpClient: SerpClient;
  readonly webSearchClient: WebSearchClient | null;
  readonly searchLocation: string | null;
  readonly fetchTimeoutMs: number;
}): Promise<{
  readonly shouldDisqualify: boolean;
  readonly resolution: Awaited<ReturnType<typeof evaluateDiamondWebsitePresence>>['resolution'];
  readonly ownerSite: Awaited<ReturnType<typeof evaluateDiamondWebsitePresence>>['ownerSite'];
}> {
  const websiteOut = await evaluateDiamondWebsitePresence({
    config: args.config,
    serp: args.serp,
    serpClient: args.serpClient,
    webSearchClient: args.webSearchClient,
    searchLocation: args.searchLocation,
    fetchTimeoutMs: args.fetchTimeoutMs,
    logPrefix: '[SCRUB] ',
  });

  return {
    shouldDisqualify: shouldDisqualifyWebsitePresenceForScrub(websiteOut.resolution),
    resolution: websiteOut.resolution,
    ownerSite: websiteOut.ownerSite,
  };
}

function formatScrubResolutionLog(
  title: string,
  resolution: Awaited<ReturnType<typeof evaluateDiamondWebsitePresence>>['resolution'],
): string {
  const reason =
    resolution.classificationReason?.trim() ?
      ` · IA: ${resolution.classificationReason.slice(0, 100)}`
    : '';
  if (resolution.status === 'owner_site') {
    const source = resolution.source ?? '—';
    const conf =
      typeof resolution.confidence === 'number'
        ? ` · conf ${resolution.confidence.toFixed(2)}`
        : '';
    const latency =
      resolution.classifierAudit?.latencyMs !== undefined
        ? ` · ${resolution.classifierAudit.latencyMs}ms`
        : '';
    return `${title} · owner_site · ${resolution.url ?? '—'} (${source}${conf}${latency})${reason}`;
  }
  if (resolution.status === 'corporate_parent') {
    const latency =
      resolution.classifierAudit?.latencyMs !== undefined
        ? ` · ${resolution.classifierAudit.latencyMs}ms`
        : '';
    return `${title} · corporate_parent · rejeté${resolution.presencePlatform ? ` (${resolution.presencePlatform})` : ''}${latency}${reason}`;
  }
  if (resolution.status === 'presence_only') {
    const latency =
      resolution.classifierAudit?.latencyMs !== undefined
        ? ` · ${resolution.classifierAudit.latencyMs}ms`
        : '';
    return `${title} · presence_only · conservé${resolution.presencePlatform ? ` (${resolution.presencePlatform})` : ''}${latency}${reason}`;
  }
  if (resolution.status === 'needs_review') {
    const latency =
      resolution.classifierAudit?.latencyMs !== undefined
        ? ` · ${resolution.classifierAudit.latencyMs}ms`
        : '';
    return `${title} · needs_review · quarantaine 🟠${resolution.url ? ` · ${resolution.url}` : ''}${latency}${reason}`;
  }
  return `${title} · none · conservé${reason}`;
}

function parseScrubCandidateSerp(candidate: {
  readonly serpRowJson: string;
}): SerpLocalResult | null {
  return parseSerpRow(candidate.serpRowJson);
}

export type ScrubCandidate = {
  readonly auditId?: string;
  readonly slug?: string;
  readonly placeKey: string;
  readonly businessName: string;
  readonly searchLocation: string | null;
  readonly serp: SerpLocalResult;
};

function scrubCandidateFromSqliteRow(row: ScrubCandidateRow): ScrubCandidate | null {
  const serp = parseSerpRow(row.serpRowJson);
  if (!serp) return null;
  return {
    placeKey: row.placeKey,
    businessName: row.businessName,
    searchLocation: row.searchLocation,
    serp,
  };
}

function scrubCandidateFromSupabase(row: SupabaseScrubCandidate): ScrubCandidate {
  return {
    auditId: row.auditId,
    slug: row.slug,
    placeKey: row.placeKey,
    businessName: row.businessName,
    searchLocation: row.searchLocation,
    serp: row.serp,
  };
}

export async function persistScrubClassifierDecision(args: {
  readonly repo: ProspectRepository;
  readonly supabase: SupabaseScrubClient | null;
  readonly input: ScrubClassifierPersistInput;
}): Promise<void> {
  await persistClassifierDecision(args);
}

export async function loadScrubCandidates(args: {
  readonly config: AppConfig;
  readonly repo: ProspectRepository;
  readonly supabase: SupabaseScrubClient | null;
  readonly importShadowExport: boolean;
}): Promise<readonly ScrubCandidate[]> {
  const { config, repo, supabase, importShadowExport } = args;
  const useSupabase = supabase !== null;

  if (!useSupabase && importShadowExport) {
    await importShadowExportSnapshots(
      repo,
      config.RADAR_SHADOW_EXPORT_PATH,
      config.RADAR_SEARCH_LOCATION,
    );
  }

  if (useSupabase) {
    const rows = await supabase.listCandidates(config.RADAR_SEARCH_LOCATION);
    return rows.map(scrubCandidateFromSupabase);
  }

  const rows = await repo.listScrubCandidates();
  const candidates: ScrubCandidate[] = [];
  for (const row of rows) {
    const candidate = scrubCandidateFromSqliteRow(row);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

async function analyzeScrubCandidates(args: {
  readonly candidates: readonly ScrubCandidate[];
  readonly config: AppConfig;
  readonly repo: ProspectRepository;
  readonly serpClient: SerpClient;
  readonly webSearchClient: WebSearchClient | null;
  readonly supabase: SupabaseScrubClient | null;
  readonly dryRun: boolean;
}): Promise<{
  readonly disqualified: number;
  readonly organicFetched: number;
  readonly serpQuotasExhausted: boolean;
  readonly serpStopMessage?: string;
  readonly triage: {
    readonly ready: readonly ScrubTriageEntry[];
    readonly disqualified: readonly ScrubTriageEntry[];
    readonly needsReview: readonly ScrubTriageEntry[];
  };
}> {
  let disqualified = 0;
  let organicFetched = 0;
  let serpQuotasExhausted = false;
  let serpStopMessage: string | undefined;
  const ready: ScrubTriageEntry[] = [];
  const disqualifiedEntries: ScrubTriageEntry[] = [];
  const needsReview: ScrubTriageEntry[] = [];

  const pushTriage = (candidate: ScrubCandidate, evaluated: Awaited<ReturnType<typeof evaluateScrubCandidateWithWebsiteResolver>>) => {
    const entry: ScrubTriageEntry = {
      businessName: candidate.businessName,
      slug: candidate.slug ?? null,
      status: evaluated.resolution.status,
      url: evaluated.resolution.url,
      reason: evaluated.resolution.classificationReason,
    };
    if (isScrubDisqualifiedStatus(evaluated.resolution.status) && evaluated.shouldDisqualify) {
      disqualifiedEntries.push(entry);
    } else if (isScrubNeedsReview(evaluated.resolution.status)) {
      needsReview.push(entry);
    } else if (isScrubReadyProspect(evaluated.resolution.status)) {
      ready.push(entry);
    } else {
      needsReview.push({
        ...entry,
        reason: entry.reason ?? `Statut ${evaluated.resolution.status} — triage manuel recommandé.`,
      });
    }
  };

  for (const candidate of args.candidates) {
    if (serpQuotasExhausted) break;
    const serp = candidate.serp;

    if (args.config.simulation) {
      console.warn(`[SCRUB] ${serp.title} · simulation — résolution web ignorée`);
      continue;
    }

    console.log(
      `[SCRUB] Analyse · ${serp.title} · ville ${resolveProspectCity(serp, candidate.searchLocation) ?? '—'} · resolveProspectWebsitePresence…`,
    );
    let evaluated;
    try {
      evaluated = await evaluateScrubCandidateWithWebsiteResolver({
        config: args.config,
        serp,
        serpClient: args.serpClient,
        webSearchClient: args.webSearchClient,
        searchLocation: candidate.searchLocation,
        fetchTimeoutMs: args.config.RADAR_FETCH_TIMEOUT_MS,
      });
    } catch (e) {
      if (isSerpQuotasExhaustedError(e)) {
        serpQuotasExhausted = true;
        serpStopMessage = e.message;
        console.error(
          '[SCRUB] FATAL: Quotas SERP (Serper + Brave) épuisés — arrêt scrub pour éviter les coûts API inutiles.',
        );
        break;
      }
      throw e;
    }
    organicFetched += 1;

    console.log(`[SCRUB] ${formatScrubResolutionLog(serp.title, evaluated.resolution)}`);

    pushTriage(candidate, evaluated);

    await persistScrubClassifierDecision({
      repo: args.repo,
      supabase: args.supabase,
      input: {
        auditId: candidate.auditId ?? null,
        slug: candidate.slug ?? null,
        placeKey: candidate.placeKey,
        businessName: candidate.businessName,
        dryRun: args.dryRun,
        disqualified: evaluated.shouldDisqualify,
        resolution: evaluated.resolution,
      },
    });

    if (!evaluated.shouldDisqualify) {
      if (!serpQuotasExhausted && TOP5_GROQ_INTER_REQUEST_DELAY_MS > 0) {
        await sleep(TOP5_GROQ_INTER_REQUEST_DELAY_MS);
      }
      continue;
    }

    const slugHint = candidate.slug ? ` · ${candidate.slug}` : '';
    if (evaluated.resolution.status === 'corporate_parent') {
      console.log(
        `[SCRUB] Rejeté : Appartient à un réseau/site parent (corporate_parent) · ${serp.title}${slugHint}`,
      );
    }
    console.log(`[SCRUB] Disqualifié : ${serp.title}${slugHint}`);
    if (!args.dryRun) {
      if (candidate.auditId && args.supabase) {
        await args.supabase.revokeAudit(candidate.auditId);
      }
      await args.repo.recordPlaceOutcome(candidate.placeKey, 'disqualified');
    }
    disqualified += 1;

    if (!serpQuotasExhausted && TOP5_GROQ_INTER_REQUEST_DELAY_MS > 0) {
      await sleep(TOP5_GROQ_INTER_REQUEST_DELAY_MS);
    }
  }

  printScrubTriageSummary({
    ready,
    disqualified: disqualifiedEntries,
    needsReview,
  });

  const triageExportPath = await writeScrubTriageExport({
    outputDir: path.join(process.cwd(), 'data'),
    dryRun: args.dryRun,
    ready,
    disqualified: disqualifiedEntries,
    needsReview,
  });
  console.log(`[SCRUB] Export triage → ${triageExportPath}`);

  return {
    disqualified,
    organicFetched,
    serpQuotasExhausted,
    ...(serpStopMessage !== undefined ? { serpStopMessage } : {}),
    triage: { ready, disqualified: disqualifiedEntries, needsReview },
  };
}
export type RunRetroactiveScrubOptions = {
  readonly config: AppConfig;
  readonly repo: ProspectRepository;
  readonly serpClient: SerpClient;
  readonly webSearchClient: WebSearchClient | null;
  readonly supabase: SupabaseScrubClient | null;
  readonly dryRun: boolean;
  readonly importShadowExport: boolean;
};

export type RetroactiveScrubResult = {
  readonly analyzed: number;
  readonly disqualified: number;
  readonly importedFromShadow: number;
  readonly organicFetched: number;
  readonly activeDiamonds: number;
  readonly snapshotsBefore: number;
  readonly orphansBackfilled: number;
  readonly orphansSkippedMock: number;
  readonly orphansFailed: number;
  readonly supabasePublished: number;
  readonly dataSource: 'supabase' | 'sqlite';
  readonly serpQuotasExhausted: boolean;
  readonly serpStopMessage?: string;
  readonly triageReady: number;
  readonly triageDisqualified: number;
  readonly triageNeedsReview: number;
};

async function backfillOrphanDiamondSnapshots(args: {
  readonly repo: ProspectRepository;
  readonly serpClient: SerpClient;
  readonly searchLocation: string;
  readonly dryRun: boolean;
}): Promise<{
  readonly backfilled: number;
  readonly skippedMock: number;
  readonly failed: number;
}> {
  const orphans = await args.repo.listOrphanDiamondPlaceKeys();
  if (orphans.length === 0) {
    return { backfilled: 0, skippedMock: 0, failed: 0 };
  }

  console.log(
    `[SCRUB] ${orphans.length} diamant(s) sans snapshot — backfill Place Details…`,
  );

  let backfilled = 0;
  let skippedMock = 0;
  let failed = 0;

  for (const placeKey of orphans) {
    if (isSimulationMockPlaceKey(placeKey)) {
      skippedMock += 1;
      continue;
    }

    const placeId = placeIdFromPlaceKey(placeKey);
    if (!placeId) {
      failed += 1;
      console.warn(`[SCRUB] Backfill ignoré · clé sans place_id · ${placeKey}`);
      continue;
    }

    const serp = await args.serpClient.fetchPlaceLocalResult(placeId);
    if (!serp) {
      failed += 1;
      console.warn(`[SCRUB] Backfill échoué · Place Details introuvable · ${placeKey}`);
      continue;
    }

    if (!args.dryRun) {
      await args.repo.upsertDiamondSnapshot({
        placeKey,
        businessName: serp.title,
        websiteStatus: 'none',
        conversionBadge: 'DIAMANT_CREATION',
        searchLocation: args.searchLocation,
        serpRow: serp,
      });
    }
    backfilled += 1;
    console.log(`[SCRUB] Backfill OK · ${serp.title}`);
  }

  if (skippedMock > 0) {
    console.log(
      `[SCRUB] ${skippedMock} diamant(s) simulation (ChIJdiam…) ignorés — lancez un run radar live ou restaurez la SQLite Actions`,
    );
  }

  return { backfilled, skippedMock, failed };
}

export async function runRetroactiveScrub(
  options: RunRetroactiveScrubOptions,
): Promise<RetroactiveScrubResult> {
  const { config, repo, serpClient, supabase, dryRun, importShadowExport } = options;
  const useSupabase = supabase !== null;

  let supabasePublished = 0;
  if (useSupabase) {
    supabasePublished = await supabase.countPublishedCreationPresence();
    console.log(
      `[SCRUB] Source Supabase · ${supabasePublished} audit(s) publié(s) (création / présence)`,
    );
  }

  const activeDiamonds = await repo.countActiveDiamondOutcomes();
  const snapshotsBefore = await repo.countDiamondSnapshots();
  if (!useSupabase) {
    console.log(
      `[SCRUB] Source SQLite · ${activeDiamonds} diamant(s) actif(s) · ${snapshotsBefore} snapshot(s)`,
    );
  } else if (activeDiamonds > 0 || snapshotsBefore > 0) {
    console.log(
      `[SCRUB] SQLite locale (cache) · ${activeDiamonds} outcome(s) · ${snapshotsBefore} snapshot(s)`,
    );
  }

  let importedFromShadow = 0;
  let backfill = { backfilled: 0, skippedMock: 0, failed: 0 };
  let candidates: ScrubCandidate[] = [];

  if (useSupabase) {
    candidates = [...(await loadScrubCandidates({
      config,
      repo,
      supabase,
      importShadowExport: false,
    }))];
  } else {
    if (importShadowExport) {
      importedFromShadow = await importShadowExportSnapshots(
        repo,
        config.RADAR_SHADOW_EXPORT_PATH,
        config.RADAR_SEARCH_LOCATION,
      );
      if (importedFromShadow > 0) {
        console.log(
          `[SCRUB] Import shadow export · ${importedFromShadow} snapshot(s) depuis ${config.RADAR_SHADOW_EXPORT_PATH}`,
        );
      }
    }
    backfill = await backfillOrphanDiamondSnapshots({
      repo,
      serpClient,
      searchLocation: config.RADAR_SEARCH_LOCATION,
      dryRun,
    });
    candidates = [...(await loadScrubCandidates({
      config,
      repo,
      supabase: null,
      importShadowExport: false,
    }))];
  }

  console.log(`[SCRUB] ${candidates.length} dossier(s) éligible(s) (création / présence)`);

  const { disqualified, organicFetched, serpQuotasExhausted, serpStopMessage, triage } =
    await analyzeScrubCandidates({
    candidates,
    config,
    repo,
    serpClient,
    webSearchClient: options.webSearchClient,
    supabase,
    dryRun,
  });

  return {
    analyzed: candidates.length,
    disqualified,
    importedFromShadow,
    organicFetched,
    activeDiamonds,
    snapshotsBefore,
    orphansBackfilled: backfill.backfilled,
    orphansSkippedMock: backfill.skippedMock,
    orphansFailed: backfill.failed,
    supabasePublished,
    dataSource: useSupabase ? 'supabase' : 'sqlite',
    serpQuotasExhausted,
    ...(serpStopMessage !== undefined ? { serpStopMessage } : {}),
    triageReady: triage.ready.length,
    triageDisqualified: triage.disqualified.length,
    triageNeedsReview: triage.needsReview.length,
  };
}
