/**
 * Supprime définitivement de Supabase les audits diamant (création / présence) en statut `revoked`.
 * Le scrub ne fait qu’un soft-delete (`status = revoked`) — cette commande purge les lignes.
 *
 * Usage :
 *   npm run purge-revoked-scrub -- --dry-run
 *   npm run purge-revoked-scrub
 */

import { loadScrubConfig } from '../config/index.js';
import { createSupabaseScrubClient } from '../storage/supabase-scrub.js';

function parseDryRun(argv: readonly string[]): boolean {
  return argv.includes('--dry-run');
}

async function main(): Promise<void> {
  const dryRun = parseDryRun(process.argv.slice(2));
  const config = loadScrubConfig(process.env, { dryRun });

  const databaseUrl = config.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('[PURGE] DATABASE_URL absente — impossible de purger Supabase.');
    process.exit(1);
  }

  const supabase = createSupabaseScrubClient(databaseUrl);

  try {
    const revoked = await supabase.listRevokedDiamondAudits();
    console.log(
      `[PURGE] ${revoked.length} audit(s) diamant en statut revoked (création / présence).`,
    );

    if (revoked.length === 0) {
      console.log('[PURGE] Rien à supprimer.');
      return;
    }

    for (const row of revoked) {
      const label = `${row.businessName}${row.slug ? ` · ${row.slug}` : ''}`;
      if (dryRun) {
        console.log(`[PURGE] (dry-run) supprimerait · ${label}`);
      }
    }

    if (dryRun) {
      console.log(`[PURGE] DRY-RUN · ${revoked.length} ligne(s) seraient DELETE de audits.`);
      return;
    }

    let deleted = 0;
    for (const row of revoked) {
      const label = `${row.businessName}${row.slug ? ` · ${row.slug}` : ''}`;
      const ok = await supabase.purgeRevokedDiamondAudit(row.auditId);
      if (ok) {
        deleted += 1;
        console.log(`[PURGE] Supprimé · ${label}`);
      } else {
        console.warn(`[PURGE] Ignoré (plus revoked ou déjà absent) · ${label}`);
      }
    }

    console.log(`[PURGE] Terminé · ${deleted}/${revoked.length} audit(s) supprimé(s) de Supabase.`);
  } finally {
    await supabase.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
