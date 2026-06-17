/**
 * Relance le scrub uniquement sur les fiches 🟠 (needs_review) du dernier export triage.
 *
 * Usage :
 *   npm run scrub:quarantine
 *   npm run scrub:quarantine -- --apply          # persiste websiteResolution en BDD
 *   npm run scrub:quarantine -- --file data/scrub-triage-latest.json
 */

import path from 'node:path';

import { loadScrubConfig } from '../config/index.js';
import { TOP5_GROQ_INTER_REQUEST_DELAY_MS } from '../lib/ai/top5-scanner.js';
import { websiteResolutionForPersistence } from '../lib/scrub-classifier-persistence.js';
import { createRadarSearchClient } from '../lib/google-places.client.js';
import {
  evaluateScrubCandidateWithWebsiteResolver,
  loadScrubCandidates,
  persistScrubClassifierDecision,
  type ScrubCandidate,
} from '../lib/retroactive-scrub.js';
import { sleep } from '../lib/retry.js';
import {
  defaultScrubTriageExportPath,
  isScrubDisqualifiedStatus,
  isScrubNeedsReview,
  isScrubReadyProspect,
  loadScrubTriageExport,
  type ScrubQuarantinePersistedEntry,
  type ScrubTriageEntry,
  refreshScrubTriageAfterQuarantine,
  writeScrubQuarantineExport,
} from '../lib/scrub-triage.js';
import { createSerpManagerWebClient } from '../services/serp/serp-manager.js';
import {
  closeDatabase,
  migrateRadarDiamondSnapshot,
  migrateRadarPlaceLastOutcome,
  migrateRadarScrubClassifierLog,
  openDatabase,
  ProspectRepository,
} from '../storage/index.js';
import { createSupabaseScrubClient } from '../storage/supabase-scrub.js';

function parseArgs(argv: readonly string[]): {
  readonly triagePath: string;
  readonly dryRun: boolean;
  readonly apply: boolean;
  readonly purge: boolean;
} {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const fileFlagIdx = argv.indexOf('--file');
  const triagePath =
    fileFlagIdx >= 0 && argv[fileFlagIdx + 1]
      ? path.resolve(argv[fileFlagIdx + 1]!)
      : positional[0]
        ? path.resolve(positional[0])
        : defaultScrubTriageExportPath();
  const apply = flags.has('--apply');
  return {
    triagePath,
    dryRun: flags.has('--dry-run') || !apply,
    apply,
    purge: flags.has('--purge'),
  };
}

function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

function findScrubCandidate(args: {
  readonly entry: ScrubTriageEntry;
  readonly candidates: readonly ScrubCandidate[];
}): ScrubCandidate | null {
  if (args.entry.slug) {
    const bySlug = args.candidates.find((c) => c.slug === args.entry.slug);
    if (bySlug) return bySlug;
  }

  const needle = normalizeForMatch(args.entry.businessName);
  const byName = args.candidates.filter((c) => normalizeForMatch(c.businessName) === needle);
  if (byName.length === 1) return byName[0]!;
  return null;
}

function formatOutcomeEmoji(status: ScrubTriageEntry['status']): string {
  if (isScrubReadyProspect(status)) return '🟢';
  if (isScrubDisqualifiedStatus(status)) return '🔴';
  if (isScrubNeedsReview(status)) return '🟠';
  return '⚪';
}

