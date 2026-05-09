import { StrateRadarError } from '../../lib/errors.js';

import type { SerpClient } from './search-client.types.js';

/** Encadre le client Places : Text Search (local + organique) et Nearby Search — chaque appel compte pour le plafond du run. */
export function wrapSerpClientWithBudget(
  client: SerpClient,
  budget: { readonly max: number; used: number },
): SerpClient {
  const consume = (): void => {
    if (budget.used >= budget.max) {
      throw new StrateRadarError(
        'SERP_BUDGET',
        `Plafond requêtes du run atteint (${budget.max} — budget configuré, pas la facturation Google).`,
      );
    }
    budget.used += 1;
  };

  return {
    searchGoogleLocal(params) {
      consume();
      return client.searchGoogleLocal(params);
    },
    searchGoogleOrganic(params) {
      consume();
      return client.searchGoogleOrganic(params);
    },
    searchGoogleNearby(params) {
      consume();
      return client.searchGoogleNearby(params);
    },
  };
}
