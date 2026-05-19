import fs from 'node:fs/promises';
import path from 'node:path';

import type { RunTelemetryPayload } from './run-telemetry.js';

/** Alias historique — heartbeat.json contient la télémétrie complète du run. */
export type HeartbeatPayload = RunTelemetryPayload;

export async function writeHeartbeatFile(
  relativePath: string,
  payload: HeartbeatPayload,
): Promise<string> {
  const resolved = path.resolve(process.cwd(), relativePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return resolved;
}
