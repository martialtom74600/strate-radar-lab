import { z } from 'zod';

/** Réponse brute Groq — sans needs_review (ajouté en post-traitement). */
export const llmSerpClassificationSchema = z.object({
  reason: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  status: z.enum(['owner_site', 'presence_only', 'corporate_parent', 'none']),
});

export type LlmSerpClassification = z.infer<typeof llmSerpClassificationSchema>;

/** Alias legacy — parsing Groq uniquement. */
export const serpClassificationSchema = llmSerpClassificationSchema;
export type SerpClassification = LlmSerpClassification;

/** Schéma complet incluant la quarantaine manuelle. */
export const websitePresenceClassificationSchema = llmSerpClassificationSchema.extend({
  status: z.enum(['owner_site', 'presence_only', 'corporate_parent', 'none', 'needs_review']),
});
