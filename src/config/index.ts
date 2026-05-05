import dotenv from 'dotenv';

/** Variables déjà définies dans le shell (CI, test) priment sur le fichier `.env`. */
dotenv.config({ override: false });

export { loadConfig, type AppConfig, type RawEnv, type LeadQuotaTargets, resolveLeadQuotaTargets } from './env.js';
export {
  DIAMOND_SEED_CATEGORIES,
  buildSeedSearchQuery,
} from './categories.js';
