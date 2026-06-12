import postgres, { type JSONValue } from 'postgres';

import { googleMapsRawToSerp } from '../lib/diamond-snapshot.js';
import { cityHintFromSearchLocation } from '../lib/search-location-hint.js';
import { stablePlaceKey } from '../lib/place-key.js';
import type { GoogleMapsRaw, RadarAuditLeadKind } from '../lib/strate-studio/audit-payload.js';
import type { SerpLocalResult } from '../services/serp/schemas.js';

export type SupabaseScrubCandidate = {
  readonly auditId: string;
  readonly slug: string;
  readonly placeKey: string;
  readonly businessName: string;
  readonly websiteStatus: 'none' | 'presence_only';
  readonly conversionBadge: 'DIAMANT_CREATION' | 'DIAMANT_PRESENCE';
  readonly searchLocation: string | null;
  readonly serp: SerpLocalResult;
};

type AuditScrubRow = {
  readonly id: string;
  readonly slug: string;
  readonly google_place_id: string | null;
  readonly payload: unknown;
  readonly prospect_label: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function pickString(record: Record<string, unknown>, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function parseLeadKind(payload: Record<string, unknown>): RadarAuditLeadKind | null {
  const raw = pickString(payload, 'leadKind', 'lead_kind');
  if (raw === 'DIAMANT_CREATION' || raw === 'DIAMANT_PRESENCE') return raw;
  return null;
}

function parseGoogleMapsRaw(payload: Record<string, unknown>): GoogleMapsRaw | null {
  const raw = asRecord(payload.googleMapsRaw) ?? asRecord(payload.google_maps_raw);
  if (!raw) return null;

  const title = pickString(raw, 'title');
  if (!title) return null;

  const typesRaw = raw.types;
  const types =
    Array.isArray(typesRaw) && typesRaw.every((item) => typeof item === 'string')
      ? (typesRaw as string[])
      : [];

  const gpsRaw = asRecord(raw.gps_coordinates) ?? asRecord(raw.gpsCoordinates);
  const gps =
    gpsRaw &&
    typeof gpsRaw.latitude === 'number' &&
    typeof gpsRaw.longitude === 'number' &&
    !Number.isNaN(gpsRaw.latitude) &&
    !Number.isNaN(gpsRaw.longitude)
      ? { latitude: gpsRaw.latitude, longitude: gpsRaw.longitude }
      : null;

  return {
    title,
    address: pickString(raw, 'address'),
    rating: typeof raw.rating === 'number' && !Number.isNaN(raw.rating) ? raw.rating : null,
    reviews: typeof raw.reviews === 'number' && !Number.isNaN(raw.reviews) ? raw.reviews : null,
    type: pickString(raw, 'type'),
    types,
    price: pickString(raw, 'price'),
    gps_coordinates: gps,
    thumbnail: pickString(raw, 'thumbnail'),
    place_id:
      pickString(raw, 'place_id', 'placeId') ??
      pickString(payload, 'googlePlaceId', 'google_place_id', 'place_id', 'placeId'),
    trendingQuery: pickString(raw, 'trendingQuery', 'trending_query') ?? '—',
    seedCategory: pickString(raw, 'seedCategory', 'seed_category'),
    ...(pickString(raw, 'mapsListingWebsite', 'maps_listing_website')
      ? {
          mapsListingWebsite: pickString(raw, 'mapsListingWebsite', 'maps_listing_website')!,
        }
      : {}),
  };
}

function inferSearchLocation(
  payload: Record<string, unknown>,
  fallback: string,
): string | null {
  const legal = asRecord(payload.legalData) ?? asRecord(payload.legal_data);
  const commune = legal
    ? pickString(legal, 'siegeLibelleCommune', 'siege_libelle_commune')
    : null;
  if (commune) {
    return cityHintFromSearchLocation(`${commune}, France`, fallback);
  }

  const maps = parseGoogleMapsRaw(payload);
  if (maps?.address?.trim()) {
    return cityHintFromSearchLocation(maps.address, fallback);
  }

  return cityHintFromSearchLocation(null, fallback);
}

function leadKindToWebsiteStatus(
  leadKind: RadarAuditLeadKind,
): 'none' | 'presence_only' | null {
  if (leadKind === 'DIAMANT_CREATION') return 'none';
  if (leadKind === 'DIAMANT_PRESENCE') return 'presence_only';
  return null;
}

function rowToCandidate(
  row: AuditScrubRow,
  searchLocationFallback: string,
): SupabaseScrubCandidate | null {
  const payload = asRecord(row.payload);
  if (!payload) return null;

  const leadKind = parseLeadKind(payload);
  if (!leadKind) return null;

  const websiteStatus = leadKindToWebsiteStatus(leadKind);
  if (!websiteStatus) return null;

  const googleMapsRaw = parseGoogleMapsRaw(payload);
  if (!googleMapsRaw) return null;

  const serp = googleMapsRawToSerp(googleMapsRaw);
  const placeKey = row.google_place_id?.trim()
    ? `pid:${row.google_place_id.trim()}`
    : stablePlaceKey(serp);

  const conversionBadge =
    leadKind === 'DIAMANT_CREATION' ? ('DIAMANT_CREATION' as const) : ('DIAMANT_PRESENCE' as const);

  return {
    auditId: row.id,
    slug: row.slug,
    placeKey,
    businessName: googleMapsRaw.title,
    websiteStatus,
    conversionBadge,
    searchLocation: inferSearchLocation(payload, searchLocationFallback),
    serp,
  };
}

export type SupabaseScrubClient = {
  readonly listCandidates: (searchLocationFallback: string) => Promise<SupabaseScrubCandidate[]>;
  readonly countPublishedCreationPresence: () => Promise<number>;
  readonly listRevokedDiamondAudits: () => Promise<readonly SupabaseScrubCandidate[]>;
  readonly restorePublishedAudit: (auditId: string) => Promise<void>;
  readonly patchAuditWebsiteResolution: (
    auditId: string,
    websiteResolution: Record<string, unknown>,
  ) => Promise<void>;
  readonly revokeAudit: (auditId: string) => Promise<void>;
  readonly close: () => Promise<void>;
};

export function createSupabaseScrubClient(databaseUrl: string): SupabaseScrubClient {
  const sql = postgres(databaseUrl.trim(), {
    max: 1,
    prepare: false,
    connect_timeout: 15,
  });

  return {
    async listCandidates(searchLocationFallback: string): Promise<SupabaseScrubCandidate[]> {
      const rows = await sql<AuditScrubRow[]>`
        SELECT id, slug, google_place_id, payload, prospect_label
        FROM audits
        WHERE status = 'published'
          AND (
            payload->>'leadKind' IN ('DIAMANT_CREATION', 'DIAMANT_PRESENCE')
            OR payload->>'lead_kind' IN ('DIAMANT_CREATION', 'DIAMANT_PRESENCE')
          )
        ORDER BY created_at DESC
      `;

      const candidates: SupabaseScrubCandidate[] = [];
      for (const row of rows) {
        const candidate = rowToCandidate(row, searchLocationFallback);
        if (candidate) candidates.push(candidate);
      }
      return candidates;
    },

    async countPublishedCreationPresence(): Promise<number> {
      const rows = await sql<{ cnt: number }[]>`
        SELECT COUNT(*)::int AS cnt
        FROM audits
        WHERE status = 'published'
          AND (
            payload->>'leadKind' IN ('DIAMANT_CREATION', 'DIAMANT_PRESENCE')
            OR payload->>'lead_kind' IN ('DIAMANT_CREATION', 'DIAMANT_PRESENCE')
          )
      `;
      return rows[0]?.cnt ?? 0;
    },

    async listRevokedDiamondAudits(): Promise<readonly SupabaseScrubCandidate[]> {
      const rows = await sql<AuditScrubRow[]>`
        SELECT id, slug, google_place_id, payload, prospect_label
        FROM audits
        WHERE status = 'revoked'
          AND (
            payload->>'leadKind' IN ('DIAMANT_CREATION', 'DIAMANT_PRESENCE')
            OR payload->>'lead_kind' IN ('DIAMANT_CREATION', 'DIAMANT_PRESENCE')
          )
        ORDER BY updated_at DESC
      `;

      const candidates: SupabaseScrubCandidate[] = [];
      for (const row of rows) {
        const candidate = rowToCandidate(row, 'France');
        if (candidate) candidates.push(candidate);
      }
      return candidates;
    },

    async restorePublishedAudit(auditId: string): Promise<void> {
      await sql`
        UPDATE audits
        SET status = 'published', updated_at = NOW()
        WHERE id = ${auditId}::uuid
          AND status = 'revoked'
      `;
    },

    async patchAuditWebsiteResolution(
      auditId: string,
      websiteResolution: Record<string, unknown>,
    ): Promise<void> {
      const patch: JSONValue = { websiteResolution: websiteResolution as JSONValue };
      await sql`
        UPDATE audits
        SET
          payload = COALESCE(payload, '{}'::jsonb) || ${sql.json(patch)}::jsonb,
          updated_at = NOW()
        WHERE id = ${auditId}::uuid
      `;
    },

    async revokeAudit(auditId: string): Promise<void> {
      await sql`
        UPDATE audits
        SET status = 'revoked', updated_at = NOW()
        WHERE id = ${auditId}::uuid
      `;
    },

    async close(): Promise<void> {
      await sql.end({ timeout: 2 });
    },
  };
}
