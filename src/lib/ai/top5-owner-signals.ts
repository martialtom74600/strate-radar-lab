/**
 * Signaux structurels post-Jina — Palier 2 (hybride sûr).
 * Aucune liste métier en dur : normalisation algorithmique + inclusion stricte.
 * Voie rapide : homepage + domaine aligné (inclusion) + contenu confirmé.
 * Sinon : hints injectés dans Groq.
 */

import {
  getRegistrableDomain,
  hostnameFromUrl,
  isDedicatedOwnerUrl,
} from '../host-presence.js';

/** Longueur minimale pour un match inclusion (paramètre algo, pas une blocklist). */
const MIN_INCLUSION_LENGTH = 5;

export type StructuralOwnerSiteHints = {
  readonly registrable: string | null;
  readonly domainAligned: boolean;
  readonly homepage: boolean;
  readonly contentClean: boolean;
  readonly strongNamePresence: boolean;
  readonly directoryStylePath: boolean;
};

export type StructuralOwnerSiteSignal = {
  readonly strong: boolean;
  readonly confidence: number;
  readonly reason: string;
  readonly hints: StructuralOwnerSiteHints;
};

const EMPTY_HINTS: StructuralOwnerSiteHints = {
  registrable: null,
  domainAligned: false,
  homepage: false,
  contentClean: false,
  strongNamePresence: false,
  directoryStylePath: false,
};

/**
 * Normalise une chaîne : minuscules, sans accents, sans espaces ni ponctuation.
 * Ex. "L'Arbre à Fées" → "larbreafees", "annecy-mobilites.fr" (sans TLD) → "annecymobilites".
 */
export function normalizeAlphanumeric(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Slug du domaine enregistrable (partie avant le TLD). */
export function domainSlugFromRegistrable(registrable: string): string {
  const host = registrable.toLowerCase().replace(/^www\./, '');
  const dot = host.indexOf('.');
  const label = dot > 0 ? host.slice(0, dot) : host;
  return normalizeAlphanumeric(label);
}

/**
 * Match strict par inclusion (domaine ↔ commerce) après normalisation.
 * "Annecy Assistance" (annecyassistance…) ⊄ "annecy-mobilites" (annecymobilites) → false → Groq.
 */
export function domainMatchesBusinessName(registrable: string, businessName: string): boolean {
  const domainSlug = domainSlugFromRegistrable(registrable);
  const businessSlug = normalizeAlphanumeric(businessName);

  if (domainSlug.length === 0 || businessSlug.length === 0) return false;

  const shorter = domainSlug.length <= businessSlug.length ? domainSlug : businessSlug;
  if (shorter.length < MIN_INCLUSION_LENGTH) return false;

  return domainSlug.includes(businessSlug) || businessSlug.includes(domainSlug);
}

function extractH1(markdown: string): string | null {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match?.[1]?.trim() ?? null;
}

/** Le contenu cite le commerce ou le slug domaine (même normalisation). */
export function contentConfirmsBusinessName(args: {
  readonly markdown: string;
  readonly companyName: string;
  readonly registrable: string;
}): boolean {
  const sample = args.markdown.slice(0, 8_000);
  const mdSlug = normalizeAlphanumeric(sample);
  const businessSlug = normalizeAlphanumeric(args.companyName);
  const domainSlug = domainSlugFromRegistrable(args.registrable);

  const slugInText = (slug: string): boolean =>
    slug.length >= MIN_INCLUSION_LENGTH && mdSlug.includes(slug);

  if (slugInText(businessSlug)) return true;
  if (slugInText(domainSlug)) return true;

  const h1 = extractH1(sample);
  if (!h1) return false;

  const h1Slug = normalizeAlphanumeric(h1);
  if (h1Slug.length < MIN_INCLUSION_LENGTH) return false;

  if (businessSlug.length >= MIN_INCLUSION_LENGTH) {
    if (h1Slug.includes(businessSlug) || businessSlug.includes(h1Slug)) return true;
  }
  if (domainSlug.length >= MIN_INCLUSION_LENGTH) {
    if (h1Slug.includes(domainSlug) || domainSlug.includes(h1Slug)) return true;
  }

  return false;
}

/** URL strictement à la racine — toute sous-page annule la voie rapide. */
export function isHomepageUrl(url: string): boolean {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    const path = parsed.pathname.replace(/\/+$/, '');
    return path === '' || path === '/';
  } catch {
    return false;
  }
}

