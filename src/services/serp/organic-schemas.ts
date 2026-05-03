import { z } from 'zod';

export const serpOrganicResultSchema = z.object({
  position: z.number().optional(),
  title: z.string(),
  link: z.string(),
  snippet: z.string().optional(),
});

export const serpGoogleOrganicResponseSchema = z
  .object({
    search_metadata: z.object({
      id: z.string(),
      status: z.string(),
    }),
    search_parameters: z.object({ engine: z.string(), q: z.string() }).passthrough(),
    organic_results: z.array(serpOrganicResultSchema).optional(),
    error: z.string().optional(),
  })
  .passthrough();

export type SerpOrganicResult = z.infer<typeof serpOrganicResultSchema>;
export type SerpGoogleOrganicResponse = z.infer<typeof serpGoogleOrganicResponseSchema>;
