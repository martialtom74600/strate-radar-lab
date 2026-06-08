import {
  classifyWebsiteUrl,
  parseOwnerWebsiteUrl,
} from './website-presence-taxonomy.js';

export {
  assessMandatoryBookingPlatformExclusion,
  assessMandatoryBookingPlatformUrl,
  assessPresencePipelineSkip,
  assessResolutionPresenceSkip,
  classifySearchResultHit,
  classifyWebsiteUrl,
  isBookingPlatformLabel,
  htmlEmbedsBookingPlatform,
  isBookingPresenceClassified,
  isKnownPresenceHost,
  organicSearchSkipHostMarkers,
  pickBestPresenceCandidate,
  parseOwnerWebsiteUrl,
  parsePresenceSkipPolicy,
  type ClassifiedWebsiteUrl,
  type PresencePainFamily,
  type PresencePipelineSkipAssessment,
  type PresenceSkipPolicy,
  type WebsitePresenceStatus,
  type WebsiteUrlClass,
} from './website-presence-taxonomy.js';

/**
 * Normalise une URL prospect pour la déduplication (hôte sans www, chemin sans slash final inutile, sans query/hash).
 */
export function normalizeProspectUrl(raw: string): string | null {
  try {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const u = new URL(withProto);
    if (!u.hostname) return null;
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    let pathName = u.pathname || '/';
    if (pathName.length > 1 && pathName.endsWith('/')) {
      pathName = pathName.slice(0, -1);
    }
    return `${host}${pathName}`;
  } catch {
    return null;
  }
}

/** URL absolue http(s) valide pour PageSpeed et la config de scan. */
export function toAbsoluteHttpUrl(raw: string): string | null {
  try {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const u = new URL(withProto);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** @deprecated Préférer `classifyWebsiteUrl` — true si présence tierce (réseau, annuaire, plateforme). */
export function urlIsThirdPartyPresenceOnly(raw: string): boolean {
  const c = classifyWebsiteUrl(raw);
  return c?.urlClass === 'presence';
}

export type OwnerWebsiteUrls = {
  readonly displayUrl: string;
  readonly normalizedUrl: string;
};
