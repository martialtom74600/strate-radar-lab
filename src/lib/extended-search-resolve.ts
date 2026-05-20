import {
  EXTENDED_SEARCH_MAX_HITS,
  EXTENDED_SEARCH_OWNER_MIN_CONFIDENCE,
  scoreOwnerMatchConfidence,
} from './owner-match-confidence.js';
import {
  pickOrganicUrlByPlaceId,
  type OrganicSerpHit,
} from './organic-match.js';
import { classifyWebsiteUrl } from './website-presence-taxonomy.js';

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
  readonly summaryNote: string | null;
};

function toPresenceCandidate(
  classified: NonNullable<ReturnType<typeof classifyWebsiteUrl>>,
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
    return { owner: null, presence: null, summaryNote: 'aucun résultat' };
  }

  let presence: ExtendedSearchPresenceCandidate | null = null;
  let bestOwner: ExtendedSearchOwnerCandidate | null = null;
  let bestConfidence = 0;
  let ownerRejected = 0;
  let presenceOnlyCount = 0;

  const placeId = args.placeId?.trim() ?? '';
  if (placeId) {
    const byPlaceUrl = pickOrganicUrlByPlaceId(placeId, top);
    if (byPlaceUrl) {
      const classified = classifyWebsiteUrl(byPlaceUrl);
      if (classified?.urlClass === 'owner') {
        return {
          owner: {
            displayUrl: classified.displayUrl,
            normalizedUrl: classified.normalizedUrl,
            source: args.source,
            confidence: 0.92,
            layer: args.layer,
          },
          presence: null,
          summaryNote: 'place_id Google',
        };
      }
      if (classified?.urlClass === 'presence' && !presence) {
        presence = toPresenceCandidate(classified, args.source, args.layer);
      }
    }
  }

  for (const hit of top) {
    const link = hit.link?.trim();
    if (!link) continue;

    const classified = classifyWebsiteUrl(link);
    if (!classified) continue;

    if (classified.urlClass === 'presence') {
      presenceOnlyCount += 1;
      if (!presence) {
        presence = toPresenceCandidate(classified, args.source, args.layer);
      }
      continue;
    }

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
    } else if (classified.urlClass === 'owner') {
      ownerRejected += 1;
    }
  }

  if (bestOwner) {
    return {
      owner: bestOwner,
      presence,
      summaryNote: `owner conf. ${bestConfidence.toFixed(2)}`,
    };
  }

  if (presenceOnlyCount > 0 || presence !== null) {
    return {
      owner: null,
      presence,
      summaryNote:
        ownerRejected > 0
          ? `top ${top.length} · présence/annuaire · ${ownerRejected} owner rejeté(s) < ${EXTENDED_SEARCH_OWNER_MIN_CONFIDENCE}`
          : `top ${top.length} · présence/annuaire uniquement`,
    };
  }

  return {
    owner: null,
    presence: null,
    summaryNote:
      ownerRejected > 0
        ? `top ${top.length} · ${ownerRejected} owner rejeté(s) < ${EXTENDED_SEARCH_OWNER_MIN_CONFIDENCE}`
        : `top ${top.length} · hors-sujet`,
  };
}
