function boolFromEnv(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return false;
  const s = String(value).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

/** Chaîne d’env vide / blanche (souvent `vars.*` absent sur GitHub) → undefined. */
function optionalTrimmedNonEmpty(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s === '' ? undefined : s;
}

const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_RADAR_SEARCH_LOCATION = 'Annecy, France';

function groqModelFromEnv(value: unknown): string {
  const t = optionalTrimmedNonEmpty(value);
  return typeof t === 'string' && t.length > 0 ? t : DEFAULT_GROQ_MODEL;
}

function radarSearchLocationFromEnv(value: unknown): string {
  const t = optionalTrimmedNonEmpty(value);
  return typeof t === 'string' && t.length > 0 ? t : DEFAULT_RADAR_SEARCH_LOCATION;
}

function envOptionalIntInRange(min: number, max: number) {
  return (value: unknown): number | undefined => {
    const t = optionalTrimmedNonEmpty(value);
    if (t === undefined) return undefined;
    const n = Number(String(t));
    if (!Number.isFinite(n)) return undefined;
    const i = Math.trunc(n);
    if (i < min || i > max) return undefined;
    return i;
  };
}

function nodeEnvParser(value: unknown): 'development' | 'production' | 'test' {
  const t = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (t === 'development' || t === 'production' || t === 'test') return t;
  return 'development';
}

function nonEmptyString(value: unknown, fallback: string): string {
  const t =
    typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  return t.length > 0 ? t : fallback;
}

function coerceIntInRange(value: unknown, def: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return def;
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  const i = Math.trunc(n);
  if (i < min || i > max) return def;
  return i;
}

function optString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s === '' ? undefined : s;
}

/** Comportement aligné sur l’ancien schéma Zod : absent / vide → `true`. */
function boolFromEnvDefaultTrue(value: unknown): boolean {
  if (value === undefined || value === null || String(value).trim() === '') return true;
  return boolFromEnv(value);
}

function radarStudioOriginFromEnv(value: unknown): string {
  const t =
    typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  const fallback = 'https://www.strate-studio.fr';
  const candidate = t.length > 0 ? t : fallback;
  try {
    void new URL(candidate);
    return candidate;
  } catch {
    return fallback;
  }
}

function radarAuditPayloadVersionFromEnv(value: unknown): string | undefined {
  const t = optionalTrimmedNonEmpty(value);
  if (t === undefined) return undefined;
  const s = String(t);
  if (s.length > 64) {
    throw new Error('RADAR_AUDIT_PAYLOAD_VERSION : max 64 caractères.');
  }
  return s;
}

export type RawEnv = {
  readonly NODE_ENV: 'development' | 'production' | 'test';
  readonly STRATE_RADAR_SIMULATION: boolean;
  readonly GOOGLE_PLACES_API_KEY: string | undefined;
  readonly GOOGLE_PAGESPEED_API_KEY: string | undefined;
  readonly GROQ_API_KEY: string | undefined;
  readonly GROQ_MODEL: string;
  readonly STRATE_RADAR_DB_PATH: string;
  readonly RADAR_SEARCH_Q: string;
  readonly RADAR_SEARCH_LOCATION: string;
  readonly RADAR_REPORT_PATH: string;
  readonly RADAR_SHADOW_EXPORT_PATH: string;
  readonly RADAR_SHADOW_PAGES_DIR: string;
  readonly RADAR_TARGET_DIAMOND_COUNT: number | undefined;
  readonly RADAR_TARGET_CREATION_COUNT: number | undefined;
  readonly RADAR_TARGET_REFONTE_COUNT: number | undefined;
  readonly RADAR_SERP_MAX_PAGES: number;
  readonly RADAR_DIAMOND_LOCATION_HINTS: string | undefined;
  readonly RADAR_USE_SEED_LIST: boolean;
  readonly RADAR_TREND_DRIVEN: boolean;
  readonly RADAR_MAX_PLACES_REQUESTS_PER_RUN: number;
  readonly RADAR_SQLITE_RECENT_DAYS: number;
  readonly RADAR_VERBOSE: boolean;
  readonly RADAR_FETCH_TIMEOUT_MS: number;
  /** Rayon Nearby Search concurrents FOMO (mètres, min 150, max 50 000). */
  readonly RADAR_COMPETITOR_RADIUS_METERS: number;
  readonly RADAR_CAMPAIGN_MODE: boolean;
  readonly TARGET_CITIES: string | undefined;
  readonly RADAR_CAMPAIGN_CATEGORY_CACHE_TTL_DAYS: number;
  readonly RADAR_STUDIO_ORIGIN: string;
  readonly RADAR_INGEST_SECRET: string | undefined;
  readonly RADAR_AUDIT_EXPIRES_AT: string | undefined;
  readonly RADAR_AUDIT_PAYLOAD_VERSION: string | undefined;
  readonly RADAR_INGEST_DEBUG: boolean;
  /**
   * Pause après chaque POST ingest (sauf le dernier du run) pour rester sous le TPM Groq côté vitrine.
   * 0 = désactivé (ex. compte Groq payant).
   */
  readonly RADAR_INGEST_INTERVAL_MS: number;
  /** Timeout client du `fetch` vers l’API d’ingest (ms). */
  readonly RADAR_INGEST_TIMEOUT_MS: number;
};

