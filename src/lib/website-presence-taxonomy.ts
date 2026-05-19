export type WebsitePresenceStatus = 'owner_site' | 'presence_only' | 'none';

export type WebsiteUrlClass = 'owner' | 'presence' | 'invalid';

export type ClassifiedWebsiteUrl = {
  readonly urlClass: WebsiteUrlClass;
  readonly displayUrl: string;
  readonly normalizedUrl: string;
  /** Libellé plateforme si `presence` (ex. Doctolib). */
  readonly platformLabel: string | null;
};

function normalizeProspectUrl(raw: string): string | null {
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

function toAbsoluteHttpUrl(raw: string): string | null {
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

type PlatformRoot = {
  readonly root: string;
  readonly label: string;
};

/** Réseaux sociaux, annuaires et plateformes de prise de rendez-vous / réservation. */
const PRESENCE_PLATFORM_ROOTS: readonly PlatformRoot[] = [
  { root: 'facebook.com', label: 'Facebook' },
  { root: 'fb.com', label: 'Facebook' },
  { root: 'instagram.com', label: 'Instagram' },
  { root: 'linkedin.com', label: 'LinkedIn' },
  { root: 'twitter.com', label: 'X / Twitter' },
  { root: 'x.com', label: 'X / Twitter' },
  { root: 'tiktok.com', label: 'TikTok' },
  { root: 'pinterest.com', label: 'Pinterest' },
  { root: 'youtube.com', label: 'YouTube' },
  { root: 'youtu.be', label: 'YouTube' },
  { root: 'snapchat.com', label: 'Snapchat' },
  { root: 'threads.net', label: 'Threads' },
  { root: 'linktr.ee', label: 'Linktree' },
  { root: 'pagesjaunes.fr', label: 'PagesJaunes' },
  { root: 'pagesjaunes.com', label: 'PagesJaunes' },
  { root: 'yelp.com', label: 'Yelp' },
  { root: 'yelp.fr', label: 'Yelp' },
  { root: 'yelp.ca', label: 'Yelp' },
  { root: 'foursquare.com', label: 'Foursquare' },
  { root: 'mappy.com', label: 'Mappy' },
  { root: 'waze.com', label: 'Waze' },
  { root: 'wa.me', label: 'WhatsApp' },
  { root: 'business.google.com', label: 'Google Business' },
  { root: 'g.page', label: 'Google Business' },
  { root: 'doctolib.fr', label: 'Doctolib' },
  { root: 'doctolib.com', label: 'Doctolib' },
  { root: 'planity.com', label: 'Planity' },
  { root: 'maiia.com', label: 'Maiia' },
  { root: 'keldoc.com', label: 'Keldoc' },
  { root: 'lafourchette.com', label: 'TheFork' },
  { root: 'thefork.com', label: 'TheFork' },
  { root: 'thefork.fr', label: 'TheFork' },
  { root: 'opentable.com', label: 'OpenTable' },
  { root: 'opentable.fr', label: 'OpenTable' },
  { root: 'resy.com', label: 'Resy' },
  { root: 'maisonsmedicale.com', label: 'MaisonsMedicale.com' },
  { root: 'doctoranytime.fr', label: 'DoctorAnytime' },
  { root: 'doctoralia.fr', label: 'Doctoralia' },
  { root: 'zocdoc.com', label: 'Zocdoc' },
  { root: 'booking.com', label: 'Booking.com' },
  { root: 'hotels.com', label: 'Hotels.com' },
  { root: 'airbnb.com', label: 'Airbnb' },
  { root: 'airbnb.fr', label: 'Airbnb' },
  { root: 'deliveroo.fr', label: 'Deliveroo' },
  { root: 'ubereats.com', label: 'Uber Eats' },
  { root: 'just-eat.fr', label: 'Just Eat' },
];

function hostMatchesRoot(host: string, root: string): boolean {
  return host === root || host.endsWith(`.${root}`);
}

function hostnameFromRaw(raw: string): string | null {
  try {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(withProto).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

function presencePlatformForHost(host: string): PlatformRoot | null {
  if (/tripadvisor\./i.test(host)) {
    return { root: 'tripadvisor', label: 'Tripadvisor' };
  }
  if (host === 'maps.google.com') {
    return { root: 'maps.google.com', label: 'Google Maps' };
  }
  for (const p of PRESENCE_PLATFORM_ROOTS) {
    if (hostMatchesRoot(host, p.root)) return p;
  }
  return null;
}

/** Classe une URL absolue : site propriétaire, présence tierce ou invalide. */
export function classifyWebsiteUrl(raw: string): ClassifiedWebsiteUrl | null {
  const displayUrl = toAbsoluteHttpUrl(raw.trim());
  if (!displayUrl) return null;
  const normalizedUrl = normalizeProspectUrl(displayUrl);
  if (!normalizedUrl) return null;

  const host = hostnameFromRaw(displayUrl);
  if (!host) return null;

  if (host === 'google.com') {
    try {
      const u = new URL(displayUrl);
      if (u.pathname.toLowerCase().startsWith('/maps')) {
        return {
          urlClass: 'presence',
          displayUrl,
          normalizedUrl,
          platformLabel: 'Google Maps',
        };
      }
    } catch {
      return null;
    }
  }

  const platform = presencePlatformForHost(host);
  if (platform) {
    return {
      urlClass: 'presence',
      displayUrl,
      normalizedUrl,
      platformLabel: platform.label,
    };
  }

  return {
    urlClass: 'owner',
    displayUrl,
    normalizedUrl,
    platformLabel: null,
  };
}

/** @deprecated Préférer `classifyWebsiteUrl`. */
export function parseOwnerWebsiteUrl(raw: string): {
  readonly displayUrl: string;
  readonly normalizedUrl: string;
} | null {
  const c = classifyWebsiteUrl(raw);
  if (!c || c.urlClass !== 'owner') return null;
  return { displayUrl: c.displayUrl, normalizedUrl: c.normalizedUrl };
}
