import { loadConfig } from '../config/index.js';
import { finalizeRadarRun } from '../lib/run-finalize.js';
import type { TargetProspectSpec } from '../lib/targeted-prospect.js';
import { runRadarPipeline } from '../pipeline/index.js';

function resolveTarget(): TargetProspectSpec {
  const args = process.argv.slice(2);
  let name = '';
  let location: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--name' && args[i + 1]) {
      name = args[i + 1]!.trim();
      i += 1;
      continue;
    }
    if (args[i] === '--location' && args[i + 1]) {
      location = args[i + 1]!.trim();
      i += 1;
    }
  }

  if (!name && args[0] && !args[0].startsWith('--')) {
    name = args[0]!.trim();
    if (args[1] && !args[1].startsWith('--')) {
      location = args[1]!.trim();
    }
  }

  name = name || process.env.AUDIT_TARGET_NAME?.trim() || '';
  location = location || process.env.AUDIT_TARGET_LOCATION?.trim() || undefined;

  if (!name) {
    throw new Error(
      'Nom requis : npm run audit:one -- "Nom entreprise" "Ville, France"\n' +
        'Ou : AUDIT_TARGET_NAME + AUDIT_TARGET_LOCATION',
    );
  }

  return { name, ...(location ? { location } : {}) };
}

export async function runAuditOneMain(): Promise<void> {
  const config = loadConfig();
  const target = resolveTarget();
  const location = target.location?.trim() || config.RADAR_SEARCH_LOCATION;

  console.log(`Strate Radar — audit one-shot · « ${target.name} » · ${location}`);

  const result = await runRadarPipeline({
    config,
    search: { q: target.name, location, hl: 'fr', gl: 'fr' },
    targetProspect: target,
    targetCreationCount: 1,
    targetRefonteCount: 1,
    forceRescan: true,
  });

  const missed = result.targetProspectMisses ?? [];

  const finalized = await finalizeRadarRun({
    config,
    result,
    workflow: process.env.GITHUB_ACTIONS === 'true' ? 'audit-one-shot' : 'audit-one-shot-local',
    targetedMisses: missed,
  });

  console.log(`Rapport : ${finalized.reportPath}`);
  console.log(`Heartbeat : ${finalized.heartbeatPath}`);
  console.log(`Export : ${finalized.shadowExportPath}`);
  console.log(
    `Ingest : ${finalized.ingestSuccesses.size} OK · ${finalized.ingestFailures.length} échec(s)`,
  );

  if (missed.length > 0) {
    console.warn(`\n⚠ Introuvable sur Google Places : « ${target.name} »`);
  }
}

async function main(): Promise<void> {
  await runAuditOneMain();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