/** Quotas finaux après résolution legacy (70/30) ou défauts 15 / 5. */
export type LeadQuotaTargets = {
  readonly RADAR_TARGET_CREATION_COUNT: number;
  readonly RADAR_TARGET_REFONTE_COUNT: number;
};

export type AppConfig = Omit<RawEnv, 'RADAR_TARGET_CREATION_COUNT' | 'RADAR_TARGET_REFONTE_COUNT'> &
  LeadQuotaTargets & {
    readonly simulation: boolean;
  };

function parseRawEnv(env: NodeJS.ProcessEnv): RawEnv {
  const optInt1_100 = envOptionalIntInRange(1, 100);
  const optInt0_100 = envOptionalIntInRange(0, 100);

  return {
    NODE_ENV: nodeEnvParser(env.NODE_ENV),
    STRATE_RADAR_SIMULATION: boolFromEnv(env.STRATE_RADAR_SIMULATION),
    GOOGLE_PLACES_API_KEY: optString(env.GOOGLE_PLACES_API_KEY),
    GOOGLE_PAGESPEED_API_KEY: optString(env.GOOGLE_PAGESPEED_API_KEY),
    GROQ_API_KEY: optString(env.GROQ_API_KEY),
    GROQ_MODEL: groqModelFromEnv(env.GROQ_MODEL),
    STRATE_RADAR_DB_PATH: nonEmptyString(env.STRATE_RADAR_DB_PATH, 'data/strate-radar.sqlite'),
    RADAR_SEARCH_Q: nonEmptyString(env.RADAR_SEARCH_Q, 'boulangerie artisanale'),
    RADAR_SEARCH_LOCATION: radarSearchLocationFromEnv(env.RADAR_SEARCH_LOCATION),
    RADAR_REPORT_PATH: nonEmptyString(env.RADAR_REPORT_PATH, 'rapport_matinal.md'),
    RADAR_SHADOW_EXPORT_PATH: nonEmptyString(
      env.RADAR_SHADOW_EXPORT_PATH,
      'data/shadow-sites-export.json',
    ),
    RADAR_SHADOW_PAGES_DIR: nonEmptyString(env.RADAR_SHADOW_PAGES_DIR, 'data/shadow-pages'),
    RADAR_TARGET_DIAMOND_COUNT: optInt1_100(env.RADAR_TARGET_DIAMOND_COUNT),
    RADAR_TARGET_CREATION_COUNT: optInt0_100(env.RADAR_TARGET_CREATION_COUNT),
    RADAR_TARGET_REFONTE_COUNT: optInt0_100(env.RADAR_TARGET_REFONTE_COUNT),
    RADAR_SERP_MAX_PAGES: coerceIntInRange(env.RADAR_SERP_MAX_PAGES, 3, 1, 10),
    RADAR_DIAMOND_LOCATION_HINTS: optString(env.RADAR_DIAMOND_LOCATION_HINTS),
    RADAR_USE_SEED_LIST: boolFromEnvDefaultTrue(env.RADAR_USE_SEED_LIST),
    RADAR_TREND_DRIVEN: boolFromEnvDefaultTrue(env.RADAR_TREND_DRIVEN),
    RADAR_MAX_PLACES_REQUESTS_PER_RUN: coerceIntInRange(
      env.RADAR_MAX_PLACES_REQUESTS_PER_RUN,
      150,
      10,
      500,
    ),
    RADAR_SQLITE_RECENT_DAYS: coerceIntInRange(env.RADAR_SQLITE_RECENT_DAYS, 7, 1, 30),
    RADAR_VERBOSE: boolFromEnvDefaultTrue(env.RADAR_VERBOSE),
    RADAR_FETCH_TIMEOUT_MS: coerceIntInRange(env.RADAR_FETCH_TIMEOUT_MS, 15_000, 3000, 120_000),
    RADAR_COMPETITOR_RADIUS_METERS: coerceIntInRange(
      env.RADAR_COMPETITOR_RADIUS_METERS,
      3500,
      150,
      50_000,
    ),
    RADAR_CAMPAIGN_MODE: boolFromEnv(env.RADAR_CAMPAIGN_MODE),
    TARGET_CITIES: optString(env.TARGET_CITIES),
    RADAR_CAMPAIGN_CATEGORY_CACHE_TTL_DAYS: coerceIntInRange(
      env.RADAR_CAMPAIGN_CATEGORY_CACHE_TTL_DAYS,
      7,
      1,
      90,
    ),
    RADAR_STUDIO_ORIGIN: radarStudioOriginFromEnv(env.RADAR_STUDIO_ORIGIN),
    RADAR_INGEST_SECRET: optString(env.RADAR_INGEST_SECRET),
    RADAR_AUDIT_EXPIRES_AT: optString(env.RADAR_AUDIT_EXPIRES_AT),
    RADAR_AUDIT_PAYLOAD_VERSION: radarAuditPayloadVersionFromEnv(env.RADAR_AUDIT_PAYLOAD_VERSION),
    RADAR_INGEST_DEBUG: boolFromEnv(env.RADAR_INGEST_DEBUG),
    RADAR_INGEST_INTERVAL_MS: coerceIntInRange(env.RADAR_INGEST_INTERVAL_MS, 65_000, 0, 600_000),
    RADAR_INGEST_TIMEOUT_MS: coerceIntInRange(env.RADAR_INGEST_TIMEOUT_MS, 180_000, 10_000, 600_000),
  };
}

