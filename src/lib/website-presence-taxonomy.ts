export type WebsitePresenceStatus = 'owner_site' | 'presence_only' | 'none';

export type WebsiteUrlClass = 'owner' | 'presence' | 'invalid';

export type PresencePainFamily =
  | 'health_booking'
  | 'beauty_booking'
  | 'restaurant_booking'
  | 'hospitality_booking'
  | 'social'
  | 'directory'
  | 'maps'
  | 'messaging'
  | 'marketplace';

export type PresencePlatformTraits = {
  readonly bookingGate: boolean;
  readonly feudalDependency: boolean;
};

export type ClassifiedWebsiteUrl = {
  readonly urlClass: WebsiteUrlClass;
  readonly displayUrl: string;
  readonly normalizedUrl: string;
  /** Libellé plateforme si `presence` (ex. Doctolib). */
  readonly platformLabel: string | null;
  readonly painFamily: PresencePainFamily | null;
  readonly traits: PresencePlatformTraits | null;
};

export type PresenceSkipPolicy = 'booking_platforms' | 'all_presence' | 'feudal_booking' | 'off';

export const DEFAULT_PRESENCE_SKIP_POLICY: PresenceSkipPolicy = 'booking_platforms';

const BOOKING_PAIN_FAMILIES: ReadonlySet<PresencePainFamily> = new Set([
  'health_booking',
  'beauty_booking',
  'restaurant_booking',
  'hospitality_booking',
]);

const DIRECTORY_TRAITS: PresencePlatformTraits = {
  bookingGate: false,
  feudalDependency: false,
};

const SOCIAL_TRAITS: PresencePlatformTraits = {
  bookingGate: false,
  feudalDependency: false,
};

const BOOKING_TRAITS: PresencePlatformTraits = {
  bookingGate: true,
  feudalDependency: true,
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
  readonly painFamily: PresencePainFamily;
  readonly traits: PresencePlatformTraits;
};

