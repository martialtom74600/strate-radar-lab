import { z } from 'zod';

/** Kebab-case strict (aligné radarIngestBodySchema côté vitrine). */
export const studioAuditSlugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const strateRadarAuditStrateScoreSchema = z
  .object({
    overall: z.number().optional(),
    byStrate: z.record(z.string(), z.number()).optional(),
  })
  .passthrough();

/** Base strateStudio + enveloppes HV (visuals, business_intelligence, competition, copywriting, technical_metrics…). */
export const strateRadarAuditPayloadSchema = z
  .object({
    strateScore: strateRadarAuditStrateScoreSchema,
    metrics: z.union([z.record(z.unknown()), z.array(z.unknown())]),
    content: z.union([z.record(z.unknown()), z.array(z.unknown()), z.string()]),
  })
  .passthrough();

export const auditIngestBodySchema = z.object({
  slug: z
    .string()
    .min(1, 'slug : min 1 caractère')
    .max(200, 'slug : max 200 caractères')
    .regex(studioAuditSlugRegex, {
      message: 'slug : uniquement a-z, 0-9 et tirets (kebab-case), segments non vides',
    }),
  accessToken: z
    .string()
    .min(32, 'accessToken : min 32 caractères')
    .max(512, 'accessToken : max 512 caractères'),
  payload: strateRadarAuditPayloadSchema,
  payloadVersion: z.string().max(64).optional(),
  expiresAt: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'expiresAt : datetime ISO 8601' })
    .optional(),
  radarJobId: z.string().max(128).optional(),
});

export type AuditIngestPayload = z.infer<typeof auditIngestBodySchema>;
export type StrateRadarAuditPayload = z.infer<typeof strateRadarAuditPayloadSchema>;
