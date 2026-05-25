import { DIAMOND_SEED_CATEGORIES } from '../../config/categories.js';

/**
 * Métiers à fort potentiel « sans site » — exclus restauration / hôtellerie / promoteurs
 * (saturés en refonte, rares en création sur Annecy d’après les runs nocturnes).
 */
const CREATION_HUNT_SECTOR_BLOCKLIST = new Set(
  [
    'restaurant',
    'hotel',
    'hôtel',
    'immobilier',
    'agence',
    'expert',
    'consultant',
    'avocat',
    'notaire',
    'architecte',
    'comptable',
    'clinique',
    'pharmacie',
    'dentiste',
    'vétérinaire',
    'cabinet',
    'spa',
    'événementiel',
    'formation',
    'transport',
    'taxi',
    'camping',
    'gîte',
    'location',
    'nautisme',
    'bateau',
  ].map((s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()),
);

function normalizeSectorKey(s: string): string {
  return s
    .trim()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/** Vivier artisan / services locaux pour la chasse création (≥ 35 graines). */
export const CREATION_HUNT_SECTORS: readonly string[] = DIAMOND_SEED_CATEGORIES.filter((seed) => {
  const key = normalizeSectorKey(seed);
  if (CREATION_HUNT_SECTOR_BLOCKLIST.has(key)) return false;
  for (const blocked of CREATION_HUNT_SECTOR_BLOCKLIST) {
    if (key.includes(blocked)) return false;
  }
  return true;
});

export function isCreationHuntSectorBlocked(sector: string): boolean {
  const key = normalizeSectorKey(sector);
  if (CREATION_HUNT_SECTOR_BLOCKLIST.has(key)) return true;
  for (const blocked of CREATION_HUNT_SECTOR_BLOCKLIST) {
    if (key.includes(blocked)) return true;
  }
  return false;
}
