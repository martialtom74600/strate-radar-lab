/**
 * Classification structurelle des URLs — plateformes multi-locataires vs domaines dédiés.
 * Ne compare jamais le hostname au nom du commerce.
 */

import { toAbsoluteHttpUrl } from './url.js';

/** Plateformes où un commerce n'a pas son propre site (liste courte, stable). */
export const MULTI_TENANT_PLATFORMS = [
  '118712.fr',
  'data.gouv.fr',
  'deliveroo.fr',
  'doctolib.fr',
  'eatbu.com',
  'facebook.com',
  'foursquare.com',
  'goo.gl',
  'google.com',
  'googleusercontent.com',
  'gstatic.com',
  'infobel.com',
  'instagram.com',
  'lacarte.menu',
  'leboncoin.fr',
  'linkedin.com',
  'mapstr.com',
  'mappy.com',
  'pagesjaunes.fr',
  'pappers.fr',
  'planity.com',
  'search.brave.com',
  'site-solocal.com',
  'societe.com',
  'solocal.com',
  'tiktok.com',
  'tripadvisor.com',
  'tripadvisor.fr',
  'ubereats.com',
  'waze.com',
  'wikidata.org',
  'wikipedia.org',
  'youtube.com',
] as const;

const MULTI_PART_PUBLIC_SUFFIXES = [
  'co.uk',
  'com.au',
  'com.br',
  'gov.fr',
  'gouv.fr',
  'ne.jp',
  'org.uk',
] as const;

export function hostnameFromUrl(raw: string): string | null {
  try {
    const abs = toAbsoluteHttpUrl(raw);
    if (!abs) return null;
    return new URL(abs).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

/** Domaine enregistrable (eTLD+1) — heuristique FR/EU sans dépendance PSL externe. */
export function getRegistrableDomain(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/^www\./, '');
  if (!h || !h.includes('.')) return null;

  const parts = h.split('.');
  for (const suffix of MULTI_PART_PUBLIC_SUFFIXES) {
    const suffixParts = suffix.split('.');
    if (parts.length <= suffixParts.length) continue;
    const tail = parts.slice(-suffixParts.length).join('.');
    if (tail === suffix) {
      return parts.slice(-(suffixParts.length + 1)).join('.');
    }
  }

  if (parts.length >= 2) {
    return parts.slice(-2).join('.');
  }
  return h;
}

export function isSearchNoiseHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h.includes('google.') ||
    h.includes('googleusercontent.') ||
    h.includes('gstatic.') ||
    h.includes('youtube.') ||
    h.includes('wikipedia.org') ||
    h.includes('wikidata.org') ||
    h.includes('search.brave.com')
  );
}

/** URL hébergée sur une plateforme multi-locataire (annuaire, RS, livraison…). */
export function isMultiTenantPlatformHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, '');
  if (!h) return true;
  if (h.includes('order.app.hd.digital')) return true;

  const registrable = getRegistrableDomain(h);
  if (!registrable) return true;

  return (MULTI_TENANT_PLATFORMS as readonly string[]).includes(registrable);
}

/** Domaine propre hors plateformes connues et bruit SERP. */
export function isDedicatedOwnerHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, '');
  if (!h) return false;
  if (isSearchNoiseHost(h)) return false;
  return !isMultiTenantPlatformHost(h);
}

export function isDedicatedOwnerUrl(raw: string): boolean {
  const host = hostnameFromUrl(raw);
  return host !== null && isDedicatedOwnerHost(host);
}

/** Candidats site propre — ordre SERP conservé, un host par domaine enregistrable. */
export function findDedicatedOwnerSiteCandidates(urls: readonly string[]): string[] {
  const seenRegistrable = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const host = hostnameFromUrl(raw);
    if (!host || !isDedicatedOwnerHost(host)) continue;
    const registrable = getRegistrableDomain(host);
    if (!registrable || seenRegistrable.has(registrable)) continue;
    seenRegistrable.add(registrable);
    out.push(raw);
  }
  return out;
}

