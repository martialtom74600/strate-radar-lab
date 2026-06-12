/**
 * Restauration d'urgence après un scrub erroné (faux owner_site du modèle 8B).
 *
 * - Supabase : audits `revoked` → `published` (diamants création / présence)
 * - SQLite   : outcome `disqualified` → `diamond` (si snapshot) ou suppression
 *
 * Usage :
 *   npm run revert-scrub              # exécution
 *   npm run revert-scrub -- --dry-run # aperçu sans écriture
 */

import { loadScrubConfig } from '../config/index.js';
import {
  closeDatabase,
  migrateRadarDiamondSnapshot,
  migrateRadarPlaceLastOutcome,
  migrateRadarScrubClassifierLog,
  openDatabase,
  ProspectRepository,
} from '../storage/index.js';
import { createSupabaseScrubClient } from '../storage/supabase-scrub.js';

function parseDryRun(argv: readonly string[]): boolean {
  return argv.includes('--dry-run');
}

async function main(): Promise<void> {
  const dryRun = parseDryRun(process.argv.slice(2));
  const config = loadScrubConfig(process.env, { dryRun });

  console.log(`Strate Radar — revert scrub${dryRun ? ' · DRY-RUN' : ''}`);

  const databaseUrl = config.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('[REVERT] DATABASE_URL absente — impossible de restaurer Supabase.');
    process.exit(1);
  }

  const supabase = createSupabaseScrubClient(databaseUrl);
  const db = await openDatabase(config.STRATE_RADAR_DB_PATH);
  await migrateRadarPlaceLastOutcome(db);
  await migrateRadarDiamondSnapshot(db);
  await migrateRadarScrubClassifierLog(db);
  const repo = new ProspectRepository(db);

  try {
    const revoked = await supabase.listRevokedDiamondAudits();
    console.log(`[REVERT] ${revoked.length} audit(s) Supabase en statut revoked (diamants).`);

    for (const row of revoked) {
      const label = `${row.businessName}${row.slug ? ` · ${row.slug}` : ''}`;
      if (dryRun) {
        console.log(`[REVERT] (dry-run) restaurerait published · ${label}`);
      } else {
        await supabase.restorePublishedAudit(row.auditId);
        console.log(`[REVERT] Supabase published · ${label}`);
      }
    }

    const disqualifiedBefore = await repo.countDisqualifiedOutcomes();
    console.log(`[REVERT] ${disqualifiedBefore} place(s) SQLite en outcome disqualified.`);

    let sqliteRestored = 0;
    let sqliteCleared = 0;
    if (disqualifiedBefore > 0) {
      if (dryRun) {
        const preview = await repo.previewRevertScrubDisqualifiedOutcomes();
        sqliteRestored = preview.restoredToDiamond;
        sqliteCleared = preview.clearedDisqualified;
        console.log(
          `[REVERT] (dry-run) SQLite · ${sqliteRestored} → diamond · ${sqliteCleared} supprimé(s)`,
        );
      } else {
        const result = await repo.revertScrubDisqualifiedOutcomes();
        sqliteRestored = result.restoredToDiamond;
        sqliteCleared = result.clearedDisqualified;
        console.log(
          `[REVERT] SQLite · ${sqliteRestored} repassé(s) en diamond · ${sqliteCleared} disqualified effacé(s)`,
        );
      }
    }

    const restoredFolders = Math.max(
      revoked.length,
      sqliteRestored + sqliteCleared,
    );

    if (dryRun) {
      console.log(
        `[REVERT] DRY-RUN · ${revoked.length} audit(s) Supabase · ${sqliteRestored + sqliteCleared} outcome(s) SQLite seraient restaurés.`,
      );
      return;
    }

    console.log(
      `[REVERT] ${restoredFolders} dossiers ont été restaurés avec succès et sont prêts à être re-qualifiés.`,
    );
    console.log(
      `[REVERT] Détail · Supabase published=${revoked.length} · SQLite diamond=${sqliteRestored} · SQLite cleared=${sqliteCleared}`,
    );
  } finally {
    await closeDatabase(db);
    await supabase.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
