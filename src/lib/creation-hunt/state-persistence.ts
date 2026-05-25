import fs from 'node:fs/promises';
import path from 'node:path';

import type { CreationHuntRepository, SectorRunStateRow, ZoneStateRow } from './repository.js';

type PersistedState = {
  version: 1;
  exportedAt: string;
  zones: ZoneStateRow[];
  sectorRuns: SectorRunStateRow[];
};

/**
 * Sauvegarde le snapshot de la DB Creation Hunt dans un fichier JSON commitable.
 * Appelé en fin de run — si le cache SQLite Actions est perdu au prochain run,
 * `restoreCreationHuntStateIfNeeded` reconstruit la DB depuis ce fichier.
 */
export async function saveCreationHuntState(
  repo: CreationHuntRepository,
  jsonPath: string,
  sectorRunDays: number,
): Promise<void> {
  const { zones, sectorRuns } = await repo.exportState(sectorRunDays);
  const state: PersistedState = {
    version: 1,
    exportedAt: new Date().toISOString(),
    zones,
    sectorRuns,
  };
  await fs.mkdir(path.dirname(jsonPath), { recursive: true });
  await fs.writeFile(jsonPath, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Si la DB SQLite est vide (miss de cache), importe l'état depuis le snapshot JSON.
 * Retourne `true` si un import a eu lieu.
 */
export async function restoreCreationHuntStateIfNeeded(
  repo: CreationHuntRepository,
  jsonPath: string,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(jsonPath, 'utf8');
  } catch {
    return false;
  }

  let state: unknown;
  try {
    state = JSON.parse(raw);
  } catch {
    return false;
  }

  if (
    !state ||
    typeof state !== 'object' ||
    (state as PersistedState).version !== 1 ||
    !Array.isArray((state as PersistedState).zones)
  ) {
    return false;
  }

  const { zones, sectorRuns } = state as PersistedState;
  await repo.importStateIfEmpty({ zones, sectorRuns: sectorRuns ?? [] });
  return true;
}