/** Réseaux sociaux, annuaires et plateformes de prise de rendez-vous / réservation. */
const PRESENCE_PLATFORM_ROOTS: readonly PlatformRoot[] = [
  { root: 'facebook.com', label: 'Facebook', painFamily: 'social', traits: SOCIAL_TRAITS },
  { root: 'fb.com', label: 'Facebook', painFamily: 'social', traits: SOCIAL_TRAITS },
  { root: 'instagram.com', label: 'Instagram', painFamily: 'social', traits: SOCIAL_TRAITS },
  { root: 'linkedin.com', label: 'LinkedIn', painFamily: 'social', traits: SOCIAL_TRAITS },
  { root: 'twitter.com', label: 'X / Twitter', painFamily: 'social', traits: SOCIAL_TRAITS },
  { root: 'x.com', label: 'X / Twitter', painFamily: 'social', traits: SOCIAL_TRAITS },
  { root: 'tiktok.com', label: 'TikTok', painFamily: 'social', traits: SOCIAL_TRAITS },
  { root: 'pinterest.com', label: 'Pinterest', painFamily: 'social', traits: SOCIAL_TRAITS },
  { root: 'youtube.com', label: 'YouTube', painFamily: 'social', traits: SOCIAL_TRAITS },
  { root: 'youtu.be', label: 'YouTube', painFamily: 'social', traits: SOCIAL_TRAITS },
  { root: 'snapchat.com', label: 'Snapchat', painFamily: 'social', traits: SOCIAL_TRAITS },
  { root: 'threads.net', label: 'Threads', painFamily: 'social', traits: SOCIAL_TRAITS },
  { root: 'linktr.ee', label: 'Linktree', painFamily: 'social', traits: SOCIAL_TRAITS },
  { root: 'pagesjaunes.fr', label: 'PagesJaunes', painFamily: 'directory', traits: DIRECTORY_TRAITS },
  { root: 'pagesjaunes.com', label: 'PagesJaunes', painFamily: 'directory', traits: DIRECTORY_TRAITS },
  { root: 'yelp.com', label: 'Yelp', painFamily: 'directory', traits: DIRECTORY_TRAITS },
  { root: 'yelp.fr', label: 'Yelp', painFamily: 'directory', traits: DIRECTORY_TRAITS },
  { root: 'yelp.ca', label: 'Yelp', painFamily: 'directory', traits: DIRECTORY_TRAITS },
  { root: 'foursquare.com', label: 'Foursquare', painFamily: 'directory', traits: DIRECTORY_TRAITS },
  { root: 'mappy.com', label: 'Mappy', painFamily: 'directory', traits: DIRECTORY_TRAITS },
  { root: 'waze.com', label: 'Waze', painFamily: 'maps', traits: SOCIAL_TRAITS },
  { root: 'wa.me', label: 'WhatsApp', painFamily: 'messaging', traits: SOCIAL_TRAITS },
  { root: 'business.google.com', label: 'Google Business', painFamily: 'maps', traits: SOCIAL_TRAITS },
  { root: 'g.page', label: 'Google Business', painFamily: 'maps', traits: SOCIAL_TRAITS },
  { root: 'doctolib.fr', label: 'Doctolib', painFamily: 'health_booking', traits: BOOKING_TRAITS },
  { root: 'doctolib.com', label: 'Doctolib', painFamily: 'health_booking', traits: BOOKING_TRAITS },
  { root: 'planity.com', label: 'Planity', painFamily: 'beauty_booking', traits: BOOKING_TRAITS },
  { root: 'treatwell.fr', label: 'Treatwell', painFamily: 'beauty_booking', traits: BOOKING_TRAITS },
  { root: 'treatwell.com', label: 'Treatwell', painFamily: 'beauty_booking', traits: BOOKING_TRAITS },
  { root: 'maiia.com', label: 'Maiia', painFamily: 'health_booking', traits: BOOKING_TRAITS },
  { root: 'keldoc.com', label: 'Keldoc', painFamily: 'health_booking', traits: BOOKING_TRAITS },
  { root: 'lafourchette.com', label: 'TheFork', painFamily: 'restaurant_booking', traits: BOOKING_TRAITS },
  { root: 'thefork.com', label: 'TheFork', painFamily: 'restaurant_booking', traits: BOOKING_TRAITS },
  { root: 'thefork.fr', label: 'TheFork', painFamily: 'restaurant_booking', traits: BOOKING_TRAITS },
  { root: 'opentable.com', label: 'OpenTable', painFamily: 'restaurant_booking', traits: BOOKING_TRAITS },
  { root: 'opentable.fr', label: 'OpenTable', painFamily: 'restaurant_booking', traits: BOOKING_TRAITS },
  { root: 'resy.com', label: 'Resy', painFamily: 'restaurant_booking', traits: BOOKING_TRAITS },
  { root: 'maisonsmedicale.com', label: 'MaisonsMedicale.com', painFamily: 'health_booking', traits: BOOKING_TRAITS },
  { root: 'doctoranytime.fr', label: 'DoctorAnytime', painFamily: 'health_booking', traits: BOOKING_TRAITS },
  { root: 'doctoralia.fr', label: 'Doctoralia', painFamily: 'health_booking', traits: BOOKING_TRAITS },
  { root: 'zocdoc.com', label: 'Zocdoc', painFamily: 'health_booking', traits: BOOKING_TRAITS },
  { root: 'booking.com', label: 'Booking.com', painFamily: 'hospitality_booking', traits: BOOKING_TRAITS },
  { root: 'hotels.com', label: 'Hotels.com', painFamily: 'hospitality_booking', traits: BOOKING_TRAITS },
  { root: 'airbnb.com', label: 'Airbnb', painFamily: 'hospitality_booking', traits: BOOKING_TRAITS },
  { root: 'airbnb.fr', label: 'Airbnb', painFamily: 'hospitality_booking', traits: BOOKING_TRAITS },
  { root: 'deliveroo.fr', label: 'Deliveroo', painFamily: 'marketplace', traits: SOCIAL_TRAITS },
  { root: 'ubereats.com', label: 'Uber Eats', painFamily: 'marketplace', traits: SOCIAL_TRAITS },
  { root: 'just-eat.fr', label: 'Just Eat', painFamily: 'marketplace', traits: SOCIAL_TRAITS },
];

