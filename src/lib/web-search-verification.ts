import { WEB_SEARCH_BUDGET_EXHAUSTED_REASON } from '../services/serp/web-search-budget.js';
import type { WebsiteResolution, WebsiteResolutionSource } from './website-resolver.js';

function isAuthoritativeMapsOwnerSource(source: WebsiteResolutionSource | null): boolean {
  return source === 'maps_link' || source === 'place_details';
}

function webSearchBudgetExhaustedOnAttempt(resolution: WebsiteResolution): boolean {
  const webAttempt = resolution.attempts.find((a) => a.layer === 'web_search');
  const note = webAttempt?.note ?? '';
  return (
    note.includes(WEB_SEARCH_BUDGET_EXHAUSTED_REASON) ||
    note.includes('Plafond recherche web du run atteint')
  );
}

/**
 * La couche 4 (Brave) est requise pour création / présence sauf si Google Maps
 * ou requery Places a déjà tranché un site owner de façon fiable.
 */
export function assessWebSearchDoubleCheckGate(args: {
  readonly resolution: WebsiteResolution;
  readonly skipBraveSearch: boolean;
  readonly webSearchConfigured: boolean;
}): { readonly allowed: boolean; readonly reason: string } {
  const { resolution, skipBraveSearch, webSearchConfigured } = args;

  if (skipBraveSearch || !webSearchConfigured) {
    return { allowed: true, reason: '' };
  }

  if (!webSearchBudgetExhaustedOnAttempt(resolution)) {
    return { allowed: true, reason: '' };
  }

  if (
    resolution.status === 'owner_site' &&
    (isAuthoritativeMapsOwnerSource(resolution.source) ||
      resolution.source === 'places_requery' ||
      resolution.source === 'web_search')
  ) {
    return { allowed: true, reason: '' };
  }

  return {
    allowed: false,
    reason:
      'Double vérif web (Brave) requise — plafond run atteint · fiche non qualifiée (retry prochain run).',
  };
}
