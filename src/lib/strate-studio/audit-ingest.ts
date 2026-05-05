import { createHash, randomBytes } from 'node:crypto';

import type { AppConfig } from '../../config/index.js';
import { extractLighthouseScoresPercent } from '../lighthouse.js';
import { stablePlaceKey } from '../place-key.js';
import type { StrateScoreResult } from '../strate-scorer.js';
import type { RadarPipelineLine, RadarPipelineResult } from '../../pipeline/radar-pipeline.js';
import {
  auditIngestBodySchema,
  googleMapsRawSchema,
  studioAuditSlugRegex,
  type AuditIngestPayload,
  type GoogleMapsRaw,
  type StrateRadarAuditPayload,
} from './audit-payload.js';
import { extendAuditPayloadWithHighValue } from './audit-hv-enrichment.js';

const DEFAULT_PAYLOAD_VERSION = '1.0.0';

export type StudioIngestSuccess = {
  readonly placeKey: string;
  readonly slug: string;
  readonly accessToken: string;
  readonly publicUrl: string;
  readonly auditId?: string;
};

export type StudioIngestFailure = {
  readonly placeKey: string;
  readonly slug: string;
  readonly status: number;
  readonly message: string;
};

/** Token « lien magique » : 48 caractères hex (192 bits), dans [32, 512]. */
export function generateAuditAccessToken(): string {
  return randomBytes(24).toString('hex');
}

