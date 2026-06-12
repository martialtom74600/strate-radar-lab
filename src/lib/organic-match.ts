/** Normalisation légère pour comparaison nom d'entreprise / titre Maps. */
export function normalizeForMatch(text: string): string {
  const lowered = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return lowered.replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

const ARTICLE_STOP_WORDS = new Set([
  'le',
  'la',
  'les',
  'l',
  'd',
  'de',
  'des',
  'du',
  'a',
  'au',
  'aux',
  'et',
  'en',
  'un',
  'une',
  'chez',
  'sur',
  'the',
  'and',
]);

/** Tokenise un nom commercial pour le matching ciblé prospect ↔ Maps. */
export function tokenizeBusinessName(businessName: string): readonly string[] {
  return normalizeForMatch(businessName)
    .split(' ')
    .filter((word) => word.length >= 3 && !ARTICLE_STOP_WORDS.has(word));
}