/** Annuaires locaux / agrégateurs — jamais site propriétaire. */
const DIRECTORY_HOST_MARKERS: readonly string[] = [
  'le-site-de.com',
  'lac-annecy.com',
  'paisible.ai',
  'sanitaire-social.com',
  'bottin.fr',
  '118000.fr',
  'cylex.fr',
  'cylex-locale.fr',
  'hotfrog.fr',
  'tupalo.com',
  'societe.com',
  'verif.com',
  'manageo.fr',
  'infobel.com',
  'hoodspot.fr',
  'petitesaffiches.fr',
  'score3.fr',
  'kompass.com',
  'europages.fr',
  'france-voyage.com',
  'restaurantguru.com',
  'lafourche.fr',
  'carbu.com',
  'stationessence.com',
  'ledauphine.com',
  'lefigaro.fr',
  'annuaire-mairie.fr',
  'annuaire.',
  'horaires.',
];

function directoryLabelForHost(host: string): string | null {
  const h = host.toLowerCase();
  for (const marker of DIRECTORY_HOST_MARKERS) {
    if (marker.endsWith('.')) {
      if (h.includes(marker)) return 'Annuaire';
    } else if (h === marker || h.endsWith(`.${marker}`) || h.includes(marker)) {
      return 'Annuaire';
    }
  }
  return null;
}

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

