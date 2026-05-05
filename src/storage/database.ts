import fs from 'node:fs/promises';
import path from 'node:path';
import sqlite3 from 'sqlite3';

import type { PageSpeedInsightsV5 } from '../services/pagespeed/schemas.js';
import type { SerpLocalResult } from '../services/serp/schemas.js';
import type { SalesAnalysis } from '../services/groq/schemas.js';
import { parseSalesAnalysisJson } from '../services/groq/schemas.js';

export type ProspectScanMode = 'live' | 'simulation';

export type WebsiteSource = 'maps_link' | 'organic_deep_search';

export type ProspectScanUpsert = {
  readonly normalizedUrl: string;
  readonly weekBucket: string;
  readonly displayUrl: string;
  readonly name: string;
  readonly placeId: string | null;
  readonly searchQuery: string;
  readonly searchLocation: string | null;
  readonly rating: number | null;
  readonly reviews: number | null;
  readonly address: string | null;
  readonly category: string | null;
  readonly psiStrategy: 'mobile' | 'desktop';
  readonly psi: PageSpeedInsightsV5;
  readonly serpRow: SerpLocalResult;
  readonly analysis: SalesAnalysis;
  readonly scannedAtIso: string;
  readonly mode: ProspectScanMode;
  readonly websiteSource: WebsiteSource;
};

export type CachedProspectScan = {
  readonly normalizedUrl: string;
  readonly weekBucket: string;
  readonly displayUrl: string;
  readonly name: string;
  readonly placeId: string | null;
  readonly searchQuery: string;
  readonly searchLocation: string | null;
  readonly rating: number | null;
  readonly reviews: number | null;
  readonly address: string | null;
  readonly category: string | null;
  readonly psiStrategy: 'mobile' | 'desktop';
  readonly psi: PageSpeedInsightsV5;
  readonly serpRow: SerpLocalResult;
  readonly analysis: SalesAnalysis;
  readonly scannedAtIso: string;
  readonly mode: ProspectScanMode;
  readonly websiteSource: WebsiteSource;
};

type ProspectRow = {
  normalized_url: string;
  week_bucket: string;
  display_url: string;
  name: string;
  place_id: string | null;
  search_query: string;
  search_location: string | null;
  rating: number | null;
  reviews: number | null;
  address: string | null;
  category: string | null;
  psi_strategy: string;
  psi_raw_json: string;
  serp_row_json: string;
  analysis_json: string;
  scanned_at: string;
  mode: string;
  website_source?: string | null;
};

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
): Promise<ProspectRow | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params as unknown[], (err: Error | null, row: unknown) => {
      if (err) reject(err);
      else resolve(row as ProspectRow | undefined);
    });
  });
}

function parseWebsiteSource(raw: string | null | undefined): WebsiteSource {
  if (raw === 'organic_deep_search') return 'organic_deep_search';
  return 'maps_link';
}

function parseCached(row: ProspectRow): CachedProspectScan | null {
  let psi: PageSpeedInsightsV5;
  let serp: SerpLocalResult;
  let analysis: SalesAnalysis;
  try {
    psi = JSON.parse(row.psi_raw_json) as PageSpeedInsightsV5;
    serp = JSON.parse(row.serp_row_json) as SerpLocalResult;
    const parsedAnalysis = parseSalesAnalysisJson(JSON.parse(row.analysis_json));
    if (!parsedAnalysis) return null;
    analysis = parsedAnalysis;
  } catch {
    return null;
  }

  if (
    typeof serp !== 'object' ||
    serp === null ||
    typeof (serp as SerpLocalResult).title !== 'string'
  ) {
    return null;
  }

  if (row.psi_strategy !== 'mobile' && row.psi_strategy !== 'desktop') return null;
  if (row.mode !== 'live' && row.mode !== 'simulation') return null;

  return {
    normalizedUrl: row.normalized_url,
    weekBucket: row.week_bucket,
    displayUrl: row.display_url,
    name: row.name,
    placeId: row.place_id,
    searchQuery: row.search_query,
    searchLocation: row.search_location,
    rating: row.rating,
    reviews: row.reviews,
    address: row.address,
    category: row.category,
    psiStrategy: row.psi_strategy,
    psi,
    serpRow: serp,
    analysis,
    scannedAtIso: row.scanned_at,
    mode: row.mode,
    websiteSource: parseWebsiteSource(row.website_source),
  };
}

