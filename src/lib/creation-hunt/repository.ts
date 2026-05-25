import sqlite3 from 'sqlite3';

function run(
  db: sqlite3.Database,
  sql: string,
  params: ReadonlyArray<string | number | null>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params as unknown[], (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function getRow(
  db: sqlite3.Database,
  sql: string,
  params: ReadonlyArray<string | number | null>,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params as unknown[], (err: Error | null, row: unknown) => {
      if (err) reject(err);
      else resolve(row as Record<string, unknown> | undefined);
    });
  });
}

function allRows<T extends Record<string, unknown>>(
  db: sqlite3.Database,
  sql: string,
  params: ReadonlyArray<string | number | null>,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params as unknown[], (err: Error | null, rows: unknown) => {
      if (err) reject(err);
      else resolve(rows as T[]);
    });
  });
}

export async function migrateCreationHuntTables(db: sqlite3.Database): Promise<void> {
  await run(
    db,
    `
    CREATE TABLE IF NOT EXISTS creation_hunt_zone (
      zone TEXT PRIMARY KEY,
      priority INTEGER NOT NULL DEFAULT 100,
      source TEXT NOT NULL DEFAULT 'anchor',
      ring INTEGER NOT NULL DEFAULT 0,
      last_run_at TEXT,
      last_creations INTEGER NOT NULL DEFAULT 0,
      total_scanned INTEGER NOT NULL DEFAULT 0,
      consecutive_low_runs INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
    `,
    [],
  );

  await run(
    db,
    `
    CREATE TABLE IF NOT EXISTS creation_hunt_sector_run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zone TEXT NOT NULL,
      sector TEXT NOT NULL,
      creations_found INTEGER NOT NULL,
      scanned_count INTEGER NOT NULL DEFAULT 0,
      run_at TEXT NOT NULL
    )
    `,
    [],
  );

  await run(
    db,
    `CREATE INDEX IF NOT EXISTS idx_creation_hunt_sector_zone_run
     ON creation_hunt_sector_run (zone, id DESC)`,
    [],
  );

  /* Migrations non-destructives pour DBs existantes */
  await silentAddColumn(db, 'creation_hunt_zone', 'total_scanned', 'INTEGER NOT NULL DEFAULT 0');
  await silentAddColumn(db, 'creation_hunt_sector_run', 'scanned_count', 'INTEGER NOT NULL DEFAULT 0');
}

async function silentAddColumn(
  db: sqlite3.Database,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  try {
    await run(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, []);
  } catch {
    /* Colonne déjà présente — ignoré */
  }
}

/** Persistance zones + rotation sectorielle pour le mode Creation Hunt. */
export class CreationHuntRepository {
  constructor(private readonly db: sqlite3.Database) {}

  async ensureAnchorZone(anchor: string): Promise<void> {
    const zone = anchor.trim();
    if (!zone) return;
    const now = new Date().toISOString();
    await run(
      this.db,
      `INSERT OR IGNORE INTO creation_hunt_zone
       (zone, priority, source, ring, updated_at)
       VALUES (?, 200, 'anchor', 0, ?)`,
      [zone, now],
    );
  }

  async upsertExpansionZones(zones: readonly string[], ring: number, source: string): Promise<void> {
    const now = new Date().toISOString();
    for (const raw of zones) {
      const zone = raw.trim();
      if (!zone) continue;
      await run(
        this.db,
        `INSERT INTO creation_hunt_zone (zone, priority, source, ring, updated_at)
         VALUES (?, 100, ?, ?, ?)
         ON CONFLICT(zone) DO UPDATE SET
           priority = CASE WHEN creation_hunt_zone.priority <= 0 THEN 100 ELSE creation_hunt_zone.priority END,
           ring = MIN(creation_hunt_zone.ring, excluded.ring),
           source = excluded.source,
           updated_at = excluded.updated_at`,
        [zone, source, ring, now],
      );
    }
  }

