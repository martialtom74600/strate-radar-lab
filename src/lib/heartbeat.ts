import fs from 'node:fs/promises';
import path from 'node:path';

export type HeartbeatPayload = {
  readonly lastRunIso: string;
  readonly workflow: string;
  readonly campaign: { readonly city: string; readonly category: string } | null;
  readonly diamondsFound: number;
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