export async function resolveDbFilePath(dbPath: string): Promise<string> {
  const resolved = path.resolve(process.cwd(), dbPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  return resolved;
}

export async function openDatabase(filePath: string): Promise<sqlite3.Database> {
  const resolved = await resolveDbFilePath(filePath);
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(resolved, (err: Error | null) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

export async function migrateProspectsTable(db: sqlite3.Database): Promise<void> {
  await run(
    db,
    `
    CREATE TABLE IF NOT EXISTS prospects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      normalized_url TEXT NOT NULL,
      week_bucket TEXT NOT NULL,
      display_url TEXT NOT NULL,
      name TEXT NOT NULL,
      place_id TEXT,
      search_query TEXT NOT NULL,
      search_location TEXT,
      rating REAL,
      reviews INTEGER,
      address TEXT,
      category TEXT,
      psi_strategy TEXT NOT NULL DEFAULT 'mobile',
      psi_raw_json TEXT NOT NULL,
      serp_row_json TEXT NOT NULL,
      analysis_json TEXT NOT NULL,
      scanned_at TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('live','simulation')),
      UNIQUE(normalized_url, week_bucket)
    )
    `,
    [],
  );

  await run(
    db,
    `ALTER TABLE prospects ADD COLUMN website_source TEXT DEFAULT 'maps_link'`,
    [],
  ).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) throw err;
  });
}

export async function migrateDiamondRescanGuard(db: sqlite3.Database): Promise<void> {
  await run(
    db,
    `
    CREATE TABLE IF NOT EXISTS diamond_rescan_guard (
      place_key TEXT PRIMARY KEY,
      last_seen_at TEXT NOT NULL,
      is_diamond INTEGER NOT NULL DEFAULT 1
    )
    `,
    [],
  );
}

export async function migrateRadarPlaceLastOutcome(db: sqlite3.Database): Promise<void> {
  await run(
    db,
    `
    CREATE TABLE IF NOT EXISTS radar_place_last_outcome (
      place_key TEXT PRIMARY KEY,
      outcome TEXT NOT NULL CHECK(outcome IN ('diamond','disqualified')),
      recorded_at TEXT NOT NULL
    )
    `,
    [],
  );
}

/** @deprecated Préférer radar_place_last_outcome + fenêtre glissante. */
export async function migrateRadarWeekPlaceOutcome(db: sqlite3.Database): Promise<void> {
  await run(
    db,
    `
    CREATE TABLE IF NOT EXISTS radar_week_place_outcome (
      place_key TEXT NOT NULL,
      week_bucket TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('diamond','disqualified')),
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (place_key, week_bucket)
    )
    `,
    [],
  );
}

