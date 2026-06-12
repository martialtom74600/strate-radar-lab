import { loadScrubConfig } from '../config/index.js';
import { createRadarSearchClient } from '../lib/google-places.client.js';
import { runRetroactiveScrub } from '../lib/retroactive-scrub.js';
import { createBraveSearchWebClient } from '../services/serp/brave-search.client.js';
import {
  closeDatabase,
  migrateDiamondRescanGuard,
  migrateProspectsTable,
  migrateRadarDiamondSnapshot,
  migrateRadarPlaceLastOutcome,
  migrateRadarScrubClassifierLog,
  openDatabase,
  ProspectRepository,
} from '../storage/index.js';
import { createSupabaseScrubClient } from '../storage/supabase-scrub.js';

function parseArgs(argv: readonly string[]): { dryRun: boolean; importShadow: boolean } {
  return {
    dryRun: argv.includes('--dry-run'),
    importShadow: !argv.includes('--no-import-shadow'),
  };
}

export async function runRetroactiveScrubMain(): Promise<void> {
  const { dryRun, importShadow } = parseArgs(process.argv.slice(2));
  const config = loadScrubConfig(process.env, { dryRun });

  console.log(
    `Strate Radar — scrub retroactif (website-resolver)${dryRun ? ' · DRY-RUN' : ''}${config.simulation ? ' · simulation' : ''}`,
  );

  const db = await openDatabase(config.STRATE_RADAR_DB_PATH);
  await migrateProspectsTable(db);
  await migrateDiamondRescanGuard(db);
  await migrateRadarPlaceLastOutcome(db);
  await migrateRadarDiamondSnapshot(db);
  await migrateRadarScrubClassifierLog(db);

  const repo = new ProspectRepository(db);
  const serpClient = createRadarSearchClient(config);
  const webSearchClient = createBraveSearchWebClient(config);
  const supabase = config.DATABASE_URL?.trim()
    ? createSupabaseScrubClient(config.DATABASE_URL)
    : null;

  if (!supabase && !config.DATABASE_URL?.trim()) {
    console.log(
      '[SCRUB] DATABASE_URL absente — lecture SQLite locale uniquement (ajoutez mon-site/.env.local ou strate-radar-lab/.env)',
    );
  }
  if (!webSearchClient) {
    console.log(
      '[SCRUB] BRAVE_SEARCH_API_KEY absente — le scrub ne peut pas retrouver les sites absents de Google Maps (ex. lamy-joaillerie.com). Copiez le secret GitHub BRAVE_SEARCH_API_KEY dans strate-radar-lab/.env',
    );
  }

  try {
    const result = await runRetroactiveScrub({
      config,
      repo,
      serpClient,
      webSearchClient,
      supabase,
      dryRun,
      importShadowExport: importShadow && !supabase,
    });

    if (result.organicFetched > 0) {
      console.log(`[SCRUB] Résolutions web · ${result.organicFetched} fiche(s)`);
    }

    if (result.analyzed === 0) {
      if (result.dataSource === 'supabase') {
        console.log(
          `[SCRUB] Rien à analyser — ${result.supabasePublished} audit(s) publié(s) en Supabase (création / présence).`,
        );
      } else {
        console.log(
          `[SCRUB] Rien à analyser — ${result.activeDiamonds} diamant(s) SQLite, ${result.snapshotsBefore} snapshot(s).` +
            (result.orphansSkippedMock > 0
              ? ` ${result.orphansSkippedMock} mock(s) simulation ignorés.`
              : ' Ajoutez DATABASE_URL (Supabase) ou restaurez la SQLite Actions.'),
        );
      }
    }

    console.log(
      `Nettoyage terminé. ${result.analyzed} dossiers analysés, ${result.disqualified} faux positifs disqualifiés.`,
    );
  } finally {
    await closeDatabase(db);
    if (supabase) {
      await supabase.close();
    }
  }
}

async function main(): Promise<void> {
  await runRetroactiveScrubMain();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
