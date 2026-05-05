import { z } from 'zod';

/** Kebab-case strict (aligné radarIngestBodySchema côté vitrine). */
export const studioAuditSlugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Données Maps / SERP pures + contexte de recherche (sans texte généré par le radar). */
export const googleMapsRawSchema = z.object({
  title: z.string(),
  address: z.string().nullable(),
  rating: z.number().nullable(),
  reviews: z.number().nullable(),
  type: z.string().nullable(),
  types: z.array(z.string()),
  price: z.string().nullable(),
  gps_coordinates: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
    })
    .nullable(),
  thumbnail: z.string().nullable(),
  place_id: z.string().nullable(),
  trendingQuery: z.string(),
  seedCategory: z.string().nullable(),
});

export type GoogleMapsRaw = z.infer<typeof googleMapsRawSchema>;

export const strateRadarAuditStrateScoreSchema = z
  .object({
    overall: z.number().optional(),
    byStrate: z.record(z.string(), z.number()).optional(),
  })
  .passthrough();

/** Payload d’ingest vitrine : Strate + métriques + contenu + `googleMapsRaw`. */
export const strateRadarAuditPayloadSchema = z
  .object({
    strateScore: strateRadarAuditStrateScoreSchema,
    metrics: z.union([z.record(z.unknown()), z.array(z.unknown())]),
    content: z.union([z.record(z.unknown()), z.array(z.unknown()), z.string()]),
    googleMapsRaw: googleMapsRawSchema,
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
