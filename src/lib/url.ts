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

/** URL absolue http(s) valide pour PageSpeed et les schémas `z.string().url()`. */
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

/**
 * Réseaux sociaux / annuaires / fiches Maps : pas de site « propriétaire » exploitable pour la matrice —
 * le prospect reste sur le chemin « sans site » (Diamant création).
 */
const THIRD_PARTY_HOST_ROOTS: readonly string[] = [
  'facebook.com',
  'fb.com',
  'instagram.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'pinterest.com',
  'youtube.com',
  'youtu.be',
  'snapchat.com',
  'threads.net',
  'linktr.ee',
  'pagesjaunes.fr',
  'pagesjaunes.com',
  'yelp.com',
  'yelp.fr',
  'yelp.ca',
  'foursquare.com',
  'mappy.com',
  'waze.com',
  'wa.me',
  'business.google.com',
  'g.page',
];

function hostMatchesThirdPartyRoot(host: string, root: string): boolean {
  return host === root || host.endsWith(`.${root}`);
}

export function urlIsThirdPartyPresenceOnly(raw: string): boolean {
  try {
    const trimmed = raw.trim();
    if (!trimmed) return false;
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const u = new URL(withProto);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();

    if (/tripadvisor\./i.test(host)) return true;
    if (host === 'maps.google.com') return true;
    if (host === 'google.com' && u.pathname.toLowerCase().startsWith('/maps')) return true;

    for (const root of THIRD_PARTY_HOST_ROOTS) {
      if (hostMatchesThirdPartyRoot(host, root)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
