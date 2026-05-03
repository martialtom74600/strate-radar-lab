import type { SerpGoogleOrganicResponse } from './organic-schemas.js';

export const MOCK_SERP_GOOGLE_ORGANIC_RESPONSE: SerpGoogleOrganicResponse = {
  search_metadata: {
    id: 'mock-organic-id',
    status: 'Success',
  },
  search_parameters: {
    engine: 'google',
    q: 'Au Petit Grain Annecy France',
    hl: 'fr',
    gl: 'fr',
  },
  /** Vide en simulation : aucune URL organique fiable → « pas de site » après deep search. */
  organic_results: [],
};
