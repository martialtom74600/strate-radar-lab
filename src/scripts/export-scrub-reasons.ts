/**
 * Regénère les raisons IA pour tous les dossiers scrub éligibles (sans révoquer).
 * Persiste dans SQLite (`radar_scrub_classifier_log`) + `audits.payload.websiteResolution`.
 *
 * Usage :
 *   npm run scrub:export-reasons
 *   npm run scrub:export-reasons -- --out data/mes-raisons.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { loadScrubConfig } from '../config/index.js';
import { createRadarSearchClient } from '../lib/google-places.client.js';
import {
  evaluateScrubCandidateWithWebsiteResolver,
  loadScrubCandidates,
} from '../lib/retroactive-scrub.js';
import { websiteResolutionForPersistence } from '../lib/scrub-classifier-persistence.js';
import { createSerpManagerWebClient, isSerpQuotasExhaustedError } from '../services/serp/serp-manager.js';
import {
  closeDatabase,
  migrateRadarDiamondSnapshot,
  migrateRadarPlaceLastOutcome,
  migrateRadarScrubClassifierLog,
  openDatabase,
  ProspectRepository,
} from '../storage/index.js';
import { createSupabaseScrubClient } from '../storage/supabase-scrub.js';

function parseOutPath(argv: readonly string[]): string | null {
  const idx = argv.indexOf('--out');
  if (idx === -1) return null;
  const value = argv[idx + 1]?.trim();
  return value ? value : null;
}

async function main(): Promise<void> {
  const config = loadScrubConfig(process.env, { dryRun: true });
  const outArg = parseOutPath(process.argv.slice(2));
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.resolve(
    process.cwd(),
    outArg ?? path.join('data', `scrub-reasons-${timestamp}.json`),
  );

  const databaseUrl = config.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('[REASONS] DATABASE_URL absente — source Supabase requise.');
    process.exit(1);
  }

  const supabase = createSupabaseScrubClient(databaseUrl);
  const db = await openDatabase(config.STRATE_RADAR_DB_PATH);
  await migrateRadarPlaceLastOutcome(db);
  await migrateRadarDiamondSnapshot(db);
  await migrateRadarScrubClassifierLog(db);
  const repo = new ProspectRepository(db);
  const serpClient = createRadarSearchClient(config);
  const webSearchClient = createSerpManagerWebClient(config);

  const exportRows: Record<string, unknown>[] = [];

  try {
    const candidates = await loadScrubCandidates({
      config,
      repo,
      supabase,
      importShadowExport: false,
    });
    console.log(`[REASONS] ${candidates.length} dossier(s) · analyse IA (aucune révocation)…`);

    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i]!;
      let evaluated;
      try {
        evaluated = await evaluateScrubCandidateWithWebsiteResolver({
          config,
          serp: candidate.serp,
          serpClient,
          webSearchClient,
          searchLocation: candidate.searchLocation,
          fetchTimeoutMs: config.RADAR_FETCH_TIMEOUT_MS,
        });
      } catch (e) {
        if (isSerpQuotasExhaustedError(e)) {
          console.error(
            '[REASONS] FATAL: Quotas SERP (Serper + Brave) épuisés — export interrompu.',
          );
          break;
        }
        throw e;
      }

      const websiteResolution = websiteResolutionForPersistence(evaluated.resolution);
      if (candidate.auditId) {
        await supabase.patchAuditWebsiteResolution(candidate.auditId, websiteResolution);
      }
      await repo.insertScrubClassifierLog({
        auditId: candidate.auditId ?? null,
        slug: candidate.slug ?? null,
        placeKey: candidate.placeKey,
        businessName: candidate.businessName,
        dryRun: 1,
        scrubAction: evaluated.shouldDisqualify ? 'disqualified' : 'kept',
        websiteStatus: evaluated.resolution.status,
        matchedUrl:
          evaluated.resolution.url ?? evaluated.resolution.classifierAudit?.matchedUrl ?? null,
        classificationReason: evaluated.resolution.classificationReason,
        resolutionJson: JSON.stringify(websiteResolution),
      });

      exportRows.push({
        index: i + 1,
        businessName: candidate.businessName,
        slug: candidate.slug ?? null,
        auditId: candidate.auditId ?? null,
        placeKey: candidate.placeKey,
        wouldDisqualify: evaluated.shouldDisqualify,
        classificationReason: evaluated.resolution.classificationReason,
        matchedUrl:
          evaluated.resolution.url ?? evaluated.resolution.classifierAudit?.matchedUrl ?? null,
        websiteResolution,
      });

      console.log(
        `[REASONS] ${i + 1}/${candidates.length} · ${candidate.businessName} · ${evaluated.resolution.status} · ${evaluated.resolution.classificationReason?.slice(0, 120) ?? '—'}`,
      );
    }

    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(
      outPath,
      `${JSON.stringify({ exportedAt: new Date().toISOString(), count: exportRows.length, rows: exportRows }, null, 2)}\n`,
      'utf8',
    );

    console.log(`[REASONS] ${exportRows.length} raisons exportées → ${outPath}`);
    console.log(
      `[REASONS] Copie SQLite : radar_scrub_classifier_log (${exportRows.length} entrées ajoutées).`,
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
