import type { AppConfig } from '../config/index.js';
import { CampaignRepository } from '../storage/database.js';
import type { GroqClient } from '../services/groq/index.js';
import { StrateRadarError } from './errors.js';

/** Parse `TARGET_CITIES` : séparateur `|` (trim, pas de valeurs vides). */
export function parseTargetCities(raw: string | undefined): string[] {
  if (raw === undefined || raw === null || String(raw).trim() === '') return [];
  return String(raw)
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export type CampaignPair = {
  readonly city: string;
  readonly category: string;
};

const SATURATION_LOW_DIAMONDS = 2;
const SATURATION_DISTINCT_RUNS = 3;

function comparePairs(a: CampaignPair, b: CampaignPair): number {
  const c = a.city.localeCompare(b.city, 'fr');
  if (c !== 0) return c;
  return a.category.localeCompare(b.category, 'fr');
}

/** Choisit la paire (ville, métier) la moins récemment scannée (jamais scanné en premier). */
export async function pickNextCampaignPair(
  repo: CampaignRepository,
  activeCities: readonly string[],
  categories: readonly string[],
): Promise<CampaignPair> {
  if (activeCities.length === 0) {
    throw new StrateRadarError(
      'CAMPAIGN_CITIES',
      'Campagne : aucune ville active (priorité > 0). Élargir la cible ou réinitialiser la base.',
    );
  }
  if (categories.length === 0) {
    throw new StrateRadarError('CAMPAIGN_CATEGORIES', 'Campagne : liste de métiers vide.');
  }

  const sortedCities = [...activeCities].sort((a, b) => a.localeCompare(b, 'fr'));
  const sortedCats = [...categories].sort((a, b) => a.localeCompare(b, 'fr'));

  type Cand = { pair: CampaignPair; lastMs: number | null };
  const cands: Cand[] = [];
  for (const city of sortedCities) {
    for (const category of sortedCats) {
      const lastAt = await repo.getLastRunAt(city, category);
      const lastMs = lastAt !== null ? Date.parse(lastAt) : null;
      cands.push({
        pair: { city, category },
        lastMs: Number.isNaN(lastMs ?? NaN) ? null : lastMs,
      });
    }
  }

  cands.sort((x, y) => {
    if (x.lastMs === null && y.lastMs !== null) return -1;
    if (x.lastMs !== null && y.lastMs === null) return 1;
    if (x.lastMs === null && y.lastMs === null) return comparePairs(x.pair, y.pair);
    const a = x.lastMs ?? 0;
    const b = y.lastMs ?? 0;
    if (a !== b) return a - b;
    return comparePairs(x.pair, y.pair);
  });

  return cands[0]!.pair;
}

async function ensureTradeCategories(
  config: AppConfig,
  repo: CampaignRepository,
  groq: GroqClient,
): Promise<string[]> {
  const ttlDays = config.RADAR_CAMPAIGN_CATEGORY_CACHE_TTL_DAYS;
  if (await repo.isCategoryCacheFresh(ttlDays)) {
    const cached = await repo.getCachedCategoryPayload();
    if (cached !== null && cached.categories.length > 0) return cached.categories;
  }

  const trades = await groq.generateCampaignTradeCategories();
  const at = new Date().toISOString();
  await repo.setCachedCategories(trades, at);
  return trades;
}

/**
 * Si les 3 derniers runs pour cette ville concernent 3 catégories distinctes et < 2 diamants chacun, priorité ville → 0.
 */
export async function applyCampaignSaturationIfNeeded(
  repo: CampaignRepository,
  city: string,
): Promise<boolean> {
  const rows = await repo.getRunsForCityNewestFirst(city);
  const seen = new Set<string>();
  const diamonds: number[] = [];
  for (const r of rows) {
    if (seen.has(r.category)) continue;
    seen.add(r.category);
    diamonds.push(r.diamonds_found);
    if (diamonds.length >= SATURATION_DISTINCT_RUNS) break;
  }
  if (
    diamonds.length === SATURATION_DISTINCT_RUNS &&
    diamonds.every((d) => d < SATURATION_LOW_DIAMONDS)
  ) {
    await repo.deprioritizeCity(city);
    return true;
  }
  return false;
}

/**
 * Ville d’ancrage pour suggestions Groq : dernière campagne en base, sinon `fallbackAnchor` (ex. RADAR_SEARCH_LOCATION depuis le .env).
 */
async function resolveAnchorCity(repo: CampaignRepository, fallbackAnchor: string): Promise<string> {
  const last = await repo.getLastRunCity();
  if (last !== null && last.trim() !== '') return last.trim();
  return fallbackAnchor.trim();
}

/**
 * Synchronise les villes du .env, assure le vivier actif (élargissement Groq si toutes saturées), le cache métiers, puis la paire du prochain run.
 */
export async function resolveNextCampaignPair(
  config: AppConfig,
  repo: CampaignRepository,
  groq: GroqClient,
  options: { readonly bootstrapAnchorCity: string },
): Promise<CampaignPair> {
  const envCities = parseTargetCities(config.TARGET_CITIES);
  await repo.syncEnvCities(envCities);

  let active = await repo.getActiveCities();
  if (active.length === 0) {
    const anchor = await resolveAnchorCity(repo, options.bootstrapAnchorCity);
    const suggested = await groq.suggestNeighborCities(anchor);
    if (suggested.length === 0) {
      throw new StrateRadarError(
        'CAMPAIGN_EXPAND',
        'Campagne : aucune ville active et Groq n’a proposé aucune ville limitrophe.',
      );
    }
    await repo.upsertGroqCities(suggested);
    active = await repo.getActiveCities();
  }

  const categories = await ensureTradeCategories(config, repo, groq);
  return pickNextCampaignPair(repo, active, categories);
}
