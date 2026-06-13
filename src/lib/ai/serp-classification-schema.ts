import { z } from 'zod';

/** Ordre CoT : reason → confidence → status (aligné prompt LLM). */
export const serpClassificationSchema = z.object({
  reason: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  status: z.enum(['owner_site', 'presence_only', 'corporate_parent', 'none']),
});

export type SerpClassification = z.infer<typeof serpClassificationSchema>;
