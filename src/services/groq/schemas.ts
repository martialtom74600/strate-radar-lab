import { z } from 'zod';

/** Données structurées envoyées au modèle pour une analyse commerciale. */
export const prospectForAnalysisSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  normalizedUrl: z.string().min(1),
  address: z.string().optional(),
  category: z.string().optional(),
  rating: z.number().optional(),
  reviewCount: z.number().int().nonnegative().optional(),
  /** Scores Lighthouse exprimés sur 0–100 (null si absent). */
  scores: z.object({
    performance: z.number().nullable(),
    seo: z.number().nullable(),
    accessibility: z.number().nullable(),
    bestPractices: z.number().nullable(),
  }),
  psiFinalUrl: z.string().optional(),
  psiFetchTime: z.string().optional(),
  psiStrategy: z.enum(['mobile', 'desktop']),
  /** Origine du lien site ↔ fiche Maps (impacte le pitch IA). */
  siteLinkage: z.enum(['maps_profile_linked', 'organic_discovery']),
});

export type ProspectForAnalysis = z.infer<typeof prospectForAnalysisSchema>;

/** Sortie structurée de l’analyse de vente (JSON attendu du LLM). */
export const salesAnalysisSchema = z.object({
  executiveSummary: z.string().min(1),
  pitchAngles: z.array(z.string().min(1)).min(1),
  objectionHandling: z.array(z.string()).default([]),
  recommendedOpening: z.string().min(1),
  priority: z.enum(['high', 'medium', 'low']),
});

export type SalesAnalysis = z.infer<typeof salesAnalysisSchema>;
