import { loadConfig } from './config/index.js';
import { finalizeRadarRun } from './lib/run-finalize.js';
import { radarLineToStrateAuditPayload } from './lib/strate-studio/audit-ingest.js';
import { extendAuditPayloadWithHighValue } from './lib/strate-studio/audit-hv-enrichment.js';
import { runRadarPipeline } from './pipeline/index.js';

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
    (l) =>
      l.conversionBadge === 'DIAMANT_CREATION' ||
      l.conversionBadge === 'DIAMANT_PRESENCE',
  );
  if (debugIngestLine) {
    const payload = extendAuditPayloadWithHighValue(
      debugIngestLine,
      result,
      radarLineToStrateAuditPayload(debugIngestLine),
    );
    console.log('DEBUG_FULL_PAYLOAD:', JSON.stringify(payload, null, 2));
  }

  const finalized = await finalizeRadarRun({
    config,
    result,
    workflow: process.env.GITHUB_ACTIONS === 'true' ? 'nightly-radar' : 'local',
  });

  if (config.RADAR_VERBOSE) {
    console.log(`Heartbeat : ${finalized.heartbeatPath}`);
  }
  console.log(`Rapport écrit : ${finalized.reportPath}`);

  if (result.placesStoppedEarly) {
    console.warn(
      '\n⚠ Google Places : run interrompu (souvent HTTP 429 — quota). Rapport et export reflètent les résultats **jusqu’à l’arrêt**.',
    );
    if (result.placesStopMessage) {
      console.warn(`   ${result.placesStopMessage}`);
    }
  }

  if (result.serpQuotasExhausted) {
    console.warn(
      '\n⚠ Quotas SERP (Serper + Brave) épuisés — run interrompu. Rapport et export reflètent les résultats **jusqu’à l’arrêt**.',
    );
    if (result.serpStopMessage) {
      console.warn(`   ${result.serpStopMessage}`);
    }
  }

  console.log(
    `Export Shadow Site : ${finalized.shadowExportPath} (${result.lines.filter((l) => l.conversionBadge).length} lead(s))`,
  );

  console.log(
    `Leads : création ${result.creationsFound}/${result.targetCreationCount} · refonte ${result.refontesFound}/${result.targetRefonteCount} · Fiches : ${result.totalBusinessesScanned} · Places : ${result.placesRequestsUsed}/${result.placesRequestsMax} · SERP : ${result.webSearchRequestsUsed}/${result.webSearchRequestsMax}`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
