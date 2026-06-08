import type { WebSearchClient, WebSearchResult } from './web-search.types.js';

export const WEB_SEARCH_BUDGET_EXHAUSTED_REASON = 'WEB_SEARCH_BUDGET_EXHAUSTED';

/** Encadre le client recherche web : chaque appel consomme le plafond du run. */
export function wrapWebSearchClientWithBudget(
  client: WebSearchClient,
  budget: { readonly max: number; used: number },
): WebSearchClient {
  return {
    searchWeb(q, opts) {
      if (budget.used >= budget.max) {
        return Promise.resolve({
          hits: [],
          filteredPresenceHits: [],
          error: {
            httpStatus: 0,
            reason: WEB_SEARCH_BUDGET_EXHAUSTED_REASON,
            message: `Plafond recherche web du run atteint (${budget.max}/${budget.max}).`,
          },
        } satisfies WebSearchResult);
      }
      budget.used += 1;
      return client.searchWeb(q, opts);
    },
  };
}
