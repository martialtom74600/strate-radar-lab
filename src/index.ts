import { loadConfig } from './config/index.js';
import { writeHeartbeatFile } from './lib/heartbeat.js';
import {
  publishStudioAuditsIfConfigured,
  radarLineToStrateAuditPayload,
} from './lib/strate-studio/audit-ingest.js';
import { extendAuditPayloadWithHighValue } from './lib/strate-studio/audit-hv-enrichment.js';
import {
  buildShadowSitesPayload,
  writeShadowSitesExportFile,
} from './pipeline/shadow-export.js';
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

  const debugIngestLine = result.lines.find(
    (l) => l.conversionBadge === 'DIAMANT_CREATION' || l.conversionBadge === 'DIAMANT_REFONTE',
  );
  if (debugIngestLine) {
    const payload = extendAuditPayloadWithHighValue(
      debugIngestLine,
      result,
      radarLineToStrateAuditPayload(debugIngestLine),
    );
    console.log('DEBUG_FULL_PAYLOAD:', JSON.stringify(payload, null, 2));
  }

  const { successes: studioAuditLinks } = await publishStudioAuditsIfConfigured(config, result);

  const outPath = await writeRapportMatinalFile(
    config.RADAR_REPORT_PATH,
    result,
    studioAuditLinks,
  );
  console.log(`Rapport écrit : ${outPath}`);

  const hbPath = await writeHeartbeatFile('data/heartbeat.json', {
    lastRunIso: result.generatedAtIso,
    workflow: process.env.GITHUB_ACTIONS === 'true' ? 'nightly-radar' : 'local',
    campaign: result.campaign ?? null,
    diamondsFound: result.creationsFound + result.refontesFound,
    creationsFound: result.creationsFound,
    refontesFound: result.refontesFound,
    targetCreationCount: result.targetCreationCount,
    targetRefonteCount: result.targetRefonteCount,
    totalBusinessesScanned: result.totalBusinessesScanned,
    placesRequestsUsed: result.placesRequestsUsed,
    placesRequestsMax: result.placesRequestsMax,
    placesStoppedEarly: result.placesStoppedEarly,
  });
  if (config.RADAR_VERBOSE) {
    console.log(`Heartbeat : ${hbPath}`);
  }

  if (result.placesStoppedEarly) {
    console.warn(
      '\n⚠ Google Places : run interrompu (souvent HTTP 429 — quota). Rapport et export reflètent les résultats **jusqu’à l’arrêt**.',
    );
    if (result.placesStopMessage) {
      console.warn(`   ${result.placesStopMessage}`);
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
  console.log(`Export Shadow Site : ${shadowPath} (${diamonds.length} lead(s))`);

  console.log(
    `Leads : création ${result.creationsFound}/${result.targetCreationCount} · refonte ${result.refontesFound}/${result.targetRefonteCount} · Fiches : ${result.totalBusinessesScanned} · Requêtes Places (run) : ${result.placesRequestsUsed}/${result.placesRequestsMax}`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
