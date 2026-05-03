import type { PageSpeedInsightsV5 } from '../services/pagespeed/schemas.js';

export type LighthouseScoresPercent = {
  readonly performance: number | null;
  readonly seo: number | null;
  readonly accessibility: number | null;
  readonly bestPractices: number | null;
};

function toPercent(score: number | null | undefined): number | null {
  if (score === null || score === undefined || Number.isNaN(score)) return null;
  return Math.round(score * 100);
}

export function extractLighthouseScoresPercent(
  psi: PageSpeedInsightsV5,
): LighthouseScoresPercent {
  const cat = psi.lighthouseResult?.categories;
  return {
    performance: toPercent(cat?.performance?.score ?? null),
    seo: toPercent(cat?.seo?.score ?? null),
    accessibility: toPercent(cat?.accessibility?.score ?? null),
    bestPractices: toPercent(cat?.['best-practices']?.score ?? null),
  };
}