/** URLs sur plateformes tierces — ordre SERP conservé. */
export function findPlatformPresenceUrls(urls: readonly string[]): string[] {
  const seenRegistrable = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const host = hostnameFromUrl(raw);
    if (!host || !isMultiTenantPlatformHost(host)) continue;
    const registrable = getRegistrableDomain(host);
    if (!registrable || seenRegistrable.has(registrable)) continue;
    seenRegistrable.add(registrable);
    out.push(raw);
  }
  return out;
}

/** Domaines dédiés en tête — annuaires / RS après. */
export function prioritizeUrlsForSerpClassification(urls: readonly string[]): string[] {
  const cleaned = urls.map((url) => url.trim()).filter(Boolean);
  if (cleaned.length <= 1) return cleaned;

  const dedicatedKeys = new Set(
    findDedicatedOwnerSiteCandidates(cleaned).map((url) => url.toLowerCase()),
  );
  const dedicated: string[] = [];
  const rest: string[] = [];
  for (const url of cleaned) {
    if (dedicatedKeys.has(url.toLowerCase())) {
      dedicated.push(url);
    } else {
      rest.push(url);
    }
  }
  return [...dedicated, ...rest];
}

export function presencePlatformFromUrl(raw: string | null | undefined): string | null {
  const host = raw ? hostnameFromUrl(raw) : null;
  if (!host) return null;
  return getRegistrableDomain(host);
}

export type StructuralWebsitePresence =
  | {
      readonly kind: 'resolved';
      readonly status: 'presence_only' | 'none';
      readonly confidence: number;
      readonly reason: string;
      readonly matchedUrl: string | null;
    }
  | {
      readonly kind: 'needs_llm';
      readonly dedicatedUrls: readonly string[];
      readonly platformUrls: readonly string[];
      readonly allUrls: readonly string[];
    };

function hasMeaningfulUrl(urls: readonly string[]): boolean {
  return urls.some((raw) => {
    const host = hostnameFromUrl(raw);
    return host !== null && !isSearchNoiseHost(host);
  });
}

/**
 * Décision sans LLM quand le SERP ne contient que des plateformes ou rien d'utile.
 * Si un domaine dédié apparaît → délègue au LLM (franchise / portail ville / annuaire vertical).
 */
export function assessStructuralWebsitePresence(urls: readonly string[]): StructuralWebsitePresence {
  const cleaned = urls.map((url) => url.trim()).filter(Boolean);
  const dedicated = findDedicatedOwnerSiteCandidates(cleaned);
  const platform = findPlatformPresenceUrls(cleaned);

  if (dedicated.length > 0) {
    return {
      kind: 'needs_llm',
      dedicatedUrls: dedicated,
      platformUrls: platform,
      allUrls: cleaned,
    };
  }

  if (platform.length > 0) {
    const matched = platform[0]!;
    const host = hostnameFromUrl(matched);
    const registrable = host ? getRegistrableDomain(host) : null;
    return {
      kind: 'resolved',
      status: 'presence_only',
      confidence: 0.95,
      reason: registrable
        ? `Présence sur plateforme tierce (${registrable}) — aucun domaine dédié dans les résultats.`
        : 'Présence sur plateforme tierce — aucun domaine dédié dans les résultats.',
      matchedUrl: matched,
    };
  }

  if (!hasMeaningfulUrl(cleaned)) {
    return {
      kind: 'resolved',
      status: 'none',
      confidence: 0,
      reason: cleaned.length === 0
        ? 'Aucune URL organique à analyser.'
        : 'Aucune URL pertinente (bruit SERP ou résultats vides).',
      matchedUrl: null,
    };
  }

  return {
    kind: 'needs_llm',
    dedicatedUrls: [],
    platformUrls: [],
    allUrls: cleaned,
  };
}
