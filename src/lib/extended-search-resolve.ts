import {
  EXTENDED_SEARCH_MAX_HITS,
  EXTENDED_SEARCH_OWNER_MIN_CONFIDENCE,
  hostnameSharesBusinessTokens,
  scoreOwnerMatchConfidence,
} from './owner-match-confidence.js';
import {
  pickOrganicUrlByPlaceId,
  type OrganicSerpHit,
} from './organic-match.js';
import {
  classifySearchResultHit,
  isBookingPresenceClassified,
  OWNER_OVERRIDE_BOOKING_MIN_CONFIDENCE,
  pickBestPresenceCandidate,
} from './website-presence-taxonomy.js';

export type ExtendedSearchLayerSource = 'places_requery' | 'web_search';

export type ExtendedSearchOwnerCandidate = {
  readonly displayUrl: string;
  readonly normalizedUrl: string;
  readonly source: ExtendedSearchLayerSource;
  readonly confidence: number;
  readonly layer: string;
};

export type ExtendedSearchPresenceCandidate = {
  readonly displayUrl: string;
  readonly normalizedUrl: string;
  readonly platformLabel: string | null;
  readonly source: ExtendedSearchLayerSource;
  readonly layer: string;
};

export type ExtendedSearchResolveResult = {
  readonly owner: ExtendedSearchOwnerCandidate | null;
  readonly presence: ExtendedSearchPresenceCandidate | null;
  /** Toutes les plateformes RDV détectées (URL ou titre/snippet) dans le top SERP. */
  readonly bookingPresenceHits: readonly ExtendedSearchPresenceCandidate[];
  readonly summaryNote: string | null;
};

function toPresenceCandidate(
  classified: NonNullable<ReturnType<typeof classifySearchResultHit>>,
  source: ExtendedSearchLayerSource,
  layer: string,
): ExtendedSearchPresenceCandidate {
  return {
    displayUrl: classified.displayUrl,
    normalizedUrl: classified.normalizedUrl,
    platformLabel: classified.platformLabel,
    source,
    layer,
  };
}

function pushUniqueBookingHit(
  bucket: ExtendedSearchPresenceCandidate[],
  seen: Set<string>,
  candidate: ExtendedSearchPresenceCandidate,
): void {
  if (seen.has(candidate.normalizedUrl)) return;
  seen.add(candidate.normalizedUrl);
  bucket.push(candidate);
}

/**
 * Parcourt les N premiers hits organiques / Brave.
 * Owner retenu seulement si confiance > 0.85 (nom + ville).
 * Annuaires / présence tierce → candidat présence, jamais refonte.
 */
