import { StrateRadarError } from '../../lib/errors.js';

import type { SerpClient } from './serp.client.js';

/** Encadre le client recherche locale : chaque appel Places Text Search (local + organique) compte pour le plafond du run. */
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
  };
}
