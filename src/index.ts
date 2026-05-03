import { loadConfig } from './config/index.js';
import {
  buildShadowSitesPayload,
  writeShadowSitesExportFile,
} from './pipeline/shadow-export.js';
import { generateShadowPagesFromExport } from './pipeline/generate-shadow-pages.js';
import { runRadarPipeline, writeRapportMatinalFile } from './pipeline/index.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const mode = config.simulation ? 'SIMULATION (dry run)' : 'LIVE';
  console.log(`Strate Radar — ${mode}`);
  if (config.RADAR_VERBOSE) {
    console.log(
      '(Journal détaillé activé · désactiver avec RADAR_VERBOSE=false dans .env ou le shell)\n',
    );
  }

  const result = await runRadarPipeline({
    config,
    search: {
      q: config.RADAR_SEARCH_Q,
      location: config.RADAR_SEARCH_LOCATION,
      hl: 'fr',
      gl: 'fr',
    },
  });

  const outPath = await writeRapportMatinalFile(config.RADAR_REPORT_PATH, result);
  console.log(`Rapport écrit : ${outPath}`);

  if (result.serpApiStoppedEarly) {
    console.warn(
      '\n⚠ Google Places : run interrompu (souvent HTTP 429 — quota). Rapport et export reflètent les résultats **jusqu’à l’arrêt**.',
    );
    if (result.serpApiStopMessage) {
      console.warn(`   ${result.serpApiStopMessage}`);
    }
  }

  const diamonds = buildShadowSitesPayload(result.lines);
  const shadowPath = await writeShadowSitesExportFile(config.RADAR_SHADOW_EXPORT_PATH, {
    generatedAtIso: result.generatedAtIso,
    cityLabel: result.reportCityDisplayName,
    diamonds,
    demand_driven_mode: result.demandDrivenMode,
    trending_queries_used: result.trendQueriesResolved,
  });
  console.log(`Export Shadow Site : ${shadowPath} (${diamonds.length} pépite(s))`);

  if (config.RADAR_AUTO_GENERATE_SHADOW_PAGES && diamonds.length > 0) {
    const pages = await generateShadowPagesFromExport({
      exportPath: config.RADAR_SHADOW_EXPORT_PATH,
      outputDir: config.RADAR_SHADOW_PAGES_DIR,
    });
    console.log(
      `Shadow Pages HTML : ${pages.length} fichier(s) dans ${config.RADAR_SHADOW_PAGES_DIR}`,
    );
  }

  console.log(
    `Diamants : ${result.diamondsFound}/${result.targetDiamondCount} · Fiches : ${result.totalBusinessesScanned} · Requêtes (run) : ${result.serpApiCallsUsed}/${result.serpApiCallsMax}`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
