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

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  STRATE_RADAR_SIMULATION: z.preprocess(boolFromEnv, z.boolean()).default(false),
  /** Clé API Google Cloud — Places API (Text Search). Remplace SerpApi en mode réel. */
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  /** @deprecated Conservé pour scripts / anciens .env ; non requis si GOOGLE_PLACES_API_KEY est défini. */
  SERPAPI_API_KEY: z.string().optional(),
  GOOGLE_PAGESPEED_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.preprocess(groqModelFromEnv, z.string().min(1)),
  SERPAPI_CONCURRENCY: z.coerce.number().int().positive().max(50).default(3),
  PAGESPEED_CONCURRENCY: z.coerce.number().int().positive().max(50).default(2),
  STRATE_RADAR_DB_PATH: z.string().min(1).default('data/strate-radar.sqlite'),
  RADAR_SEARCH_Q: z.string().min(1).default('boulangerie artisanale'),
  RADAR_SEARCH_LOCATION: z.preprocess(radarSearchLocationFromEnv, z.string().min(1)),
  RADAR_REPORT_PATH: z.string().min(1).default('rapport_matinal.md'),
  /** Export JSON pour génération « shadow site » (pépites du jour). */
  RADAR_SHADOW_EXPORT_PATH: z.string().min(1).default('data/shadow-sites-export.json'),
  /** Dossier cible pour `npm run generate:shadows` (pas généré par le run radar). */
  RADAR_SHADOW_PAGES_DIR: z.string().min(1).default('data/shadow-pages'),
  /** Domaine Google (mocks / ancien flux SerpApi — optionnel). */
  SERPAPI_GOOGLE_DOMAIN: z.preprocess(
    optionalTrimmedNonEmpty,
    z.string().min(1).optional(),
  ),
  /** Objectif de profils « Diamant » par run (pagination Places jusqu’à concurrence). */
  RADAR_TARGET_DIAMOND_COUNT: z.coerce.number().int().min(1).max(20).default(5),
  /** Pages Text Search max par intention (≈ 20 résultats/page — garde-fou coûts). */
  RADAR_SERP_MAX_PAGES: z.coerce.number().int().min(1).max(10).default(3),
  /** Sous-chaînes pour valider la zone (adresse / titre Maps), séparées par des virgules. */
  RADAR_DIAMOND_LOCATION_HINTS: z.preprocess(
    optionalTrimmedNonEmpty,
    z.string().optional(),
  ),
  /** Enchaîne les catégories `DIAMOND_SEED_CATEGORIES` + ville (si trend-driven désactivé). */
  RADAR_USE_SEED_LIST: z.preprocess(boolFromEnv, z.boolean()).default(true),
  /** Prospection pilotée par Google Suggest (intentions locales du moment) — remplace le grainage statique quand actif. */
  RADAR_TREND_DRIVEN: z.preprocess(boolFromEnv, z.boolean()).default(true),
  /** Plafond appels Places Text Search (pack local + recherche « organique » site) par run — interne, pas la facturation Google. */
  RADAR_MAX_SERPAPI_REQUESTS: z.coerce.number().int().min(10).max(500).default(150),
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

export type AppConfig = RawEnv & {
  readonly simulation: boolean;
};

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = baseEnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors;
    throw new Error(`Configuration invalide : ${JSON.stringify(msg)}`);
  }
  const raw = parsed.data;
  validateKeysForLiveMode(raw);
  return {
    ...raw,
    simulation: raw.STRATE_RADAR_SIMULATION,
  };
}
