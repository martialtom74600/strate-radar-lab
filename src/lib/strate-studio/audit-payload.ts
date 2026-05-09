/** Kebab-case strict (aligné radar ingest côté vitrine). */
export const studioAuditSlugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Même modèle que `RadarNearbyCompetitor` (import type pour éviter cycle). */
export type StrateRadarAuditNearbyCompetitor =
  import('../nearby-competitors.js').RadarNearbyCompetitor;

export type GoogleMapsRaw = {
  readonly title: string;
  readonly address: string | null;
  readonly rating: number | null;
  readonly reviews: number | null;
  readonly type: string | null;
  readonly types: readonly string[];
  readonly price: string | null;
  readonly gps_coordinates: { readonly latitude: number; readonly longitude: number } | null;
  readonly thumbnail: string | null;
  readonly place_id: string | null;
  readonly trendingQuery: string;
  readonly seedCategory: string | null;
  /** Extraits d’avis Google Places (jusqu’à 10 textes) — absent sur exports historiques. */
  readonly place_review_texts?: readonly string[] | null;
};

export type RadarAuditLeadKind = 'DIAMANT_CREATION' | 'DIAMANT_REFONTE';

export type CompanyRegistryLegalDataPayload = {
  readonly source: 'recherche_entreprises_api_gouv';
  readonly siren: string;
  readonly siretSiege: string;
  readonly nomRaisonSociale: string;
  readonly codeNaf: string | null;
  readonly codeNafRevision25: string | null;
  readonly codeRegistreMetiers: string | null;
  readonly sectionNafCode: string | null;
  readonly sectionNafLibelleInsee: string | null;
  readonly activiteOfficielleResume: string;
  readonly anneeCreation: number | null;
  readonly matchScore: number;
  readonly siegeCodePostal: string | null;
  readonly siegeLibelleCommune: string | null;
};

export type StrateRadarAuditMetrics = {
  readonly lighthousePerformancePercent: number | null;
  readonly lighthouseSeoPercent: number | null;
  readonly lighthouseAccessibilityPercent: number | null;
  readonly lighthouseBestPracticesPercent: number | null;
  readonly lcpMs: number | null;
  readonly cls: number | null;
  readonly websiteSource: 'maps_link' | 'organic_deep_search' | null;
};

export type StrateRadarAuditFinding = {
  readonly id: string;
  readonly severity: 'low' | 'medium' | 'high';
  readonly message: string;
};

export type StrateRadarAuditContent = {
  readonly findings: readonly StrateRadarAuditFinding[];
};

export type StrateRadarAuditStrateScore = {
  readonly overall: number;
  readonly byStrate: Record<string, number> | null;
  readonly pilierMax?: Record<string, number>;
};

export type StrateRadarAuditPayload = {
  readonly leadKind: RadarAuditLeadKind;
  readonly googleMapsRaw: GoogleMapsRaw;
  readonly legalData: CompanyRegistryLegalDataPayload | null;
  readonly strateScore: StrateRadarAuditStrateScore;
  readonly metrics: StrateRadarAuditMetrics;
  readonly content: StrateRadarAuditContent;
  /** Concurrents à proximité (FOMO) — absent sur les payloads historiques. */
  readonly nearbyCompetitors?: readonly StrateRadarAuditNearbyCompetitor[];
  /** 3 leviers digitaux (Groq) — absent sur payloads historiques. */
  readonly digitalGrowthLevers?: readonly string[];
};

export type AuditIngestPayload = {
  readonly slug: string;
  readonly accessToken: string;
  readonly payload: StrateRadarAuditPayload;
  readonly payloadVersion?: string;
  readonly expiresAt?: string;
  readonly radarJobId?: string;
};

export function assertAuditIngestPayload(body: AuditIngestPayload): void {
  const { slug, accessToken } = body;
  if (slug.length < 1 || slug.length > 200) {
    throw new Error(`Ingest slug : longueur invalide (${slug.length}, attendu 1–200).`);
  }
  if (!studioAuditSlugRegex.test(slug)) {
    throw new Error(
      'Ingest slug : uniquement a-z, 0-9 et tirets (kebab-case), segments non vides.',
    );
  }
  if (accessToken.length < 32 || accessToken.length > 512) {
    throw new Error(`Ingest accessToken : longueur invalide (min 32, max 512).`);
  }
  if (body.payloadVersion !== undefined && body.payloadVersion.length > 64) {
    throw new Error('Ingest payloadVersion : max 64 caractères.');
  }
  if (body.expiresAt !== undefined && Number.isNaN(Date.parse(body.expiresAt))) {
    throw new Error('Ingest expiresAt : datetime ISO 8601 invalide.');
  }
  if (body.radarJobId !== undefined && body.radarJobId.length > 128) {
    throw new Error('Ingest radarJobId : max 128 caractères.');
  }
}
