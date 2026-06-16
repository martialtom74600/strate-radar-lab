import type { AppConfig } from '../../config/index.js';
import { StrateRadarError } from '../../lib/errors.js';
import { createBraveSearchWebClient } from './brave-search.client.js';
import { createSerperWebClient } from './serper.client.js';
import {
  isWebSearchQuotaError,
  type WebSearchClient,
  type WebSearchOptions,
  type WebSearchResult,
} from './web-search.types.js';

export const SERP_QUOTAS_EXHAUSTED_CODE = 'SERP_QUOTAS_EXHAUSTED';

export function isSerpQuotasExhaustedError(err: unknown): err is StrateRadarError {
  return err instanceof StrateRadarError && err.code === SERP_QUOTAS_EXHAUSTED_CODE;
}

/**
 * Diagnostic démarrage — Serper (priorité) + Brave (fallback).
 */
export function describeSerpBoot(
  config: Pick<
    AppConfig,
    | 'SERPER_API_KEY'
    | 'BRAVE_SEARCH_API_KEY'
    | 'RADAR_WEB_SEARCH_ENABLED'
    | 'RADAR_MAX_WEB_SEARCH_REQUESTS_PER_RUN'
  >,
): { readonly configured: boolean; readonly statusLine: string } {
  const max = config.RADAR_MAX_WEB_SEARCH_REQUESTS_PER_RUN;
  if (max <= 0) {
    return {
      configured: false,
      statusLine: 'inactif · RADAR_MAX_WEB_SEARCH_REQUESTS_PER_RUN=0',
    };
  }
  if (!config.RADAR_WEB_SEARCH_ENABLED) {
    return {
      configured: false,
      statusLine: 'inactif · RADAR_WEB_SEARCH_ENABLED=false',
    };
  }

  const serperKey = config.SERPER_API_KEY?.trim();
  const braveKey = config.BRAVE_SEARCH_API_KEY?.trim();
  if (!serperKey && !braveKey) {
    return {
      configured: false,
      statusLine: 'inactif · SERPER_API_KEY et BRAVE_SEARCH_API_KEY absentes',
    };
  }

  const providers: string[] = [];
  if (serperKey) providers.push(`Serper (${serperKey.length} car.)`);
  if (braveKey) providers.push(`Brave fallback (${braveKey.length} car.)`);

  return {
    configured: true,
    statusLine: `actif · ${providers.join(' → ')} · plafond ${max} req/run`,
  };
}

function throwSerpQuotasExhausted(): never {
  throw new StrateRadarError(
    SERP_QUOTAS_EXHAUSTED_CODE,
    'Quotas SERP épuisés (Serper + Brave) — arrêt prospection pour éviter les coûts Places inutiles.',
  );
}

export function createSerpManagerFromClients(
  serperClient: WebSearchClient | null,
  braveClient: WebSearchClient | null,
): WebSearchClient | null {
  if (!serperClient && !braveClient) return null;

  async function runBraveFallback(
    q: string,
    opts: WebSearchOptions | undefined,
    serperQuotaHit: boolean,
  ): Promise<WebSearchResult> {
    if (!braveClient) {
      if (serperQuotaHit) throwSerpQuotasExhausted();
      return { hits: [], error: null };
    }

    const braveResult = await braveClient.searchWeb(q, opts);
    if (braveResult.error && isWebSearchQuotaError(braveResult.error)) {
      throwSerpQuotasExhausted();
    }
    return braveResult;
  }

  return {
    async searchWeb(q, opts): Promise<WebSearchResult> {
      if (!serperClient) {
        return runBraveFallback(q, opts, false);
      }

      const serperResult = await serperClient.searchWeb(q, opts);
      if (!serperResult.error) {
        return serperResult;
      }

      if (!isWebSearchQuotaError(serperResult.error)) {
        return serperResult;
      }

      console.log('[radar] [serp-manager] Quota Serper épuisé, fallback sur Brave');
      return runBraveFallback(q, opts, true);
    },
  };
}

/**
 * SerpManager — Serper.dev en priorité, Brave en fallback, kill switch si les deux quotas sont morts.
 * Implémente `WebSearchClient` pour injection transparente dans website-resolver.
 */
export function createSerpManagerWebClient(config: AppConfig): WebSearchClient | null {
  if (config.RADAR_MAX_WEB_SEARCH_REQUESTS_PER_RUN <= 0 || !config.RADAR_WEB_SEARCH_ENABLED) {
    return null;
  }

  const serperClient = createSerperWebClient(config);
  const braveClient = createBraveSearchWebClient(config);
  return createSerpManagerFromClients(serperClient, braveClient);
}
