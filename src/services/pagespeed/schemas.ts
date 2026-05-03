import { z } from 'zod';

/** Catégorie Lighthouse (score typiquement entre 0 et 1, ou null si N/A). */
export const lighthouseCategorySchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  score: z.number().nullable().optional(),
});

export const lighthouseAuditRefSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    score: z.number().nullable().optional(),
    scoreDisplayMode: z.string().optional(),
    numericValue: z.number().optional(),
    displayValue: z.string().optional(),
  })
  .passthrough();

export const lighthouseResultSchema = z
  .object({
    requestedUrl: z.string().optional(),
    finalUrl: z.string().optional(),
    fetchTime: z.string().optional(),
    lighthouseVersion: z.string().optional(),
    userAgent: z.string().optional(),
    categories: z.record(lighthouseCategorySchema).optional(),
    audits: z.record(lighthouseAuditRefSchema).optional(),
  })
  .passthrough();

/** Réponse PageSpeed Insights v5 (sous-ensemble strict + champs additionnels tolérés). */
export const pageSpeedInsightsV5Schema = z
  .object({
    captchaResult: z.unknown().optional(),
    kind: z.string().optional(),
    id: z.string().optional(),
    loadingExperience: z.unknown().optional(),
    lighthouseResult: lighthouseResultSchema.optional(),
    analysisUTCTiming: z.unknown().optional(),
    version: z
      .object({
        major: z.number().optional(),
        minor: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type LighthouseCategory = z.infer<typeof lighthouseCategorySchema>;
export type LighthouseResult = z.infer<typeof lighthouseResultSchema>;
export type PageSpeedInsightsV5 = z.infer<typeof pageSpeedInsightsV5Schema>;
