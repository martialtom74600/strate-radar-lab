import fs from 'node:fs/promises';
import path from 'node:path';

export type HeartbeatPayload = {
  readonly lastRunIso: string;
  readonly workflow: string;
  readonly campaign: { readonly city: string; readonly category: string } | null;
  /** Somme création + refonte (compat scripts). */
  readonly diamondsFound: number;
  readonly creationsFound: number;
  readonly refontesFound: number;
  readonly targetCreationCount: number;
  readonly targetRefonteCount: number;
  /** Parité avec le log console / rapport (notification Telegram, scripts). */
  readonly totalBusinessesScanned: number;
  readonly placesRequestsUsed: number;
  readonly placesRequestsMax: number;
  readonly placesStoppedEarly: boolean;
};

export async function writeHeartbeatFile(
  relativePath: string,
  payload: HeartbeatPayload,
): Promise<string> {
  const resolved = path.resolve(process.cwd(), relativePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return resolved;
}
