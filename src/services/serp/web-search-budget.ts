import type {
  GoogleCustomSearchWebClient,
  GoogleCustomSearchWebResult,
} from './google-custom-search.client.js';

export const WEB_SEARCH_BUDGET_EXHAUSTED_REASON = 'WEB_SEARCH_BUDGET_EXHAUSTED';

/** Encadre le client Custom Search : chaque appel consomme le plafond du run. */
export function wrapGoogleCustomSearchWebClientWithBudget(
  client: GoogleCustomSearchWebClient,
  budget: { readonly max: number; used: number },
): GoogleCustomSearchWebClient {
  return {
    searchGoogleWeb(q, opts) {
      if (budget.used >= budget.max) {
        return Promise.resolve({
          hits: [],
          error: {
            httpStatus: 0,
            reason: WEB_SEARCH_BUDGET_EXHAUSTED_REASON,
            message: `Plafond Custom Search du run atteint (${budget.max}/${budget.max} — quota journalier Google ~100 req/jour).`,
          },
        } satisfies GoogleCustomSearchWebResult);
      }
      budget.used += 1;
      return client.searchGoogleWeb(q, opts);
    },
  };
}