  async getActiveZonesOrdered(): Promise<string[]> {
    /*
     * Ordre : ancres (ring 0) en premier, puis par taux de conversion desc
     * (créations / scanned sur les zones connues), puis dernièrement scannées.
     * Les zones jamais scannées passent avant celles avec historique pauvre.
     */
    const rows = await allRows<{ zone: string }>(
      this.db,
      `SELECT zone FROM creation_hunt_zone
       WHERE priority > 0
       ORDER BY
         ring ASC,
         CASE WHEN last_run_at IS NULL THEN 0 ELSE 1 END,
         CASE
           WHEN total_scanned > 0
             THEN CAST(last_creations AS REAL) / total_scanned
           ELSE 1.0
         END DESC,
         last_run_at ASC,
         priority DESC,
         zone ASC`,
      [],
    );
    return rows.map((r) => r.zone);
  }

  async getHighestRing(): Promise<number> {
    const row = await getRow(
      this.db,
      `SELECT MAX(ring) AS max_ring FROM creation_hunt_zone WHERE priority > 0`,
      [],
    );
    const n = row?.max_ring;
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
  }

  async getLastExpansionAnchor(): Promise<string | null> {
    const row = await getRow(
      this.db,
      `SELECT zone FROM creation_hunt_zone
       WHERE priority > 0
       ORDER BY ring DESC, updated_at DESC
       LIMIT 1`,
      [],
    );
    return typeof row?.zone === 'string' ? row.zone : null;
  }

  async isSectorSaturated(
    zone: string,
    sector: string,
    lowThreshold: number,
    saturationRuns: number,
  ): Promise<boolean> {
    const rows = await allRows<{ creations_found: number }>(
      this.db,
      `SELECT creations_found FROM creation_hunt_sector_run
       WHERE zone = ? AND sector = ?
       ORDER BY id DESC LIMIT ?`,
      [zone, sector, saturationRuns],
    );
    if (rows.length < saturationRuns) return false;
    return rows.every((r) => r.creations_found < lowThreshold);
  }

  /** Secteurs les moins récemment scannés dans la zone, hors saturés. */
  async pickRotatingSectors(
    zone: string,
    count: number,
    pool: readonly string[],
    lowThreshold: number,
    saturationRuns: number,
  ): Promise<string[]> {
    const want = Math.max(1, Math.min(pool.length, count));
    type Cand = { sector: string; lastMs: number | null; saturated: boolean; convRate: number };
    const cands: Cand[] = [];

    for (const sector of pool) {
      const row = await getRow(
        this.db,
        `SELECT run_at, SUM(creations_found) AS total_c, SUM(scanned_count) AS total_s
         FROM creation_hunt_sector_run
         WHERE zone = ? AND sector = ?
         ORDER BY id DESC LIMIT 1`,
        [zone, sector],
      );
      const lastAt = typeof row?.run_at === 'string' ? row.run_at : null;
      const lastMs = lastAt !== null ? Date.parse(lastAt) : null;
      const totalC = typeof row?.total_c === 'number' ? row.total_c : 0;
      const totalS = typeof row?.total_s === 'number' ? row.total_s : 0;
      const convRate = totalS > 0 ? totalC / totalS : 1.0;
      const saturated = await this.isSectorSaturated(zone, sector, lowThreshold, saturationRuns);
      cands.push({
        sector,
        lastMs: Number.isNaN(lastMs ?? NaN) ? null : lastMs,
        saturated,
        convRate,
      });
    }

    const eligible = cands.filter((c) => !c.saturated);
    const pool2 = eligible.length > 0 ? eligible : cands;

    /* Trie : taux de conversion desc, puis moins récent en premier */
    const sorted = [...pool2].sort((a, b) => {
      if (a.lastMs === null && b.lastMs !== null) return -1;
      if (a.lastMs !== null && b.lastMs === null) return 1;
      if (a.lastMs === null && b.lastMs === null) return b.convRate - a.convRate;
      const convDiff = b.convRate - a.convRate;
      if (Math.abs(convDiff) > 0.02) return convDiff;
      return (a.lastMs ?? 0) - (b.lastMs ?? 0);
    });

    return sorted.slice(0, want).map((c) => c.sector);
  }