function normalizeSlugPart(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Slug unique kebab-case (nom + zone + empreinte lieu) — respecte la longueur et la regex vitrine.
 */
export function buildAuditSlug(line: RadarPipelineLine, cityLabel: string): string {
  const name = normalizeSlugPart(line.serp.title);
  const zonePart = normalizeSlugPart(cityLabel.split(',')[0]?.trim() ?? cityLabel);
  const basisKey = line.serp.place_id?.trim()
    ? line.serp.place_id.trim()
    : `${line.serp.title}|${line.serp.address ?? ''}|${line.normalizedUrl ?? ''}`;
  const short = createHash('sha256').update(basisKey, 'utf8').digest('hex').slice(0, 10);

  let base = [name, zonePart].filter((s) => s.length > 0).join('-');
  if (base.length === 0) base = 'audit';
  let slug = `${base}-${short}`.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');

  if (!studioAuditSlugRegex.test(slug)) {
    slug = `audit-${short}`;
  }
  if (slug.length > 200) {
    slug = slug.slice(0, 200).replace(/-*$/g, '');
    if (!studioAuditSlugRegex.test(slug)) {
      slug = `audit-${short}`;
    }
  }
  return slug;
}

function withSlugRetrySuffix(slug: string, suffix: string): string {
  const extra = normalizeSlugPart(suffix) || randomBytes(4).toString('hex');
  let next = `${slug}-${extra}`.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  if (next.length > 200) {
    next = `${slug.slice(0, Math.max(1, 200 - 1 - extra.length))}-${extra}`.replace(
      /-*$/g,
      '',
    );
    if (!studioAuditSlugRegex.test(next)) {
      next = `audit-${extra}`;
    }
  }
  if (!studioAuditSlugRegex.test(next)) {
    next = `audit-${randomBytes(5).toString('hex')}`;
  }
  return next;
}

function buildFindings(matrix: StrateScoreResult): Array<{
  id: string;
  severity: 'low' | 'medium' | 'high';
  message: string;
}> {
  const out: Array<{ id: string; severity: 'low' | 'medium' | 'high'; message: string }> = [];
  const pillars: Array<{ prefix: string; p: StrateScoreResult['pilier1'] }> = [
    { prefix: 'P1', p: matrix.pilier1 },
    { prefix: 'P2', p: matrix.pilier2 },
    { prefix: 'P3', p: matrix.pilier3 },
  ];
  if (matrix.pilier4 !== undefined) {
    pillars.push({ prefix: 'P4', p: matrix.pilier4 });
  }
  for (const { prefix, p } of pillars) {
    p.items.forEach((msg, i) => {
      out.push({
        id: `${prefix}-${String(i + 1).padStart(2, '0')}`,
        severity: 'medium',
        message: msg,
      });
    });
  }
  if (matrix.pageSpeedSkippedReason !== undefined) {
    out.push({
      id: 'PS-SKIP',
      severity: 'low',
      message: matrix.pageSpeedSkippedReason,
    });
  }
  return out;
}

function metricsFromLine(line: RadarPipelineLine): Record<string, unknown> {
  const psi = line.pageSpeed;
  const lh = psi !== null ? extractLighthouseScoresPercent(psi) : null;
  const audits = psi?.lighthouseResult?.audits;
  const lcpMs =
    audits?.['largest-contentful-paint']?.numericValue !== undefined
      ? Math.round(audits['largest-contentful-paint']!.numericValue!)
      : null;
  const cls = audits?.['cumulative-layout-shift']?.numericValue ?? null;

  return {
    lighthousePerformancePercent: lh?.performance ?? null,
    lighthouseSeoPercent: lh?.seo ?? null,
    lighthouseAccessibilityPercent: lh?.accessibility ?? null,
    lighthouseBestPracticesPercent: lh?.bestPractices ?? null,
    lcpMs,
    cls,
    websiteSource: line.websiteSource ?? null,
    mapsRating: line.serp.rating ?? null,
    mapsReviews: line.serp.reviews ?? null,
    mapsType: line.serp.type ?? null,
    trendingQuery: line.trendingQuery ?? null,
    seedCategory: line.seedCategory ?? null,
    leadKind: line.conversionBadge ?? null,
  };
}

export function buildGoogleMapsRaw(line: RadarPipelineLine): GoogleMapsRaw {
  const serp = line.serp;
  const g = serp.gps_coordinates;
  const gps =
    g &&
    typeof g.latitude === 'number' &&
    typeof g.longitude === 'number' &&
    !Number.isNaN(g.latitude) &&
    !Number.isNaN(g.longitude)
      ? { latitude: g.latitude, longitude: g.longitude }
      : null;

  return googleMapsRawSchema.parse({
    title: serp.title,
    address: serp.address !== undefined && serp.address.trim() !== '' ? serp.address : null,
    rating:
      typeof serp.rating === 'number' && !Number.isNaN(serp.rating) ? serp.rating : null,
    reviews:
      typeof serp.reviews === 'number' && !Number.isNaN(serp.reviews) ? serp.reviews : null,
    type: serp.type !== undefined && serp.type.trim() !== '' ? serp.type : null,
    types: serp.types !== undefined ? [...serp.types] : [],
    price: serp.price !== undefined && serp.price.trim() !== '' ? serp.price : null,
    gps_coordinates: gps,
    thumbnail:
      serp.thumbnail !== undefined && serp.thumbnail.trim() !== '' ? serp.thumbnail : null,
    place_id: serp.place_id !== undefined && serp.place_id.trim() !== '' ? serp.place_id : null,
    trendingQuery: line.trendingQuery.trim(),
    seedCategory:
      line.seedCategory !== undefined && line.seedCategory.trim() !== ''
        ? line.seedCategory
        : null,
  });
}

export function radarLineToStrateAuditPayload(line: RadarPipelineLine): StrateRadarAuditPayload {
  const sc = line.strateScore;
  const googleMapsRaw = buildGoogleMapsRaw(line);
  const leadKind = line.conversionBadge;

  if (leadKind === 'DIAMANT_CREATION') {
    return {
      leadKind,
      googleMapsRaw,
      strateScore: {
        overall: sc?.total ?? 100,
        byStrate: { diamant_creation: 100 },
        mode: 'diamant_creation',
      },
      metrics: metricsFromLine(line),
      content: {
        title: line.serp.title,
        summary: null,
        lost_revenue_pitch: null,
        pitch: null,
        findings: [],
        recommendedNextStep: null,
        maps: {
          address: line.serp.address ?? null,
          rating: line.serp.rating ?? null,
          reviews: line.serp.reviews ?? null,
        },
      },
    };
  }

  if (leadKind === 'DIAMANT_REFONTE' && sc?.matrix !== undefined && sc.matrix !== null) {
    const m = sc.matrix;
    const findings = buildFindings(m);
    return {
      leadKind,
      googleMapsRaw,
      strateScore: {
        overall: m.total,
        mode: 'diamant_refonte',
        byStrate: {
          pilier1_potentiel_financier: m.pilier1.earned,
          pilier2_dette_technique: m.pilier2.earned,
          pilier3_conversion_ux_locale: m.pilier3.earned,
          ...(m.pilier4 !== undefined
            ? { pilier4_performance_lighthouse: m.pilier4.earned }
            : {}),
        },
        pilierMax: {
          pilier1: m.pilier1.max,
          pilier2: m.pilier2.max,
          pilier3: m.pilier3.max,
          ...(m.pilier4 !== undefined ? { pilier4: m.pilier4.max } : {}),
        },
      },
      metrics: metricsFromLine(line),
      content: {
        title: line.serp.title,
        summary: null,
        lost_revenue_pitch: null,
        pitch: null,
        findings,
        recommendedNextStep: null,
        maps: {
          address: line.serp.address ?? null,
          rating: line.serp.rating ?? null,
          reviews: line.serp.reviews ?? null,
          category: line.serp.type ?? null,
        },
      },
    };
  }

  return {
    leadKind: leadKind ?? 'DIAMANT_REFONTE',
    googleMapsRaw,
    strateScore: {
      overall: sc?.total ?? 0,
      byStrate: {},
      mode: 'incomplet',
    },
    metrics: metricsFromLine(line),
    content: {
      title: line.serp.title,
      summary: null,
      lost_revenue_pitch: null,
      pitch: null,
      findings: [],
      recommendedNextStep: null,
      maps: {
        address: line.serp.address ?? null,
        rating: line.serp.rating ?? null,
        reviews: line.serp.reviews ?? null,
      },
    },
  };
}

function ingestUrlFromOrigin(origin: string): string {
  return `${origin.replace(/\/$/, '')}/api/audits/ingest`;
}

function publicAuditUrl(origin: string, slug: string, accessToken: string): string {
  const o = origin.replace(/\/$/, '');
  const q = new URLSearchParams({ token: accessToken });
  return `${o}/audit/${encodeURIComponent(slug)}?${q.toString()}`;
}

export async function postAuditIngest(args: {
  readonly ingestUrl: string;
  readonly secret: string;
  readonly body: AuditIngestPayload;
  /** Log le corps de réponse brut sur erreur (ex. `RADAR_INGEST_DEBUG`). */
  readonly logRawResponseOnError?: boolean;
}): Promise<{ ok: true; id: string; slug: string } | { ok: false; status: number; message: string }> {
  let res: Response;
  try {
    res = await fetch(args.ingestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.secret}`,
      },
      body: JSON.stringify(args.body),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    let extra = '';
    if (e instanceof Error && e.cause instanceof Error) {
      extra = e.cause.message ? ` — ${e.cause.message}` : '';
    }
    return { ok: false, status: 0, message: `fetch ingest : ${msg}${extra}`.trim() };
  }

  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }

  if (res.status === 201) {
    const id =
      json &&
      typeof json === 'object' &&
      json !== null &&
      'id' in json &&
      typeof (json as { id: unknown }).id === 'string'
        ? (json as { id: string }).id
        : '';
    const slug =
      json &&
      typeof json === 'object' &&
      json !== null &&
      'slug' in json &&
      typeof (json as { slug: unknown }).slug === 'string'
        ? (json as { slug: string }).slug
        : args.body.slug;
    return { ok: true, id, slug };
  }

  const errMsg =
    json &&
    typeof json === 'object' &&
    json !== null &&
    'error' in json &&
    typeof (json as { error: unknown }).error === 'string'
      ? (json as { error: string }).error
      : text.slice(0, 500) || res.statusText;

  let detail = '';
  if (json && typeof json === 'object' && json !== null && 'detail' in json) {
    const d = (json as { detail: unknown }).detail;
    detail =
      typeof d === 'string'
        ? d
        : d !== undefined
          ? JSON.stringify(d).slice(0, 800)
          : '';
  }
  const issues =
    json && typeof json === 'object' && json !== null && 'issues' in json
      ? JSON.stringify((json as { issues: unknown }).issues).slice(0, 800)
      : '';

  const message =
    [errMsg, detail && `(detail: ${detail})`, issues && `(issues: ${issues})`]
      .filter(Boolean)
      .join(' ')
      .trim();

  if (args.logRawResponseOnError === true && text.length > 0) {
    const trunc = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
    console.error(`[Strate Studio] Réponse HTTP ${res.status} (corps brut, debug) :\n${trunc}`);
  }

  return { ok: false, status: res.status, message: message || errMsg };
}

/**
 * Envoie chaque diamant qualifié vers POST /api/audits/ingest (secret Bearer).
 * Retourne une map stablePlaceKey → succès (pour le rapport).
 */
export async function publishStudioAuditsIfConfigured(
  config: AppConfig,
  result: RadarPipelineResult,
): Promise<{ readonly successes: ReadonlyMap<string, StudioIngestSuccess>; readonly failures: readonly StudioIngestFailure[] }> {
  const successes = new Map<string, StudioIngestSuccess>();
  const failures: StudioIngestFailure[] = [];

  const secret = config.RADAR_INGEST_SECRET?.trim();
  if (!secret) {
    return { successes, failures };
  }

  if (config.simulation) {
    if (config.RADAR_VERBOSE) {
      console.log(
        '\n[Strate Studio] Ingestion ignorée : STRATE_RADAR_SIMULATION=true (pas de POST réel).',
      );
    }
    return { successes, failures };
  }

  const origin = config.RADAR_STUDIO_ORIGIN.trim().replace(/\/$/, '');
  const ingestUrl = ingestUrlFromOrigin(origin);
  const lines = result.lines.filter(
    (l) => l.conversionBadge === 'DIAMANT_CREATION' || l.conversionBadge === 'DIAMANT_REFONTE',
  );

  const jobId = `radar_${result.weekBucket}_${result.generatedAtIso}`.slice(0, 128);
  const payloadVersion = config.RADAR_AUDIT_PAYLOAD_VERSION?.trim() || DEFAULT_PAYLOAD_VERSION;
  const expiresAt = config.RADAR_AUDIT_EXPIRES_AT?.trim();

  for (const line of lines) {
    const placeKey = stablePlaceKey(line.serp);
    let slug = buildAuditSlug(line, result.reportCityDisplayName);
    const accessToken = generateAuditAccessToken();
    const payload = extendAuditPayloadWithHighValue(
      line,
      result,
      radarLineToStrateAuditPayload(line),
    );

    const baseBody: Omit<AuditIngestPayload, 'slug' | 'accessToken'> = {
      payload,
      payloadVersion,
      radarJobId: jobId,
      ...(expiresAt !== undefined && expiresAt.length > 0 ? { expiresAt } : {}),
    };

    let attempt = 0;
    let done = false;
    while (!done && attempt < 6) {
      attempt += 1;
      const body = auditIngestBodySchema.parse({
        ...baseBody,
        slug,
        accessToken,
      });

      const out = await postAuditIngest({
        ingestUrl,
        secret,
        body,
        logRawResponseOnError: config.RADAR_INGEST_DEBUG,
      });

      if (out.ok) {
        const publicUrl = publicAuditUrl(origin, out.slug || slug, accessToken);
        successes.set(placeKey, {
          placeKey,
          slug: out.slug || slug,
          accessToken,
          publicUrl,
          ...(out.id !== '' ? { auditId: out.id } : {}),
        });
        console.log(`\n✅ Strate Studio — audit publié :\n   ${publicUrl}\n`);
        done = true;
        break;
      }

      if (out.status === 409 && out.message.includes('slug_already')) {
        slug = withSlugRetrySuffix(
          buildAuditSlug(line, result.reportCityDisplayName),
          randomBytes(3).toString('hex'),
        );
        continue;
      }

      failures.push({
        placeKey,
        slug,
        status: out.status,
        message: out.message,
      });
      console.warn(
        `\n⚠ Strate Studio — échec ingest (${out.status}) pour « ${line.serp.title} » : ${out.message}`,
      );
      done = true;
    }
  }

  return { successes, failures };
}
