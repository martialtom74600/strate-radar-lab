/** Normalisation légère pour comparaison nom d’entreprise / domaine / titre. */
export function normalizeForMatch(text: string): string {
  const lowered = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return lowered.replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

const STOP = new Set([
  'le',
  'la',
  'les',
  'de',
  'du',
  'des',
  'et',
  'au',
  'aux',
  'un',
  'une',
  'en',
  'chez',
  'sur',
  'the',
  'and',
  'mock',
]);

/** Tokens significatifs dérivés du nom commercial (longueur ≥ 3, hors stopwords). */
export function tokenizeBusinessName(businessName: string): string[] {
  const norm = normalizeForMatch(businessName);
  return norm
    .split(' ')
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

export type OrganicSerpHit = {
  readonly title: string;
  readonly link: string;
  readonly snippet?: string;
};

const SKIP_HOST_PARTS: readonly string[] = [
  'facebook.',
  'instagram.',
  'linkedin.',
  'google.',
  'googl',
  'tripadvisor.',
  'yelp.',
  'pagesjaunes',
  'pagesjaunesfr',
  'youtube.',
  'tiktok.',
  'twitter.',
  'x.com',
  'pinterest.',
];

function shouldSkipHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return SKIP_HOST_PARTS.some((s) => h.includes(s));
}

/**
 * Choisit une URL organique dont le domaine ou le titre est cohérent avec le nom Maps.
 * Retourne null si aucun résultat ne dépasse le seuil de confiance.
 */
export function pickBestOrganicUrlForBusiness(
  businessName: string,
  results: readonly OrganicSerpHit[],
): string | null {
  const tokens = tokenizeBusinessName(businessName);
  if (tokens.length === 0) return null;

  let best: { readonly url: string; readonly score: number } | null = null;

  for (const hit of results) {
    let hostname = '';
    try {
      const u = new URL(hit.link);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      hostname = u.hostname.toLowerCase();
    } catch {
      continue;
    }

    if (shouldSkipHost(hostname)) continue;

    const hostNoWww = hostname.replace(/^www\./, '');
    const hostFirstLabel = hostNoWww.split('.')[0] ?? hostNoWww;
    const normTitle = normalizeForMatch(hit.title);
    const normSnippet = normalizeForMatch(hit.snippet ?? '');

    let score = 0;
    for (const t of tokens) {
      if (hostFirstLabel.includes(t) || hostNoWww.includes(t)) score += 18;
      if (normTitle.includes(t)) score += 10;
      if (normSnippet.includes(t)) score += 4;
    }

    const minScore = Math.min(24, 12 + tokens.length * 6);
    if (score >= minScore && (!best || score > best.score)) {
      best = { url: hit.link, score };
    }
  }

  return best?.url ?? null;
}
