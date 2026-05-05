import { z } from 'zod';

/**
 * Sortie historique `analysis_json` (table `prospect_scans` / cache PageSpeed).
 * Conservé uniquement pour la lecture des lignes SQLite existantes.
 */
export const salesAnalysisSchema = z.object({
  executiveSummary: z.string().min(1),
  pitchAngles: z.array(z.string().min(1)).min(1),
  objectionHandling: z.array(z.string()).default([]),
  recommendedOpening: z.string().min(1),
  priority: z.enum(['high', 'medium', 'low']),
});

export type SalesAnalysis = z.infer<typeof salesAnalysisSchema>;