/**
 * Chemin typique listing — heuristique structurelle (profondeur / segments), sans liste de mots.
 */
export function isDirectoryStylePath(url: string): boolean {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    const path = parsed.pathname.toLowerCase();
    if (path === '/' || path === '') return false;

    const segments = path.split('/').filter(Boolean);
    if (segments.length >= 3) return true;
    if (segments.length === 2 && /^[0-9]{2,3}$/.test(segments[0] ?? '')) return true;
    if (segments.length === 2) {
      const [first, second] = segments;
      if (
        first &&
        second &&
        first.length >= 3 &&
        first.length <= 30 &&
        second.length >= 8 &&
        /^[a-z0-9-]+$/.test(first) &&
        /^[a-z0-9-]+$/.test(second)
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function buildFastPathReason(registrable: string): string {
  return `[structure] Page d'accueil de ${registrable} — domaine aligné au commerce, contenu confirmé (voie rapide).`;
}

export function formatStructuralHintsForGroq(hints: StructuralOwnerSiteHints): string | null {
  if (!hints.registrable) return null;

  return [
    `- Domaine ${hints.registrable} aligné au nom (inclusion normalisée) : ${hints.domainAligned ? 'oui' : 'non'}`,
    `- URL page d'accueil (/) : ${hints.homepage ? 'oui' : 'non'}`,
    `- Nom confirmé dans le contenu : ${hints.strongNamePresence ? 'oui' : 'non'}`,
    `- Chemin type listing (profondeur / structure) : ${hints.directoryStylePath ? 'oui' : 'non'}`,
    '(Ces indices ne constituent pas une décision — tu tranches sur le contenu.)',
  ].join('\n');
}

/**
 * Voie rapide si et seulement si :
 * 1. inclusion domaine ↔ commerce, 2. homepage, 3. contenu confirme le nom.
 */
export function assessStructuralOwnerSiteSignal(args: {
  readonly companyName: string;
  readonly city: string | null;
  readonly url: string;
  readonly markdown: string;
}): StructuralOwnerSiteSignal {
  const none = { strong: false, confidence: 0, reason: '', hints: EMPTY_HINTS };

  if (!isDedicatedOwnerUrl(args.url)) return none;

  const host = hostnameFromUrl(args.url);
  const registrable = host ? getRegistrableDomain(host) : null;
  if (!host || !registrable) return none;

  const directoryStylePath = isDirectoryStylePath(args.url);
  const domainAligned = domainMatchesBusinessName(registrable, args.companyName);
  const homepage = isHomepageUrl(args.url);
  const strongNamePresence = contentConfirmsBusinessName({
    markdown: args.markdown,
    companyName: args.companyName,
    registrable,
  });
  const contentClean = strongNamePresence;

  const hints: StructuralOwnerSiteHints = {
    registrable,
    domainAligned,
    homepage,
    contentClean,
    strongNamePresence,
    directoryStylePath,
  };

  if (domainAligned && homepage && contentClean && !directoryStylePath) {
    return {
      strong: true,
      confidence: 0.92,
      reason: buildFastPathReason(registrable),
      hints,
    };
  }

  return { strong: false, confidence: 0, reason: '', hints };
}

/** Score de priorité — homepage + domaine aligné en tête, chemins profonds en queue. */
export function scoreOwnerCandidateUrl(url: string, companyName: string): number {
  const host = hostnameFromUrl(url);
  const registrable = host ? getRegistrableDomain(host) : null;
  if (!registrable) return 0;

  let score = 0;
  if (domainMatchesBusinessName(registrable, companyName)) score += 20;
  if (isHomepageUrl(url)) score += 8;
  if (isDirectoryStylePath(url)) score -= 15;

  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    const depth = parsed.pathname.split('/').filter(Boolean).length;
    if (depth === 1 && !isDirectoryStylePath(url)) score += 2;
  } catch {
    // ignore
  }

  return score;
}
