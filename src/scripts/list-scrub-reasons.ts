/**
 * Liste toutes les raisons persistées (SQLite `radar_scrub_classifier_log`).
 *
 * Usage :
 *   npm run scrub:reasons
 *   npm run scrub:reasons -- --out data/scrub-reasons-archive.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { loadScrubConfig } from '../config/index.js';
import {
  closeDatabase,
  migrateRadarScrubClassifierLog,
  openDatabase,
  ProspectRepository,
} from '../storage/index.js';

function parseOutPath(argv: readonly string[]): string | null {
  const idx = argv.indexOf('--out');
  if (idx === -1) return null;
  const value = argv[idx + 1]?.trim();
  return value ? value : null;
}

async function main(): Promise<void> {
  const config = loadScrubConfig(process.env, { dryRun: true });
  const outArg = parseOutPath(process.argv.slice(2));

  const db = await openDatabase(config.STRATE_RADAR_DB_PATH);
  await migrateRadarScrubClassifierLog(db);
  const repo = new ProspectRepository(db);

  try {
    const rows = await repo.listScrubClassifierLogs();
    const payload = {
      exportedAt: new Date().toISOString(),
      count: rows.length,
      rows: rows.map((row) => ({
        id: row.id,
        recordedAt: row.recordedAt,
        businessName: row.businessName,
        slug: row.slug,
        auditId: row.auditId,
        placeKey: row.placeKey,
        dryRun: row.dryRun,
        scrubAction: row.scrubAction,
        websiteStatus: row.websiteStatus,
        matchedUrl: row.matchedUrl,
        classificationReason: row.classificationReason,
        websiteResolution: JSON.parse(row.resolutionJson) as unknown,
      })),
    };

    if (outArg) {
      const outPath = path.resolve(process.cwd(), outArg);
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      console.log(`[REASONS] ${rows.length} entrée(s) → ${outPath}`);
      return;
    }

    for (const row of rows) {
      console.log(
        `[REASONS] ${row.recordedAt} · ${row.businessName}${row.slug ? ` · ${row.slug}` : ''} · ${row.websiteStatus} · ${row.scrubAction}${row.dryRun ? ' · dry-run' : ''}`,
      );
      console.log(`         matched: ${row.matchedUrl ?? '—'}`);
      console.log(`         reason: ${row.classificationReason ?? '—'}`);
    }
    console.log(`[REASONS] Total : ${rows.length} entrée(s) dans radar_scrub_classifier_log`);
  } finally {
    await closeDatabase(db);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
