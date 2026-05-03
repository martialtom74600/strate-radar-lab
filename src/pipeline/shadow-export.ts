import fs from 'node:fs/promises';
import path from 'node:path';

import type { DiamondPainType } from '../lib/diamond.js';
import type { RadarPipelineLine } from './radar-pipeline.js';

export type ShadowSiteExportRecord = {
  readonly name: string;
  readonly metier: string | null;
  readonly address: string | null;
  readonly rating: number | null;
  readonly reviews: number | null;
  readonly lost_revenue_pitch: string;
  readonly maps_cover_image_url: string | null;
  readonly diamond_pain: DiamondPainType;
  readonly seed_category: string | null;
  readonly place_id: string | null;
  /** Requête d’intention locale ayant mené à ce prospect (Google Suggest / Serp « q »). */
  readonly trending_query: string;
  readonly strate_score_total: number;
  readonly strate_is_diamant_brut: boolean;
  readonly strate_failures_vulgarized: readonly string[];
};

const DEFAULT_SHADOW_EXPORT_PATH = 'data/shadow-sites-export.json';

function buildStrateVulgarizedFailures(line: RadarPipelineLine): string[] {
  const sc = line.strateScore;
  if (!sc) {
    return ['Analyse Strate non disponible pour cette exportation.'];
  }
  if (sc.isDiamantBrut || sc.matrix === null) {
    return [
      'Pas de site web : le trafic Maps ne trouve aucune passerelle de conversion en ligne.',
    ];
  }
  const m = sc.matrix;
  const items: string[] = [];
  for (const p of [m.pilier1, m.pilier2, m.pilier3] as const) {
    items.push(...p.items);
  }
  if (m.pilier4 !== undefined) {
    items.push(...m.pilier4.items);
  }
  if (m.pageSpeedSkippedReason !== undefined) {
    items.push(m.pageSpeedSkippedReason);
  }
  return items.length > 0
    ? items.slice(0, 16)
    : ['Plusieurs signaux cumulés justifient une refonte ciblée conversion + technique.'];
}

function lineToShadowRecord(line: RadarPipelineLine): ShadowSiteExportRecord | null {
  if (line.conversionBadge !== 'DIAMANT' || !line.diamondPain || !line.diamondHunterPitch) {
    return null;
  }
  const sc = line.strateScore;
  return {
    name: line.serp.title,
    metier: line.serp.type ?? null,
    address: line.serp.address ?? null,
    rating: line.serp.rating ?? null,
    reviews: line.serp.reviews ?? null,
    lost_revenue_pitch: line.diamondHunterPitch.lost_revenue_pitch,
    maps_cover_image_url: line.serp.thumbnail?.trim() || null,
    diamond_pain: line.diamondPain,
    seed_category: line.seedCategory ?? null,
    place_id: line.serp.place_id ?? null,
    trending_query: line.trendingQuery ?? line.seedCategory ?? '—',
    strate_score_total: sc?.total ?? 0,
    strate_is_diamant_brut: sc?.isDiamantBrut ?? false,
    strate_failures_vulgarized: buildStrateVulgarizedFailures(line),
  };
}

export function buildShadowSitesPayload(lines: readonly RadarPipelineLine[]): ShadowSiteExportRecord[] {
  const out: ShadowSiteExportRecord[] = [];
  for (const line of lines) {
    const rec = lineToShadowRecord(line);
    if (rec) out.push(rec);
  }
  return out;
}

export async function writeShadowSitesExportFile(
  exportPath: string,
  payload: {
    readonly generatedAtIso: string;
    readonly cityLabel: string;
    readonly diamonds: readonly ShadowSiteExportRecord[];
    readonly demand_driven_mode?: boolean;
    readonly trending_queries_used?: readonly string[];
  },
): Promise<string> {
  const resolved = path.resolve(process.cwd(), exportPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return resolved;
}

export { DEFAULT_SHADOW_EXPORT_PATH };
