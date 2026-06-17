/**
 * Met à jour scrub-triage-latest.json : retire les 🟠 résolus via scrub-quarantine.
 *
 * Usage : npm run scrub:triage-refresh
 */

import { refreshScrubTriageAfterQuarantine } from '../lib/scrub-triage.js';

async function main(): Promise<void> {
  const path = await refreshScrubTriageAfterQuarantine({});
  console.log(`[SCRUB-TRIAGE-REFRESH] Export mis à jour → ${path}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