function envKeyProvided(key: string, env: NodeJS.ProcessEnv): boolean {
  const v = env[key];
  return v !== undefined && String(v).trim() !== '';
}

/** Legacy seul → 70 % création / 30 % refonte ; sinon défauts 15 et 5 si absents. */
export function resolveLeadQuotaTargets(raw: RawEnv, env: NodeJS.ProcessEnv): LeadQuotaTargets {
  const hasNewC = envKeyProvided('RADAR_TARGET_CREATION_COUNT', env);
  const hasNewR = envKeyProvided('RADAR_TARGET_REFONTE_COUNT', env);
  const legacy = raw.RADAR_TARGET_DIAMOND_COUNT;

  if (!hasNewC && !hasNewR && legacy !== undefined && legacy >= 1) {
    let c = Math.round(legacy * 0.7);
    let r = Math.round(legacy * 0.3);
    const sum = c + r;
    if (sum !== legacy) {
      r = legacy - c;
    }
    if (legacy >= 1 && c === 0 && r === 0) {
      c = 1;
      r = Math.max(0, legacy - 1);
    }
    return {
      RADAR_TARGET_CREATION_COUNT: Math.max(0, c),
      RADAR_TARGET_REFONTE_COUNT: Math.max(0, r),
    };
  }

  return {
    RADAR_TARGET_CREATION_COUNT: raw.RADAR_TARGET_CREATION_COUNT ?? 15,
    RADAR_TARGET_REFONTE_COUNT: raw.RADAR_TARGET_REFONTE_COUNT ?? 5,
  };
}

function validateKeysForLiveMode(raw: RawEnv): void {
  if (raw.STRATE_RADAR_SIMULATION) return;
  const missing: string[] = [];
  if (!raw.GOOGLE_PLACES_API_KEY?.trim()) missing.push('GOOGLE_PLACES_API_KEY');
  if (!raw.GOOGLE_PAGESPEED_API_KEY?.trim()) missing.push('GOOGLE_PAGESPEED_API_KEY');
  if (!raw.GROQ_API_KEY?.trim()) missing.push('GROQ_API_KEY');
  if (missing.length > 0) {
    throw new Error(
      `Mode réel : renseigner dans .env : ${missing.join(', ')} (ou activer STRATE_RADAR_SIMULATION=true)`,
    );
  }
}

/** Compat : ancien nom `RADAR_MAX_SERPAPI_REQUESTS` → `RADAR_MAX_PLACES_REQUESTS_PER_RUN`. */
function normalizePlacesBudgetEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const e = { ...env };
  const legacy = e.RADAR_MAX_SERPAPI_REQUESTS;
  if (
    (e.RADAR_MAX_PLACES_REQUESTS_PER_RUN === undefined ||
      String(e.RADAR_MAX_PLACES_REQUESTS_PER_RUN).trim() === '') &&
    legacy !== undefined &&
    String(legacy).trim() !== ''
  ) {
    e.RADAR_MAX_PLACES_REQUESTS_PER_RUN = String(legacy);
  }
  return e;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw = parseRawEnv(normalizePlacesBudgetEnv(env));
  validateKeysForLiveMode(raw);
  const quotas = resolveLeadQuotaTargets(raw, env);
  if (quotas.RADAR_TARGET_CREATION_COUNT === 0 && quotas.RADAR_TARGET_REFONTE_COUNT === 0) {
    throw new Error(
      'Quotas leads : au moins l’un de RADAR_TARGET_CREATION_COUNT ou RADAR_TARGET_REFONTE_COUNT doit être > 0.',
    );
  }
  return {
    ...raw,
    ...quotas,
    simulation: raw.STRATE_RADAR_SIMULATION,
  };
}