export async function migrateCampaignTables(db: sqlite3.Database): Promise<void> {
  await run(
    db,
    `
    CREATE TABLE IF NOT EXISTS campaign_run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city TEXT NOT NULL,
      category TEXT NOT NULL,
      run_at TEXT NOT NULL,
      diamonds_found INTEGER NOT NULL
    )
    `,
    [],
  );
  await run(
    db,
    `CREATE INDEX IF NOT EXISTS idx_campaign_run_city_id ON campaign_run (city, id DESC)`,
    [],
  );

  await run(
    db,
    `
    CREATE TABLE IF NOT EXISTS campaign_category_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      categories_json TEXT NOT NULL,
      generated_at TEXT NOT NULL
    )
    `,
    [],
  );

  await run(
    db,
    `
    CREATE TABLE IF NOT EXISTS campaign_city_state (
      city TEXT PRIMARY KEY,
      priority INTEGER NOT NULL DEFAULT 100,
      source TEXT NOT NULL DEFAULT 'env',
      updated_at TEXT NOT NULL
    )
    `,
    [],
  );
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

export type CampaignRunRow = {
  id: number;
  city: string;
  category: string;
  run_at: string;
  diamonds_found: number;
};

/** Persistance matrice campagne (villes × métiers) et cache Groq. */
export class CampaignRepository {
  constructor(private readonly db: sqlite3.Database) {}

  async syncEnvCities(cities: readonly string[]): Promise<void> {
    const now = new Date().toISOString();
    for (const city of cities) {
      const c = city.trim();
      if (!c) continue;
      await run(
        this.db,
        `INSERT OR IGNORE INTO campaign_city_state (city, priority, source, updated_at)
         VALUES (?, 100, 'env', ?)`,
        [c, now],
      );
    }
  }

  async upsertGroqCities(cities: readonly string[]): Promise<void> {
    const now = new Date().toISOString();
    for (const city of cities) {
      const c = city.trim();
      if (!c) continue;
      await run(
        this.db,
        `INSERT INTO campaign_city_state (city, priority, source, updated_at)
         VALUES (?, 100, 'groq', ?)
         ON CONFLICT(city) DO UPDATE SET
           priority = CASE WHEN priority <= 0 THEN 100 ELSE priority END,
           source = 'groq',
           updated_at = excluded.updated_at`,
        [c, now],
      );
    }
  }

  async getActiveCities(): Promise<string[]> {
    const rows = await allRows<{ city: string }>(
      this.db,
      `SELECT city FROM campaign_city_state WHERE priority > 0 ORDER BY priority DESC, city ASC`,
      [],
    );
    return rows.map((r) => r.city);
  }

  async deprioritizeCity(city: string): Promise<void> {
    await run(
      this.db,
      `UPDATE campaign_city_state SET priority = 0, updated_at = ? WHERE city = ?`,
      [new Date().toISOString(), city],
    );
  }

  async recordRun(
    city: string,
    category: string,
    diamondsFound: number,
    runAtIso: string,
  ): Promise<void> {
    await run(
      this.db,
      `INSERT INTO campaign_run (city, category, run_at, diamonds_found) VALUES (?, ?, ?, ?)`,
      [city, category, runAtIso, diamondsFound],
    );
  }

  async getLastRunAt(city: string, category: string): Promise<string | null> {
    const row = await getRow(
      this.db,
      `SELECT run_at AS run_at FROM campaign_run WHERE city = ? AND category = ? ORDER BY id DESC LIMIT 1`,
      [city, category],
    );
    if (!row || !('run_at' in row) || typeof (row as { run_at: unknown }).run_at !== 'string') {
      return null;
    }
    return (row as { run_at: string }).run_at;
  }

  async getRunsForCityNewestFirst(city: string): Promise<
    Pick<CampaignRunRow, 'category' | 'diamonds_found'>[]
  > {
    return allRows<{ category: string; diamonds_found: number }>(
      this.db,
      `SELECT category, diamonds_found FROM campaign_run WHERE city = ? ORDER BY id DESC`,
      [city],
    );
  }

  async getLastRunCity(): Promise<string | null> {
    const row = await getRow(
      this.db,
      `SELECT city AS city FROM campaign_run ORDER BY id DESC LIMIT 1`,
      [],
    );
    if (!row || !('city' in row) || typeof (row as { city: unknown }).city !== 'string') return null;
    return (row as { city: string }).city;
  }

  async getCachedCategoryPayload(): Promise<{ categories: string[]; generatedAt: string } | null> {
    const row = await getRow(
      this.db,
      `SELECT categories_json AS categories_json, generated_at AS generated_at FROM campaign_category_cache WHERE id = 1`,
      [],
    );
    if (
      !row ||
      !('categories_json' in row) ||
      typeof (row as { categories_json: unknown }).categories_json !== 'string' ||
      !('generated_at' in row) ||
      typeof (row as { generated_at: unknown }).generated_at !== 'string'
    ) {
      return null;
    }
    try {
      const parsed = JSON.parse((row as { categories_json: string }).categories_json) as unknown;
      if (!Array.isArray(parsed)) return null;
      const categories = parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
      return {
        categories,
        generatedAt: (row as { generated_at: string }).generated_at,
      };
    } catch {
      return null;
    }
  }

  async setCachedCategories(categories: readonly string[], generatedAtIso: string): Promise<void> {
    await run(
      this.db,
      `INSERT INTO campaign_category_cache (id, categories_json, generated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET categories_json = excluded.categories_json, generated_at = excluded.generated_at`,
      [JSON.stringify([...categories]), generatedAtIso],
    );
  }

  async isCategoryCacheFresh(maxAgeDays: number): Promise<boolean> {
    const payload = await this.getCachedCategoryPayload();
    if (!payload) return false;
    const t = Date.parse(payload.generatedAt);
    if (Number.isNaN(t)) return false;
    const maxMs = Math.max(1, Math.min(90, maxAgeDays)) * 86_400_000;
    return Date.now() - t < maxMs;
  }
}

export async function closeDatabase(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

export class ProspectRepository {
  constructor(private readonly db: sqlite3.Database) {}

  async findByUrlAndWeek(
    normalizedUrl: string,
    weekBucket: string,
  ): Promise<CachedProspectScan | null> {
    const row = await getRow(
      this.db,
      `SELECT * FROM prospects WHERE normalized_url = ? AND week_bucket = ? LIMIT 1`,
      [normalizedUrl, weekBucket],
    );
    if (!row) return null;
    return parseCached(row);
  }

  async upsertCompletedScan(scan: ProspectScanUpsert): Promise<void> {
    await run(
      this.db,
      `
      INSERT OR REPLACE INTO prospects (
        normalized_url,
        week_bucket,
        display_url,
        name,
        place_id,
        search_query,
        search_location,
        rating,
        reviews,
        address,
        category,
        psi_strategy,
        psi_raw_json,
        serp_row_json,
        analysis_json,
        scanned_at,
        mode,
        website_source
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `,
      [
        scan.normalizedUrl,
        scan.weekBucket,
        scan.displayUrl,
        scan.name,
        scan.placeId,
        scan.searchQuery,
        scan.searchLocation,
        scan.rating,
        scan.reviews,
        scan.address,
        scan.category,
        scan.psiStrategy,
        JSON.stringify(scan.psi),
        JSON.stringify(scan.serpRow),
        JSON.stringify(scan.analysis),
        scan.scannedAtIso,
        scan.mode,
        scan.websiteSource,
      ],
    );
  }

  /** Évite de re-consommer Serp/Groq sur un « Diamant » déjà traité récemment (24h). */
  async hasRecentDiamondScan(placeKey: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT place_key FROM diamond_rescan_guard WHERE place_key = ?
         AND datetime(last_seen_at) > datetime('now', '-24 hours')
         AND is_diamond = 1`,
        [placeKey],
        (err: Error | null, row: unknown) => {
          if (err) reject(err);
          else resolve(row !== undefined);
        },
      );
    });
  }

  async recordDiamondEncounter(placeKey: string): Promise<void> {
    await run(
      this.db,
      `INSERT OR REPLACE INTO diamond_rescan_guard (place_key, last_seen_at, is_diamond)
       VALUES (?, datetime('now'), 1)`,
      [placeKey],
    );
  }

  /** Dernier traitement dans les N jours (aucune ligne = reprendre le lieu). */
  async getOutcomeWithinLastDays(
    placeKey: string,
    withinDays: number,
  ): Promise<'diamond' | 'disqualified' | null> {
    const dayStr = String(Math.max(1, Math.min(30, withinDays)));
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT outcome FROM radar_place_last_outcome
         WHERE place_key = ?
         AND datetime(recorded_at) > datetime('now', '-' || ? || ' days')`,
        [placeKey, dayStr],
        (err: Error | null, row: unknown) => {
          if (err) reject(err);
          else {
            const raw =
              row &&
              typeof row === 'object' &&
              row !== null &&
              'outcome' in row &&
              typeof (row as { outcome: unknown }).outcome === 'string'
                ? (row as { outcome: string }).outcome
                : null;
            if (raw === 'diamond' || raw === 'disqualified') resolve(raw);
            else resolve(null);
          }
        },
      );
    });
  }

  async recordPlaceOutcome(
    placeKey: string,
    outcome: 'diamond' | 'disqualified',
  ): Promise<void> {
    await run(
      this.db,
      `INSERT OR REPLACE INTO radar_place_last_outcome (place_key, outcome, recorded_at)
       VALUES (?, ?, datetime('now'))`,
      [placeKey, outcome],
    );
  }
}