async function main(): Promise<void> {
  const { triagePath, dryRun, apply, purge } = parseArgs(process.argv.slice(2));
  const config = loadScrubConfig(process.env, { dryRun: true });

  const databaseUrl = config.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('[SCRUB-QUARANTINE] DATABASE_URL absente.');
    process.exit(1);
  }

  let triage;
  try {
    triage = await loadScrubTriageExport(triagePath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[SCRUB-QUARANTINE] Impossible de lire ${triagePath} : ${msg}`);
    console.error('[SCRUB-QUARANTINE] Lancez d’abord : npm run scrub -- --dry-run');
    process.exit(1);
  }

  if (triage.needsReview.length === 0) {
    console.log(`[SCRUB-QUARANTINE] Aucune fiche 🟠 dans ${triagePath}.`);
    return;
  }

  console.log(
    `[SCRUB-QUARANTINE] ${triage.needsReview.length} fiche(s) 🟠 · source ${triagePath} · ${dryRun ? 'DRY-RUN' : 'APPLY (persist BDD)'}${purge ? ' · purge' : ''}`,
  );

  const supabase = createSupabaseScrubClient(databaseUrl);
  const db = await openDatabase(config.STRATE_RADAR_DB_PATH);
  await migrateRadarPlaceLastOutcome(db);
  await migrateRadarDiamondSnapshot(db);
  await migrateRadarScrubClassifierLog(db);
  const repo = new ProspectRepository(db);
  const serpClient = createRadarSearchClient(config);
  const webSearchClient = createSerpManagerWebClient(config);

  const resolved: ScrubTriageEntry[] = [];
  const stillQuarantine: ScrubTriageEntry[] = [];
  const disqualified: ScrubTriageEntry[] = [];
  const missing: string[] = [];
  const persistedEntries: ScrubQuarantinePersistedEntry[] = [];

  try {
    const candidates = await loadScrubCandidates({
      config,
      repo,
      supabase,
      importShadowExport: false,
    });

    for (let i = 0; i < triage.needsReview.length; i += 1) {
      const entry = triage.needsReview[i]!;
      const candidate = findScrubCandidate({ entry, candidates });

      if (!candidate) {
        missing.push(entry.businessName);
        console.warn(
          `[SCRUB-QUARANTINE] Introuvable · ${entry.businessName}${entry.slug ? ` · ${entry.slug}` : ''}`,
        );
        stillQuarantine.push(entry);
        continue;
      }

      console.log(
        `\n[SCRUB-QUARANTINE] (${i + 1}/${triage.needsReview.length}) · ${candidate.businessName} · ${candidate.slug ?? candidate.auditId ?? '—'}`,
      );
      if (entry.reason) {
        console.log(`[SCRUB-QUARANTINE] ancien motif · ${entry.reason.slice(0, 120)}`);
      }

      const evaluated = await evaluateScrubCandidateWithWebsiteResolver({
        config,
        serp: candidate.serp,
        serpClient,
        webSearchClient,
        searchLocation: candidate.searchLocation,
        fetchTimeoutMs: config.RADAR_FETCH_TIMEOUT_MS,
      });

      const status = evaluated.resolution.status;
      const emoji = formatOutcomeEmoji(status);
      const resultEntry: ScrubTriageEntry = {
        businessName: candidate.businessName,
        slug: candidate.slug ?? null,
        status,
        url: evaluated.resolution.url,
        reason: evaluated.resolution.classificationReason,
      };

      persistedEntries.push({
        slug: candidate.slug ?? null,
        businessName: candidate.businessName,
        auditId: candidate.auditId ?? null,
        placeKey: candidate.placeKey,
        dryRun: dryRun,
        disqualified: evaluated.shouldDisqualify,
        websiteStatus: status,
        resolution: websiteResolutionForPersistence(evaluated.resolution),
      });

      console.log(
        `[SCRUB-QUARANTINE] ${emoji} ${status} · shouldDisqualify=${evaluated.shouldDisqualify}`,
      );
      if (evaluated.resolution.classificationReason) {
        console.log(`[SCRUB-QUARANTINE] reason · ${evaluated.resolution.classificationReason}`);
      }

      if (!dryRun && apply) {
        await persistScrubClassifierDecision({
          repo,
          supabase,
          input: {
            auditId: candidate.auditId ?? null,
            slug: candidate.slug ?? null,
            placeKey: candidate.placeKey,
            businessName: candidate.businessName,
            dryRun: false,
            disqualified: evaluated.shouldDisqualify,
            resolution: evaluated.resolution,
          },
        });
        console.log('[SCRUB-QUARANTINE] BDD · websiteResolution persisté (Supabase + SQLite)');
      }

      if (isScrubNeedsReview(status)) {
        stillQuarantine.push(resultEntry);
      } else if (isScrubDisqualifiedStatus(status) && evaluated.shouldDisqualify) {
        disqualified.push(resultEntry);
        if (!dryRun && apply) {
          if (candidate.auditId) {
            await supabase.revokeAudit(candidate.auditId);
            console.log(`[SCRUB-QUARANTINE] Supabase · revoked · ${candidate.auditId}`);
            if (purge) {
              await supabase.purgeRevokedDiamondAudit(candidate.auditId);
            }
          }
          await repo.recordPlaceOutcome(candidate.placeKey, 'disqualified');
        } else if (evaluated.shouldDisqualify) {
          console.log('[SCRUB-QUARANTINE] DRY-RUN · serait disqualifié. Relance avec --apply.');
        }
      } else {
        resolved.push(resultEntry);
      }

      if (i < triage.needsReview.length - 1 && TOP5_GROQ_INTER_REQUEST_DELAY_MS > 0) {
        await sleep(TOP5_GROQ_INTER_REQUEST_DELAY_MS);
      }
    }

    const exportPath = await writeScrubQuarantineExport({
      outputDir: path.join(process.cwd(), 'data'),
      dryRun,
      persisted: apply && !dryRun,
      entries: persistedEntries,
    });
    console.log(`\n[SCRUB-QUARANTINE] Export → ${exportPath}`);

    if (apply && !dryRun && resolved.length > 0) {
      const updatedTriagePath = await refreshScrubTriageAfterQuarantine({
        triagePath,
        quarantinePath: exportPath,
      });
      console.log(`[SCRUB-QUARANTINE] Triage mis à jour · ${resolved.length} 🟠 → 🟢 · ${updatedTriagePath}`);
    }
  } finally {
    await supabase.close();
    await closeDatabase(db);
  }

  console.log('\n[SCRUB-QUARANTINE] ═══ Bilan relance quarantaine ═══');
  console.log(`🟢 Résolus (${resolved.length})`);
  for (const e of resolved) {
    console.log(`  · ${e.businessName} · ${e.status}`);
  }
  console.log(`🔴 Disqualifiés (${disqualified.length})`);
  for (const e of disqualified) {
    console.log(`  · ${e.businessName} · ${e.status}`);
  }
  console.log(`🟠 Encore en quarantaine (${stillQuarantine.length})`);
  for (const e of stillQuarantine) {
    const reason = e.reason ? ` — ${e.reason.slice(0, 100)}` : '';
    console.log(`  · ${e.businessName}${reason}`);
  }
  if (missing.length > 0) {
    console.log(`⚠️ Introuvables (${missing.length}) : ${missing.join(', ')}`);
  }
  if (dryRun && resolved.length > 0) {
    console.log('\n[SCRUB-QUARANTINE] Pour persister les 🟢 en BDD : npm run scrub:quarantine -- --apply');
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