  async recordZoneRun(
    zone: string,
    creationsFound: number,
    totalScanned: number,
    runAtIso: string,
    lowThreshold: number,
    saturationRuns: number,
  ): Promise<void> {
    const row = await getRow(
      this.db,
      `SELECT consecutive_low_runs AS consecutive_low_runs FROM creation_hunt_zone WHERE zone = ?`,
      [zone],
    );
    const prev = typeof row?.consecutive_low_runs === 'number' ? row.consecutive_low_runs : 0;
    const low = creationsFound < lowThreshold;
    const consecutive = low ? prev + 1 : 0;
    const deprioritize = consecutive >= saturationRuns;

    if (deprioritize) {
      await run(
        this.db,
        `UPDATE creation_hunt_zone SET
           last_run_at = ?,
           last_creations = ?,
           total_scanned = total_scanned + ?,
           consecutive_low_runs = ?,
           priority = 0,
           updated_at = ?
         WHERE zone = ?`,
        [runAtIso, creationsFound, totalScanned, consecutive, runAtIso, zone],
      );
      return;
    }

    await run(
      this.db,
      `UPDATE creation_hunt_zone SET
         last_run_at = ?,
         last_creations = ?,
         total_scanned = total_scanned + ?,
         consecutive_low_runs = ?,
         updated_at = ?
       WHERE zone = ?`,
      [runAtIso, creationsFound, totalScanned, consecutive, runAtIso, zone],
    );
  }

  async recordSectorRun(
    zone: string,
    sector: string,
    creationsFound: number,
    scannedCount: number,
    runAtIso: string,
  ): Promise<void> {
    await run(
      this.db,
      `INSERT INTO creation_hunt_sector_run (zone, sector, creations_found, scanned_count, run_at)
       VALUES (?, ?, ?, ?, ?)`,
      [zone, sector, creationsFound, scannedCount, runAtIso],
    );
  }

  async reactivateAllZones(): Promise<void> {
    await run(
      this.db,
      `UPDATE creation_hunt_zone SET priority = 80, consecutive_low_runs = 0, updated_at = ?
       WHERE priority <= 0`,
      [new Date().toISOString()],
    );
  }

  /** Réactive les zones déprioritisées depuis plus de `ttlDays` jours. */
  async reactivateStaleZones(ttlDays: number): Promise<number> {
    if (ttlDays <= 0) return 0;
    const cutoff = new Date(Date.now() - ttlDays * 24 * 3600 * 1000).toISOString();
    const before = await allRows<{ zone: string }>(
      this.db,
      `SELECT zone FROM creation_hunt_zone WHERE priority <= 0 AND updated_at < ?`,
      [cutoff],
    );
    if (before.length === 0) return 0;
    await run(
      this.db,
      `UPDATE creation_hunt_zone
       SET priority = 80, consecutive_low_runs = 0, updated_at = ?
       WHERE priority <= 0 AND updated_at < ?`,
      [new Date().toISOString(), cutoff],
    );
    return before.length;
  }

  /** Supprime les entrées de secteur plus anciennes que `ttlDays` jours. */
  async pruneOldSectorRuns(ttlDays: number): Promise<number> {
    if (ttlDays <= 0) return 0;
    const cutoff = new Date(Date.now() - ttlDays * 24 * 3600 * 1000).toISOString();
    const before = await allRows<{ cnt: number }>(
      this.db,
      `SELECT COUNT(*) AS cnt FROM creation_hunt_sector_run WHERE run_at < ?`,
      [cutoff],
    );
    const count = before[0]?.cnt ?? 0;
    if (count === 0) return 0;
    await run(
      this.db,
      `DELETE FROM creation_hunt_sector_run WHERE run_at < ?`,
      [cutoff],
    );
    return count;
  }
}
