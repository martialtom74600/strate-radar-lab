import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(packageRoot, '../..');

/** Charge les `.env` locaux sans écraser les variables déjà définies dans le shell. */
function loadEnvFiles(): void {
  const candidates = [
    path.join(packageRoot, '.env'),
    path.join(packageRoot, '.env.local'),
    path.join(repoRoot, '.env.local'),
    path.join(repoRoot, 'mon-site', '.env.local'),
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      dotenv.config({ path: filePath, override: false });
    }
  }
}

loadEnvFiles();

export { loadConfig, loadScrubConfig, type AppConfig, type LoadScrubConfigOptions, type RawEnv, type LeadQuotaTargets, resolveLeadQuotaTargets } from './env.js';
export {
  DIAMOND_SEED_CATEGORIES,
  buildSeedSearchQuery,
} from './categories.js';
