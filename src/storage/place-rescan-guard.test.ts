import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { describe, it } from 'node:test';

import {
  migrateDiamondRescanGuard,
  migrateProspectsTable,
  migrateRadarDiamondSnapshot,
  migrateRadarPlaceLastOutcome,
  openDatabase,
  ProspectRepository,
} from './database.js';

function runSql(
  db: sqlite3.Database,
  sql: string,
  params: ReadonlyArray<string | number | null> = [],
): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, [...params], (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function withTempRepo(
  fn: (args: {
    readonly repo: ProspectRepository;
    readonly db: sqlite3.Database;
  }) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'radar-sqlite-test-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const db = await openDatabase(dbPath);
  await migrateProspectsTable(db);
  await migrateDiamondRescanGuard(db);
  await migrateRadarPlaceLastOutcome(db);
  await migrateRadarDiamondSnapshot(db);
  const repo = new ProspectRepository(db);
  try {
    await fn({ repo, db });
  } finally {
    await new Promise<void>((resolve, reject) => {
      db.close((err) => (err ? reject(err) : resolve()));
    });
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('shouldSkipPlaceRescan', () => {
  it('bloque un diamant sans limite de temps', async () => {
    await withTempRepo(async ({ repo, db }) => {
      const key = 'pid:ChIJ-test-diamond';
      await repo.recordPlaceOutcome(key, 'diamond');

      await runSql(
        db,
        `UPDATE radar_place_last_outcome SET recorded_at = datetime('now', '-30 days') WHERE place_key = ?`,
        [key],
      );

      const skip = await repo.shouldSkipPlaceRescan(key, 7);
      assert.equal(skip, 'diamond');
    });
  });

  it('relâche un disqualifié après la fenêtre glissante', async () => {
    await withTempRepo(async ({ repo, db }) => {
      const key = 'pid:ChIJ-test-disqualified';
      await repo.recordPlaceOutcome(key, 'disqualified');

      assert.equal(await repo.shouldSkipPlaceRescan(key, 7), 'disqualified');

      await runSql(
        db,
        `UPDATE radar_place_last_outcome SET recorded_at = datetime('now', '-8 days') WHERE place_key = ?`,
        [key],
      );

      assert.equal(await repo.shouldSkipPlaceRescan(key, 7), null);
    });
  });

  it('permet un rescan après révocation scrub (diamant → disqualifié)', async () => {
    await withTempRepo(async ({ repo, db }) => {
      const key = 'pid:ChIJ-test-revoked';
      await repo.recordPlaceOutcome(key, 'diamond');
      assert.equal(await repo.shouldSkipPlaceRescan(key, 7), 'diamond');

      await repo.recordPlaceOutcome(key, 'disqualified');
      assert.equal(await repo.shouldSkipPlaceRescan(key, 7), 'disqualified');

      await runSql(
        db,
        `UPDATE radar_place_last_outcome SET recorded_at = datetime('now', '-8 days') WHERE place_key = ?`,
        [key],
      );

      assert.equal(await repo.shouldSkipPlaceRescan(key, 7), null);
    });
  });
});
