import type { AppConfig } from '../config/index.js';
import type { SerpClient } from '../services/serp/search-client.types.js';
import type { SerpLocalResult } from '../services/serp/schemas.js';
import type { WebSearchClient } from '../services/serp/web-search.types.js';
import {
  resolveProspectWebsitePresence,
  type WebsiteResolution,
} from './website-resolver.js';

export const DIAMOND_WEBSITE_SEARCH_HL = 'fr';
export const DIAMOND_WEBSITE_SEARCH_GL = 'fr';

/**
 * Cascade diamant unifiée (pipeline journalier + scrub rétroactif) :
 * Maps → Details → Google organique → Brave → classifieur Groq 70B.
 */
export async function evaluateDiamondWebsitePresence(args: {
  readonly config: AppConfig;
  readonly serp: SerpLocalResult;
  readonly serpClient: SerpClient;
  readonly webSearchClient: WebSearchClient | null;
  readonly searchLocation: string | null;
  readonly fetchTimeoutMs: number;
  readonly logPrefix?: string;
}): Promise<{
  readonly resolution: WebsiteResolution;
  readonly ownerSite: Awaited<ReturnType<typeof resolveProspectWebsitePresence>>['ownerSite'];
}> {
  const websiteOut = await resolveProspectWebsitePresence({
    config: args.config,
    serp: args.serp,
    serpClient: args.serpClient,
    webSearchClient: args.webSearchClient,
    searchLocation: args.searchLocation,
    hl: DIAMOND_WEBSITE_SEARCH_HL,
    gl: DIAMOND_WEBSITE_SEARCH_GL,
    logPrefix: args.logPrefix ?? '[radar] ',
    opts: {
      fetchTimeoutMs: args.fetchTimeoutMs,
    },
  });

  return {
    resolution: websiteOut.resolution,
    ownerSite: websiteOut.ownerSite,
  };
}

/** Rejet chasse création/présence : site propriétaire détecté (aligné scrub). */
export function shouldRejectOwnerSiteForCreationHunt(args: {
  readonly resolution: Pick<WebsiteResolution, 'status'>;
  readonly needCreation: boolean;
  readonly needRefonte: boolean;
}): boolean {
  if (args.resolution.status !== 'owner_site') return false;
  if (!args.needCreation) return false;
  if (args.needRefonte) return false;
  return true;
}
