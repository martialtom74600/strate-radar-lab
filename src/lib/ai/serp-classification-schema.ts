import { z } from 'zod';

export const serpClassificationSchema = z.object({
  status: z.enum(['owner_site', 'presence_only', 'none']),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(1000),
});

export type SerpClassification = z.infer<typeof serpClassificationSchema>;
