import type { AppConfig } from '../config/index.js';
import { writeHeartbeatFile } from './heartbeat.js';
import { buildRunTelemetry } from './run-telemetry.js';
import {
  publishStudioAuditsIfConfigured,
  type StudioIngestSuccess,
} from './strate-studio/audit-ingest.js';
import type { RadarPipelineResult } from '../pipeline/radar-pipeline.js';
import {
  buildShadowSitesPayload,
  writeShadowSitesExportFile,
} from '../pipeline/shadow-export.js';
import { writeRapportMatinalFile } from '../pipeline/index.js';

export type FinalizeRadarRunResult = {
  readonly reportPath: string;
  readonly heartbeatPath: string;
  readonly shadowExportPath: string;
  readonly ingestSuccesses: ReadonlyMap<string, StudioIngestSuccess>;
  readonly ingestFailures: Awaited<
    ReturnType<typeof publishStudioAuditsIfConfigured>
  >['failures'];
};

/** Rapport, export, heartbeat, ingest vitrine — fin de run partagée. */
export async function finalizeRadarRun(args: {
  readonly config: AppConfig;
  readonly result: RadarPipelineResult;
  readonly workflow: string;
  readonly targetedMisses?: readonly string[];
}): Promise<FinalizeRadarRunResult> {
  const { config, result, workflow, targetedMisses = [] } = args;

  const { successes: ingestSuccesses, failures: ingestFailures } =
    await publishStudioAuditsIfConfigured(config, result);

  const reportPath = await writeRapportMatinalFile(
    config.RADAR_REPORT_PATH,
    result,
    ingestSuccesses,
  );

  const telemetry = buildRunTelemetry({
    result,
    ingestSuccesses,
    ingestFailures,
    config,
    workflow,
    targetedMisses,
  });

  const heartbeatPath = await writeHeartbeatFile('data/heartbeat.json', telemetry);

  const diamonds = buildShadowSitesPayload(result.lines);
  const shadowExportPath = await writeShadowSitesExportFile(config.RADAR_SHADOW_EXPORT_PATH, {
    generatedAtIso: result.generatedAtIso,
    cityLabel: result.reportCityDisplayName,
    diamonds,
    demand_driven_mode: result.demandDrivenMode,
    trending_queries_used: result.trendQueriesResolved,
  });

  return {
    reportPath,
    heartbeatPath,
    shadowExportPath,
    ingestSuccesses,
    ingestFailures,
  };
}
