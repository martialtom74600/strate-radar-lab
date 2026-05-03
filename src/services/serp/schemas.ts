import { z } from 'zod';

/** Une ligne « local » renvoyée par SerpApi (google_local). */
export const serpLocalResultSchema = z.object({
  position: z.number().optional(),
  title: z.string(),
  place_id: z.string().optional(),
  data_id: z.string().optional(),
  data_cid: z.string().optional(),
  reviews_link: z.string().optional(),
  photos_link: z.string().optional(),
  gps_coordinates: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
    })
    .optional(),
  place_id_search: z.string().optional(),
  type: z.string().optional(),
  types: z.array(z.string()).optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  website: z.string().optional(),
  description: z.string().optional(),
  rating: z.number().optional(),
  reviews: z.number().optional(),
  hours: z.string().optional(),
  open_state: z.string().optional(),
  thumbnail: z.string().optional(),
  price: z.string().optional(),
});

export const serpSearchMetadataSchema = z.object({
  id: z.string(),
  status: z.string(),
  json_endpoint: z.string().optional(),
  created_at: z.string().optional(),
  processed_at: z.string().optional(),
  google_local_url: z.string().optional(),
  raw_html_file: z.string().optional(),
  total_time_taken: z.number().optional(),
});

export const serpGoogleLocalResponseSchema = z.object({
  search_metadata: serpSearchMetadataSchema,
  search_parameters: z
    .object({
      engine: z.string(),
      q: z.string(),
      location: z.string().optional(),
      google_domain: z.string().optional(),
      hl: z.string().optional(),
      gl: z.string().optional(),
    })
    .passthrough(),
  local_results: z.array(serpLocalResultSchema).optional(),
  /** Pagination Google Places Text Search (nouveau). */
  next_page_token: z.string().optional(),
  /** Présent en cas d’erreur SerpApi */
  error: z.string().optional(),
})
  .passthrough();

export type SerpLocalResult = z.infer<typeof serpLocalResultSchema>;
export type SerpGoogleLocalResponse = z.infer<typeof serpGoogleLocalResponseSchema>;

export type SerpSearchMetadata = z.infer<typeof serpSearchMetadataSchema>;
