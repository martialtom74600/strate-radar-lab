import { normalizeProspectUrl, toAbsoluteHttpUrl } from './url.js';

export type WebsitePresenceStatus =
  | 'owner_site'
  | 'presence_only'
  | 'corporate_parent'
  | 'none';

export type PresenceSkipPolicy =
  | 'booking_platforms'
  | 'all_presence'
  | 'feudal_booking'
  | 'off';

export const DEFAULT_PRESENCE_SKIP_POLICY: PresenceSkipPolicy = 'booking_platforms';

export type PresencePipelineSkipAssessment = {
  readonly skip: boolean;
  readonly reason: string | null;
};

export type ResolutionPresenceSkipInput = {
  readonly status: WebsitePresenceStatus;
  readonly url?: string | null;
  readonly displayUrl?: string | null;
  readonly presencePlatform?: string | null;
  readonly mapsListingWebsite?: string | null;
  readonly attempts: readonly {
    readonly outcome: WebsitePresenceStatus | 'skipped' | 'invalid';
    readonly url?: string | null;
    readonly note?: string;
  }[];
};

const BOOKING_SIGNAL =
  /\b(doctolib|planity|maiia|treatwell|the[\s-]*fork|lafourchette|fresha|keldoc|resalib|zenchef|opentable|quandoo|resy|hellocare|qare|ordoclic|practo|doctoralia|zocdoc|mon[\s-]*rdv|mesdocteurs|booking|rdv en ligne|prise de rendez[\s-]*vous)\b/i;

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

function scanTextForBookingSignal(text: string | null | undefined): boolean {
  return Boolean(text?.trim() && BOOKING_SIGNAL.test(text));
}

function resolutionScanText(resolution: ResolutionPresenceSkipInput): string {
  const chunks: string[] = [];
  if (resolution.presencePlatform?.trim()) chunks.push(resolution.presencePlatform);
  if (resolution.url?.trim()) chunks.push(resolution.url);
  if (resolution.displayUrl?.trim()) chunks.push(resolution.displayUrl);
  if (resolution.mapsListingWebsite?.trim()) chunks.push(resolution.mapsListingWebsite);
  for (const attempt of resolution.attempts) {
    if (attempt.note?.trim()) chunks.push(attempt.note);
    if (attempt.url?.trim()) chunks.push(attempt.url);
  }
  return chunks.join(' ');
}

export function isBookingPlatformLabel(label: string | null | undefined): boolean {
  return scanTextForBookingSignal(label);
}

export function assessMandatoryBookingPlatformExclusion(
  resolution: ResolutionPresenceSkipInput,
): PresencePipelineSkipAssessment {
  if (resolution.status === 'owner_site') {
    return { skip: false, reason: null };
  }
  const hay = resolutionScanText(resolution);
  if (scanTextForBookingSignal(hay)) {
    return {
      skip: true,
      reason: 'Plateforme de prise de rendez-vous détectée (classifieur IA).',
    };
  }
  return { skip: false, reason: null };
}

export function assessResolutionPresenceSkip(
  resolution: ResolutionPresenceSkipInput,
  policy: PresenceSkipPolicy = DEFAULT_PRESENCE_SKIP_POLICY,
): PresencePipelineSkipAssessment {
  if (policy === 'off') return { skip: false, reason: null };
  if (resolution.status === 'owner_site') return { skip: false, reason: null };

  if (policy === 'all_presence' && resolution.status === 'presence_only') {
    return {
      skip: true,
      reason: resolution.presencePlatform ?? 'Présence tierce (classifieur IA).',
    };
  }

  if (
    (policy === 'feudal_booking' || policy === 'booking_platforms') &&
    resolution.status === 'presence_only'
  ) {
    const hay = resolutionScanText(resolution);
    if (scanTextForBookingSignal(hay)) {
      return {
        skip: true,
        reason: resolution.presencePlatform ?? 'Plateforme RDV (classifieur IA).',
      };
    }
  }

  return { skip: false, reason: null };
}

export function parseOwnerWebsiteUrl(raw: string): {
  readonly displayUrl: string;
  readonly normalizedUrl: string;
} | null {
  const displayUrl = toAbsoluteHttpUrl(raw.trim());
  if (!displayUrl) return null;
  const normalizedUrl = normalizeProspectUrl(displayUrl);
  if (!normalizedUrl) return null;
  return { displayUrl, normalizedUrl };
}
