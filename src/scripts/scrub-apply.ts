/**
 * Applique le dry-run scrub sans relancer l’analyse API.
 *
 * 1. Révoque les 🔴 listés dans scrub-triage-latest.json
 * 2. Persiste les 🟠 re-joués via scrub:quarantine (scrub-quarantine-latest.json)
 *
 * Usage :
 *   npm run scrub:apply -- --dry-run
 *   npm run scrub:apply
 *   npm run scrub:apply -- --purge
 */

import { access } from 'node:fs/promises';
import path from 'node:path';

import { loadScrubConfig } from '../config/index.js';
import { loadScrubCandidates, type ScrubCandidate } from '../lib/retroactive-scrub.js';
import {
  defaultScrubQuarantineExportPath,
  defaultScrubTriageExportPath,
  isScrubDisqualifiedStatus,
  loadScrubQuarantineExport,
  loadScrubTriageExport,
  refreshScrubTriageAfterQuarantine,
  type ScrubTriageEntry,
} from '../lib/scrub-triage.js';
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
  readonly quarantinePath: string;
  readonly dryRun: boolean;
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
  const quarantineFlagIdx = argv.indexOf('--quarantine');
  const quarantinePath =
    quarantineFlagIdx >= 0 && argv[quarantineFlagIdx + 1]
      ? path.resolve(argv[quarantineFlagIdx + 1]!)
      : defaultScrubQuarantineExportPath();
  return {
    triagePath,
    quarantinePath,
    dryRun: flags.has('--dry-run'),
    purge: flags.has('--purge'),
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
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

async function main(): Promise<void> {
  const { triagePath, quarantinePath, dryRun, purge } = parseArgs(process.argv.slice(2));
  const config = loadScrubConfig(process.env, { dryRun });

  const databaseUrl = config.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('[SCRUB-APPLY] DATABASE_URL absente.');
    process.exit(1);
  }

  let triage;
  try {
    triage = await loadScrubTriageExport(triagePath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[SCRUB-APPLY] Impossible de lire ${triagePath} : ${msg}`);
    console.error('[SCRUB-APPLY] Lancez d’abord : npm run scrub -- --dry-run');
    process.exit(1);
  }

  const toRevoke = triage.disqualified.filter((e) => isScrubDisqualifiedStatus(e.status));
  const hasQuarantineExport = await fileExists(quarantinePath);
  let quarantineExport = null;
  if (hasQuarantineExport) {
    try {
      quarantineExport = await loadScrubQuarantineExport(quarantinePath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[SCRUB-APPLY] Export quarantaine ignoré (${msg})`);
    }
  }

  const quarantinePersisted = quarantineExport?.persisted === true;
  const quarantineEntryCount = quarantineExport?.entries.length ?? 0;
  const pendingOrange =
    triage.needsReview.length - (quarantinePersisted ? quarantineEntryCount : 0);

  if (toRevoke.length === 0 && quarantineEntryCount === 0) {
    console.log('[SCRUB-APPLY] Rien à appliquer.');
    return;
  }

  console.log(
    `[SCRUB-APPLY] ${dryRun ? 'DRY-RUN' : 'APPLY'}${purge ? ' · purge' : ''}`,
  );
  console.log(`[SCRUB-APPLY] 🔴 ${toRevoke.length} révocation(s) · source ${triagePath}`);
  if (quarantineEntryCount > 0) {
    console.log(
      `[SCRUB-APPLY] 🟠 ${quarantineEntryCount} fiche(s) quarantaine · source ${quarantinePath}${quarantinePersisted ? ' (déjà persistées)' : ''}`,
    );
  } else if (triage.needsReview.length > 0) {
    console.log(
      `[SCRUB-APPLY] ⚠️ ${triage.needsReview.length} 🟠 dans le triage — lancez : npm run scrub:quarantine -- --apply`,
    );
  }
  if (pendingOrange > 0) {
    console.log(`[SCRUB-APPLY] ⚠️ ${pendingOrange} 🟠 encore sans export quarantaine à jour.`);
  }
  console.log(
    `[SCRUB-APPLY] 🟢 ${triage.ready.length} conservés — websiteResolution déjà au dry-run.`,
  );

  const supabase = createSupabaseScrubClient(databaseUrl);
  const db = await openDatabase(config.STRATE_RADAR_DB_PATH);
  await migrateRadarPlaceLastOutcome(db);
  await migrateRadarDiamondSnapshot(db);
  await migrateRadarScrubClassifierLog(db);
  const repo = new ProspectRepository(db);

  let revoked = 0;
  let quarantinePatched = 0;
  let skipped = 0;
  const missing: string[] = [];

  try {
    const candidates = await loadScrubCandidates({
      config,
      repo,
      supabase,
      importShadowExport: false,
    });

    if (quarantineExport && !quarantinePersisted && quarantineExport.entries.length > 0) {
      for (const entry of quarantineExport.entries) {
        const label = `${entry.businessName} · ${entry.websiteStatus}`;
        if (dryRun) {
          console.log(`[SCRUB-APPLY] (dry-run) patcherait quarantaine · ${label}`);
          quarantinePatched += 1;
          continue;
        }

        if (entry.auditId) {
          await supabase.patchAuditWebsiteResolution(entry.auditId, entry.resolution);
        }
        const matchedUrl =
          typeof entry.resolution.url === 'string'
            ? entry.resolution.url
            : typeof entry.resolution.matchedUrl === 'string'
              ? entry.resolution.matchedUrl
              : null;
        await repo.insertScrubClassifierLog({
          auditId: entry.auditId,
          slug: entry.slug,
          placeKey: entry.placeKey,
          businessName: entry.businessName,
          dryRun: 0,
          scrubAction: entry.disqualified ? 'disqualified' : 'kept',
          websiteStatus: entry.websiteStatus,
          matchedUrl,
          classificationReason:
            typeof entry.resolution.classificationReason === 'string'
              ? entry.resolution.classificationReason
              : null,
          resolutionJson: JSON.stringify(entry.resolution),
        });
        console.log(`[SCRUB-APPLY] Quarantaine patchée · ${label}`);
        quarantinePatched += 1;
      }
    }

    for (const entry of toRevoke) {
      const candidate = findScrubCandidate({ entry, candidates });
      if (!candidate) {
        missing.push(entry.businessName);
        console.warn(
          `[SCRUB-APPLY] Introuvable (déjà révoqué/purgé ?) · ${entry.businessName}${entry.slug ? ` · ${entry.slug}` : ''}`,
        );
        skipped += 1;
        continue;
      }

      const label = `${candidate.businessName} · ${entry.status}${entry.url ? ` · ${entry.url}` : ''}`;
      if (dryRun) {
        console.log(`[SCRUB-APPLY] (dry-run) révoquerait · ${label}`);
        revoked += 1;
        continue;
      }

      if (candidate.auditId) {
        await supabase.revokeAudit(candidate.auditId);
        console.log(`[SCRUB-APPLY] Supabase revoked · ${candidate.businessName} · ${candidate.auditId}`);
        if (purge) {
          const deleted = await supabase.purgeRevokedDiamondAudit(candidate.auditId);
          console.log(
            deleted
              ? `[SCRUB-APPLY] Supabase DELETE · ${candidate.auditId}`
              : `[SCRUB-APPLY] Purge ignorée · ${candidate.auditId}`,
          );
        }
      } else {
        console.warn(`[SCRUB-APPLY] Pas d’auditId Supabase · ${candidate.businessName}`);
      }

      await repo.recordPlaceOutcome(candidate.placeKey, 'disqualified');
      console.log(`[SCRUB-APPLY] SQLite disqualified · ${candidate.placeKey}`);
      revoked += 1;
    }
  } finally {
    await supabase.close();
    await closeDatabase(db);
  }

  console.log('\n[SCRUB-APPLY] ═══ Bilan ═══');
  console.log(`🔴 Révoqué(s) : ${revoked}${dryRun ? ' (simulation)' : ''}`);
  if (quarantinePatched > 0) {
    console.log(`🟠 Quarantaine patchée : ${quarantinePatched}${dryRun ? ' (simulation)' : ''}`);
  }
  if (skipped > 0) console.log(`⏭ Ignoré(s) : ${skipped}`);
  if (missing.length > 0) console.log(`⚠️ Introuvables : ${missing.join(', ')}`);

  if (
    !dryRun &&
    quarantineExport &&
    quarantineExport.persisted &&
    quarantineExport.entries.length > 0
  ) {
    try {
      const updatedTriagePath = await refreshScrubTriageAfterQuarantine({
        triagePath,
        quarantinePath,
      });
      console.log(`[SCRUB-APPLY] Triage mis à jour · 🟠 retirés → 🟢 · ${updatedTriagePath}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[SCRUB-APPLY] Mise à jour triage ignorée : ${msg}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