function normalizePlatformLabel(label: string): string {
  return label
    .trim()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function presencePlatformForHost(host: string): PlatformRoot | null {
  if (/tripadvisor\./i.test(host)) {
    return {
      root: 'tripadvisor',
      label: 'Tripadvisor',
      painFamily: 'directory',
      traits: DIRECTORY_TRAITS,
    };
  }
  if (host === 'maps.google.com') {
    return {
      root: 'maps.google.com',
      label: 'Google Maps',
      painFamily: 'maps',
      traits: SOCIAL_TRAITS,
    };
  }
  for (const p of PRESENCE_PLATFORM_ROOTS) {
    if (hostMatchesRoot(host, p.root)) return p;
  }
  return null;
}

function presencePlatformForLabel(label: string | null | undefined): PlatformRoot | null {
  if (!label?.trim()) return null;
  const norm = normalizePlatformLabel(label);
  if (!norm) return null;
  if (norm === 'annuaire') {
    return {
      root: 'annuaire',
      label: 'Annuaire',
      painFamily: 'directory',
      traits: DIRECTORY_TRAITS,
    };
  }
  return (
    PRESENCE_PLATFORM_ROOTS.find(
      (entry) =>
        normalizePlatformLabel(entry.label) === norm ||
        normalizePlatformLabel(entry.root.replace(/\.[a-z]+$/, '')) === norm,
    ) ?? null
  );
}

function presenceMetaFromClassified(classified: ClassifiedWebsiteUrl): {
  readonly painFamily: PresencePainFamily | null;
  readonly traits: PresencePlatformTraits | null;
} {
  if (classified.urlClass !== 'presence') {
    return { painFamily: null, traits: null };
  }
  if (classified.painFamily !== null) {
    return { painFamily: classified.painFamily, traits: classified.traits };
  }
  const byLabel = presencePlatformForLabel(classified.platformLabel);
  if (byLabel) {
    return { painFamily: byLabel.painFamily, traits: byLabel.traits };
  }
  return { painFamily: null, traits: null };
}

export function parsePresenceSkipPolicy(value: unknown): PresenceSkipPolicy {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (
    raw === 'booking_platforms' ||
    raw === 'all_presence' ||
    raw === 'feudal_booking' ||
    raw === 'off'
  ) {
    return raw;
  }
  return DEFAULT_PRESENCE_SKIP_POLICY;
}

function shouldSkipClassifiedPresence(
  classified: ClassifiedWebsiteUrl,
  policy: PresenceSkipPolicy,
): { readonly skip: boolean; readonly reason: string | null } {
  if (policy === 'off' || classified.urlClass !== 'presence') {
    return { skip: false, reason: null };
  }

  const meta = presenceMetaFromClassified(classified);
  const label = classified.platformLabel ?? 'présence tierce';

  if (policy === 'all_presence') {
    return { skip: true, reason: `Présence tierce · ${label}` };
  }

  if (policy === 'feudal_booking') {
    if (meta.traits?.bookingGate && meta.traits.feudalDependency) {
      return { skip: true, reason: `Plateforme réservation · ${label}` };
    }
    return { skip: false, reason: null };
  }

  if (meta.painFamily !== null && BOOKING_PAIN_FAMILIES.has(meta.painFamily)) {
    return { skip: true, reason: `Plateforme réservation · ${label}` };
  }

  return { skip: false, reason: null };
}

export type PresencePipelineSkipAssessment = {
  readonly skip: boolean;
  readonly reason: string | null;
};

/** Évalue si une URL ou un libellé de présence doit être exclu du pipeline. */
export function assessPresencePipelineSkip(
  input: {
    readonly rawUrl?: string | null;
    readonly platformLabel?: string | null;
  },
  policy: PresenceSkipPolicy = DEFAULT_PRESENCE_SKIP_POLICY,
): PresencePipelineSkipAssessment {
  const rawUrl = input.rawUrl?.trim();
  if (rawUrl) {
    const classified = classifyWebsiteUrl(rawUrl);
    if (classified) return shouldSkipClassifiedPresence(classified, policy);
  }

  const platformLabel = input.platformLabel?.trim();
  if (platformLabel) {
    const entry = presencePlatformForLabel(platformLabel);
    if (entry) {
      return shouldSkipClassifiedPresence(
        {
          urlClass: 'presence',
          displayUrl: rawUrl ?? '',
          normalizedUrl: rawUrl ? (normalizeProspectUrl(rawUrl) ?? '') : '',
          platformLabel: entry.label,
          painFamily: entry.painFamily,
          traits: entry.traits,
        },
        policy,
      );
    }
  }

  return { skip: false, reason: null };
}

/** Hosts de plateformes à ignorer en recherche web (dérivé du registre + politique). */
export function isPipelineSkippedPresenceHost(
  hostname: string,
  policy: PresenceSkipPolicy = DEFAULT_PRESENCE_SKIP_POLICY,
): boolean {
  const host = hostname.trim().toLowerCase().replace(/^www\./, '');
  if (!host) return false;

  const platform = presencePlatformForHost(host);
  if (!platform) return false;

  return shouldSkipClassifiedPresence(
    {
      urlClass: 'presence',
      displayUrl: `https://${host}/`,
      normalizedUrl: host,
      platformLabel: platform.label,
      painFamily: platform.painFamily,
      traits: platform.traits,
    },
    policy,
  ).skip;
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
          painFamily: 'maps',
          traits: SOCIAL_TRAITS,
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
      painFamily: platform.painFamily,
      traits: platform.traits,
    };
  }

  const directory = directoryLabelForHost(host);
  if (directory) {
    return {
      urlClass: 'presence',
      displayUrl,
      normalizedUrl,
      platformLabel: directory,
      painFamily: 'directory',
      traits: DIRECTORY_TRAITS,
    };
  }

  return {
    urlClass: 'owner',
    displayUrl,
    normalizedUrl,
    platformLabel: null,
    painFamily: null,
    traits: null,
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
