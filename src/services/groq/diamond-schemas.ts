import { z } from 'zod';

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
