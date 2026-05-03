/**
 * Trend Catcher — intentions de recherche locales via Google Suggest (endpoint public, gratuit).
 * @see https://suggestqueries.google.com/complete/search?client=chrome&q=
 */

const SUGGEST_URL = 'https://suggestqueries.google.com/complete/search';

/** Mots d’intention croisés avec la zone (RADAR_SEARCH_LOCATION). */
export const TREND_INTENTION_TRIGGERS = [
  // --- LES URGENCES & BESOINS IMMÉDIATS ---
  'urgence',
  'réparation',
  'dépannage',
  'assistance',
  'sos',
  'panne',

  // --- LES PROJETS & TRAVAUX (Forte valeur ajoutée) ---
  'devis',
  'installation',
  'rénovation',
  'sur mesure',
  'aménagement',
  'pose',
  'constructeur',
  'artisan',
  'entretien',

  // --- LES SERVICES B2B & EXPERTISE (High-Ticket) ---
  'spécialiste',
  'expert',
  'entreprise de',
  'cabinet',
  'agence',
  'consultant',
  'fournisseur',
  'grossiste',
  'avocat',
  'architecte',

  // --- LA SANTÉ & LE BIEN-ÊTRE (Prise de RDV) ---
  'consultation',
  'centre de',
  'thérapeute',
  'clinique',
  'soin',
  'praticien',

  // --- LE LOISIR, L'HÔTELLERIE & L'ÉVÉNEMENTIEL ---
  'location',
  'réserver',
  'réservation',
  'privatisation',
  'brunch',
  'dégustation',
  'domaine',

  // --- LA COMPARAISON & LA QUALITÉ ---
  'meilleur',
  'prix',
  'tarif',
  'haut de gamme',
  'luxe',
] as const;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export type CatchTrendsOptions = {
  readonly simulation: boolean;
  /** Requête de secours (ex. RADAR_SEARCH_Q) pour enrichir les mocks / padding. */
  readonly fallbackQuery?: string;
  /** Timeout par requête suggest (ms). */
  readonly timeoutMs?: number;
  /** Nombre max d’intentions retournées (défaut 10). */
  readonly limit?: number;
};

function primaryLocality(radarLocation: string): string {
  const first = radarLocation.split(',')[0]?.trim() ?? radarLocation.trim();
  return first.length > 0 ? first : radarLocation.trim();
}

function localityTokens(radarLocation: string): string[] {
  const raw = radarLocation
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const tokens = new Set<string>();
  for (const part of raw) {
    const norm = normalizeForStrip(part);
    if (norm.length > 2) tokens.add(norm);
    for (const w of norm.split(/\s+/)) {
      if (w.length > 2) tokens.add(w);
    }
  }
  const city = normalizeForStrip(primaryLocality(radarLocation));
  if (city.length > 2) tokens.add(city);
  return [...tokens];
}

function normalizeForStrip(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanSuggestion(raw: string, localityNorms: readonly string[]): string {
  let s = raw.trim();
  if (!s) return '';
  let norm = normalizeForStrip(s);
  const sortedLocs = [...localityNorms].sort((a, b) => b.length - a.length);
  for (const loc of sortedLocs) {
    if (loc.length < 3) continue;
    const re = new RegExp(`\\b${escapeRe(loc)}\\b`, 'gi');
    norm = norm.replace(re, ' ').replace(/\s+/g, ' ').trim();
  }
  norm = norm
    .replace(/\bfrance\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return norm.length > 0 ? norm : normalizeForStrip(s);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSuggestBody(text: string): string[] {
  const trimmed = text.trim();
  let data: unknown;
  try {
    data = JSON.parse(trimmed) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(data) || data.length < 2) return [];
  const second = data[1];
  if (!Array.isArray(second)) return [];
  return second.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

async function fetchSuggestionsForQuery(
  q: string,
  timeoutMs: number,
): Promise<readonly string[]> {
  const url = `${SUGGEST_URL}?client=chrome&hl=fr&gl=fr&q=${encodeURIComponent(q)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json,text/javascript,*/*',
      },
    });
    if (!res.ok) return [];
    return parseSuggestBody(await res.text());
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

/** Données déterministes hors réseau (mode simulation / secours). */
export function mockLocalSearchIntentions(
  radarLocation: string,
  fallbackQuery: string,
): string[] {
  const city = primaryLocality(radarLocation);
  const base = [
    `urgence plomberie ${city}`,
    `dépannage chauffage ${city}`,
    `réparation électroménager ${city}`,
    `devis rénovation ${city}`,
    `installation cuisine ${city}`,
    `location matériel ${city}`,
    `meilleur artisan ${city}`,
    `spécialiste fuite ${city}`,
    `réparation voiture ${city}`,
    `dépannage serrure ${city}`,
  ];
  const out = [...base];
  const fq = fallbackQuery?.trim();
  if (fq && !out.some((x) => x.toLowerCase().includes(fq.toLowerCase()))) {
    out.push(`${fq} ${city}`);
  }
  return out.slice(0, 10);
}

/**
 * Agrège les suggestions Google, nettoie le nom de ville, retourne les ~10 intentions les plus « fortes »
 * (score = récurrence inter-déclencheurs + position dans la liste suggest).
 */
export async function catchLocalSearchIntentions(
  radarLocation: string,
  options: CatchTrendsOptions,
): Promise<string[]> {
  const limit = options.limit ?? 10;
  const timeoutMs = options.timeoutMs ?? 8_000;

  if (options.simulation) {
    return mockLocalSearchIntentions(radarLocation, options.fallbackQuery ?? '');
  }

  const city = primaryLocality(radarLocation);
  const localityNorms = localityTokens(radarLocation);
  const scores = new Map<string, number>();

  for (const trigger of TREND_INTENTION_TRIGGERS) {
    const q = `${trigger} ${city}`.trim();
    const suggestions = await fetchSuggestionsForQuery(q, timeoutMs);
    suggestions.forEach((suggestion, index) => {
      const cleaned = cleanSuggestion(suggestion, localityNorms);
      if (cleaned.length < 4) return;
      const weight = Math.max(0, 24 - index);
      scores.set(cleaned, (scores.get(cleaned) ?? 0) + weight + 2);
    });
    await sleep(80);
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([text]) => text);
  return ranked.slice(0, limit);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Complète une liste trop courte avec la requête de secours + ville. */
export function padTrendQueries(
  trends: readonly string[],
  radarLocation: string,
  fallbackQuery: string,
): string[] {
  const city = primaryLocality(radarLocation);
  const seen = new Set(trends.map((t) => t.toLowerCase()));
  const out = [...trends];
  const fq = fallbackQuery?.trim();
  if (fq) {
    const pad = `${fq} ${city}`.trim();
    if (!seen.has(pad.toLowerCase())) {
      out.push(pad);
      seen.add(pad.toLowerCase());
    }
  }
  for (const trig of TREND_INTENTION_TRIGGERS) {
    if (out.length >= 10) break;
    const p = `${trig} ${city}`.trim();
    if (!seen.has(p.toLowerCase())) {
      out.push(p);
      seen.add(p.toLowerCase());
    }
  }
  return out.slice(0, 10);
}
