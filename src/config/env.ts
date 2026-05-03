import { z } from 'zod';

function boolFromEnv(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return false;
  const s = String(value).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
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
  GROQ_MODEL: z.string().min(1).default('llama-3.3-70b-versatile'),
  SERPAPI_CONCURRENCY: z.coerce.number().int().positive().max(50).default(3),
  PAGESPEED_CONCURRENCY: z.coerce.number().int().positive().max(50).default(2),
  STRATE_RADAR_DB_PATH: z.string().min(1).default('data/strate-radar.sqlite'),
  RADAR_SEARCH_Q: z.string().min(1).default('boulangerie artisanale'),
  RADAR_SEARCH_LOCATION: z.string().min(1).default('Annecy, France'),
  RADAR_REPORT_PATH: z.string().min(1).default('rapport_matinal.md'),
  /** Export JSON pour génération « shadow site » (pépites du jour). */
  RADAR_SHADOW_EXPORT_PATH: z.string().min(1).default('data/shadow-sites-export.json'),
  /** Dossier des landing HTML « Shadow Pages » (audit express). */
  RADAR_SHADOW_PAGES_DIR: z.string().min(1).default('data/shadow-pages'),
  /** Après export JSON, générer automatiquement les HTML Shadow Pages. */
  RADAR_AUTO_GENERATE_SHADOW_PAGES: z.preprocess(boolFromEnv, z.boolean()).default(true),
  /** Domaine Google (mocks / ancien flux SerpApi — optionnel). */
  SERPAPI_GOOGLE_DOMAIN: z.string().min(1).optional(),
  /** Objectif de profils « Diamant » par run (pagination Places jusqu’à concurrence). */
  RADAR_TARGET_DIAMOND_COUNT: z.coerce.number().int().min(1).max(20).default(5),
  /** Pages Text Search max par intention (≈ 20 résultats/page — garde-fou coûts). */
  RADAR_SERP_MAX_PAGES: z.coerce.number().int().min(1).max(10).default(3),
  /** Sous-chaînes pour valider la zone (adresse / titre Maps), séparées par des virgules. */
  RADAR_DIAMOND_LOCATION_HINTS: z.string().optional(),
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
