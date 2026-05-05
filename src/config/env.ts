import { z } from 'zod';

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

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  STRATE_RADAR_SIMULATION: z.preprocess(boolFromEnv, z.boolean()).default(false),
  /** Clé API Google Cloud — Places API (Text Search). */
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  GOOGLE_PAGESPEED_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.preprocess(groqModelFromEnv, z.string().min(1)),
  STRATE_RADAR_DB_PATH: z.string().min(1).default('data/strate-radar.sqlite'),
  RADAR_SEARCH_Q: z.string().min(1).default('boulangerie artisanale'),
  RADAR_SEARCH_LOCATION: z.preprocess(radarSearchLocationFromEnv, z.string().min(1)),
  RADAR_REPORT_PATH: z.string().min(1).default('rapport_matinal.md'),
  /** Export JSON pour génération « shadow site » (pépites du jour). */
  RADAR_SHADOW_EXPORT_PATH: z.string().min(1).default('data/shadow-sites-export.json'),
  /** Dossier cible pour `npm run generate:shadows` (pas généré par le run radar). */
  RADAR_SHADOW_PAGES_DIR: z.string().min(1).default('data/shadow-pages'),
  /** @deprecated Utiliser RADAR_TARGET_CREATION_COUNT + RADAR_TARGET_REFONTE_COUNT. Si seul ce champ est défini, quotas = 70 % création / 30 % refonte. */
  RADAR_TARGET_DIAMOND_COUNT: z.preprocess(
    envOptionalIntInRange(1, 100),
    z.number().int().min(1).max(100).optional(),
  ),
  /** Objectif de leads « Diamant création » par run. Défaut 15 si non renseigné et pas de legacy. */
  RADAR_TARGET_CREATION_COUNT: z.preprocess(
    envOptionalIntInRange(0, 100),
    z.number().int().min(0).max(100).optional(),
  ),
  /** Objectif de leads « Diamant refonte » (matrice) par run. Défaut 5 si non renseigné et pas de legacy. */
  RADAR_TARGET_REFONTE_COUNT: z.preprocess(
    envOptionalIntInRange(0, 100),
    z.number().int().min(0).max(100).optional(),
  ),
  /** Pages Text Search max par intention (≈ 20 résultats/page — garde-fou coûts). */
  RADAR_SERP_MAX_PAGES: z.coerce.number().int().min(1).max(10).default(3),
  /** @deprecated Non utilisé par le pipeline (zones implicites via la requête Places). Conservé pour compat .env. */
  RADAR_DIAMOND_LOCATION_HINTS: z.preprocess(
    optionalTrimmedNonEmpty,
    z.string().optional(),
  ),
  /** Enchaîne les catégories `DIAMOND_SEED_CATEGORIES` + ville (si trend-driven désactivé). */
  RADAR_USE_SEED_LIST: z.preprocess(boolFromEnv, z.boolean()).default(true),
  /** Prospection pilotée par Google Suggest (intentions locales du moment) — remplace le grainage statique quand actif. */
  RADAR_TREND_DRIVEN: z.preprocess(boolFromEnv, z.boolean()).default(true),
  /**
   * Plafond d’appels Google Places Text Search par run (pack local + résolution « organique » URL).
   * Garde-fou interne, pas la facturation Google.
   */
  RADAR_MAX_PLACES_REQUESTS_PER_RUN: z.coerce.number().int().min(10).max(500).default(150),
  /** Fenêtre SQLite : ignorer un lieu déjà traité sur les N derniers jours. */
  RADAR_SQLITE_RECENT_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  /** Affiche la progression en direct dans le terminal (familles, pages Places, chaque fiche). */
  RADAR_VERBOSE: z.preprocess(boolFromEnv, z.boolean()).default(true),
  /** Timeout fetch HTML pour la matrice Strate (ms). */
  RADAR_FETCH_TIMEOUT_MS: z.coerce.number().int().min(3000).max(120_000).default(15_000),
  /**
   * Pilotage autonome matrice Ville × métier (Groq + SQLite) — désactive Trend Catcher et enchaîne une seule paire par run.
   */
  RADAR_CAMPAIGN_MODE: z.preprocess(boolFromEnv, z.boolean()).default(false),
  /**
   * Villes cibles, séparées par | (ex. `Annecy, France|Lyon, France`). Jamais figé dans le code : uniquement ici ou villes suggérées persistées en base.
   */
  TARGET_CITIES: z.preprocess(optionalTrimmedNonEmpty, z.string().optional()),
  /** Durée de validité du cache Groq des ~50 métiers (jours). */
  RADAR_CAMPAIGN_CATEGORY_CACHE_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  /** Origine du site vitrine Strate Studio (sans slash final). POST = {origin}/api/audits/ingest */
  RADAR_STUDIO_ORIGIN: z.preprocess((v) => {
    const t = optionalTrimmedNonEmpty(v);
    return typeof t === 'string' && t.length > 0 ? t : 'https://www.strate-studio.fr';
  }, z.string().url()),
  /** Secret Bearer partagé avec la route /api/audits/ingest (Authorization: Bearer …). */
  RADAR_INGEST_SECRET: z.preprocess(optionalTrimmedNonEmpty, z.string().optional()),
  /** Optionnel — expiration du lien audit (ISO 8601). */
  RADAR_AUDIT_EXPIRES_AT: z.preprocess(optionalTrimmedNonEmpty, z.string().optional()),
  /** Version du schéma payload envoyé (max 64 caractères). */
  RADAR_AUDIT_PAYLOAD_VERSION: z.preprocess(optionalTrimmedNonEmpty, z.string().max(64).optional()),
  /**
   * Si true : en échec ingest, loggue le corps HTTP brut (tronqué) dans la console — utile quand l’API ne renvoie pas `detail`.
   * À activer ponctuellement (ex. variable dépôt GitHub), ne pas laisser en prod SI le corps pourrait contenir des données sensibles.
   */
  RADAR_INGEST_DEBUG: z.preprocess(boolFromEnv, z.boolean()).default(false),
});

export type RawEnv = z.infer<typeof baseEnvSchema>;

/** Quotas finaux après résolution legacy (70/30) ou défauts 15 / 5. */
export type LeadQuotaTargets = {
  readonly RADAR_TARGET_CREATION_COUNT: number;
  readonly RADAR_TARGET_REFONTE_COUNT: number;
};

export type AppConfig = Omit<RawEnv, 'RADAR_TARGET_CREATION_COUNT' | 'RADAR_TARGET_REFONTE_COUNT'> &
  LeadQuotaTargets & {
    readonly simulation: boolean;
  };

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
    (e.RADAR_MAX_PLACES_REQUESTS_PER_RUN === undefined || String(e.RADAR_MAX_PLACES_REQUESTS_PER_RUN).trim() === '') &&
    legacy !== undefined &&
    String(legacy).trim() !== ''
  ) {
    e.RADAR_MAX_PLACES_REQUESTS_PER_RUN = String(legacy);
  }
  return e;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = baseEnvSchema.safeParse(normalizePlacesBudgetEnv(env));
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors;
    throw new Error(`Configuration invalide : ${JSON.stringify(msg)}`);
  }
  const raw = parsed.data;
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