export async function resolveStrictFromExtendedHits(args: {
  readonly hits: readonly OrganicSerpHit[];
  readonly businessName: string;
  readonly cityHint: string | null;
  readonly placeId: string | null;
  readonly source: ExtendedSearchLayerSource;
  readonly layer: string;
  readonly fetchTimeoutMs: number;
}): Promise<ExtendedSearchResolveResult> {
  const top = args.hits.slice(0, EXTENDED_SEARCH_MAX_HITS);
  if (top.length === 0) {
    return { owner: null, presence: null, bookingPresenceHits: [], summaryNote: 'aucun résultat' };
  }

  const presenceCandidates: ExtendedSearchPresenceCandidate[] = [];
  const bookingPresenceHits: ExtendedSearchPresenceCandidate[] = [];
  const bookingSeen = new Set<string>();
  let bestOwner: ExtendedSearchOwnerCandidate | null = null;
  let bestConfidence = 0;
  let ownerRejected = 0;
  let presenceOnlyCount = 0;
  let bookingInTop = false;

  for (const hit of top) {
    const link = hit.link?.trim();
    if (!link) continue;

    const classified = classifySearchResultHit({
      link,
      ...(hit.title !== undefined ? { title: hit.title } : {}),
      ...(hit.snippet !== undefined ? { snippet: hit.snippet } : {}),
    });
    if (!classified) continue;

    if (isBookingPresenceClassified(classified)) {
      bookingInTop = true;
      const bookingCandidate = toPresenceCandidate(classified, args.source, args.layer);
      pushUniqueBookingHit(bookingPresenceHits, bookingSeen, bookingCandidate);
    }

    if (classified.urlClass === 'presence') {
      presenceOnlyCount += 1;
      presenceCandidates.push(toPresenceCandidate(classified, args.source, args.layer));
    }
  }

  const placeId = args.placeId?.trim() ?? '';
  if (placeId) {
    const byPlaceUrl = pickOrganicUrlByPlaceId(placeId, top);
    if (byPlaceUrl) {
      const hit = top.find((row) => row.link?.trim() === byPlaceUrl);
      const classified = classifySearchResultHit({
        link: byPlaceUrl,
        ...(hit?.title !== undefined ? { title: hit.title } : {}),
        ...(hit?.snippet !== undefined ? { snippet: hit.snippet } : {}),
      });
      if (classified?.urlClass === 'owner') {
        return {
          owner: {
            displayUrl: classified.displayUrl,
            normalizedUrl: classified.normalizedUrl,
            source: args.source,
            confidence: 0.92,
            layer: args.layer,
          },
          presence: pickBestPresenceCandidate(presenceCandidates),
          bookingPresenceHits,
          summaryNote: 'place_id Google',
        };
      }
    }
  }

  for (const hit of top) {
    const link = hit.link?.trim();
    if (!link) continue;

    const classified = classifySearchResultHit({
      link,
      ...(hit.title !== undefined ? { title: hit.title } : {}),
      ...(hit.snippet !== undefined ? { snippet: hit.snippet } : {}),
    });
    if (!classified || classified.urlClass !== 'owner') continue;

    const confidence = await scoreOwnerMatchConfidence({
      url: link,
      businessName: args.businessName,
      cityHint: args.cityHint,
      fetchTimeoutMs: args.fetchTimeoutMs,
      ...(hit.title !== undefined ? { title: hit.title } : {}),
      ...(hit.snippet !== undefined ? { snippet: hit.snippet } : {}),
    });

    if (confidence > EXTENDED_SEARCH_OWNER_MIN_CONFIDENCE && confidence > bestConfidence) {
      bestOwner = {
        displayUrl: classified.displayUrl,
        normalizedUrl: classified.normalizedUrl,
        source: args.source,
        confidence,
        layer: args.layer,
      };
      bestConfidence = confidence;
    } else {
      ownerRejected += 1;
    }
  }

  if (bestOwner && bookingInTop) {
    const hostSharesName = hostnameSharesBusinessTokens(bestOwner.displayUrl, args.businessName);
    if (!hostSharesName && bestConfidence < OWNER_OVERRIDE_BOOKING_MIN_CONFIDENCE) {
      ownerRejected += 1;
      bestOwner = null;
      bestConfidence = 0;
    }
  }

  const presence = pickBestPresenceCandidate(presenceCandidates);

  if (bestOwner) {
    return {
      owner: bestOwner,
      presence,
      bookingPresenceHits,
      summaryNote: `owner conf. ${bestConfidence.toFixed(2)}`,
    };
  }

  if (presenceOnlyCount > 0 || presence !== null) {
    return {
      owner: null,
      presence,
      bookingPresenceHits,
      summaryNote:
        ownerRejected > 0
          ? `top ${top.length} · présence/annuaire · ${ownerRejected} owner rejeté(s) < ${EXTENDED_SEARCH_OWNER_MIN_CONFIDENCE}`
          : `top ${top.length} · présence/annuaire uniquement`,
    };
  }

  return {
    owner: null,
    presence: null,
    bookingPresenceHits,
    summaryNote:
      ownerRejected > 0
        ? `top ${top.length} · ${ownerRejected} owner rejeté(s) < ${EXTENDED_SEARCH_OWNER_MIN_CONFIDENCE}`
        : `top ${top.length} · hors-sujet`,
  };
}
