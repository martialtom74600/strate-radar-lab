import { z } from 'zod';

export const diamondPainSchema = z.enum([
  'no_website',
  'site_not_linked_to_maps',
  'mobile_performance_critical',
  'diamant_brut',
  'strate_matrix',
]);

/** Analyse « plaquette morte » — pilier 3 conversion. */
export const conversionBrochureSchema = z.object({
  deadBrochureSite: z.boolean(),
  briefReason: z.string().min(1),
});

export type ConversionBrochureAnalysis = z.infer<typeof conversionBrochureSchema>;

export type ConversionBrochureInput = {
  readonly htmlExcerpt: string;
  readonly businessName: string;
  readonly mapsCategory?: string;
};

/** Pitch acquisition + estimation « value-at-risk » (manque à gagner fictif mais plausible). */
export const diamondHunterPitchSchema = z.object({
  headline: z.string().min(1),
  gainTempsEtAutomatisation: z.string().min(1),
  anglePrimeConversion: z.string().min(1),
  /** Formulation chiffrée ou ordre de grandeur du manque à gagner (prospects / mobile / réservations). */
  lost_revenue_pitch: z.string().min(1),
});

export type DiamondHunterPitch = z.infer<typeof diamondHunterPitchSchema>;

export type DiamondPainZ = z.infer<typeof diamondPainSchema>;

export type DiamondHunterInput = {
  readonly name: string;
  readonly address?: string;
  readonly reviews: number;
  readonly rating: number;
  readonly zoneHint?: string;
  /** Requête d’intention locale (Trend Catcher) — ancrage FOMO dans le pitch. */
  readonly trendingQuery?: string;
  readonly diamondPain: DiamondPainZ;
  readonly mapsCategory?: string;
  readonly displayUrl?: string;
  readonly websiteSource?: 'maps_link' | 'organic_deep_search';
  readonly mobilePerformancePercent?: number;
  /** Détail matrice Strate (si diamondPain === strate_matrix). */
  readonly strateScoreJson?: string;
};
