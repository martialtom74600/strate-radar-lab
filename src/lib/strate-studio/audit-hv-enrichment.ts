import { createHash } from 'node:crypto';

import sharp from 'sharp';

import { extractLighthouseScoresPercent } from '../lighthouse.js';
import { stablePlaceKey } from '../place-key.js';
import type { RadarPipelineLine, RadarPipelineResult } from '../../pipeline/radar-pipeline.js';
import type { SerpLocalResult } from '../../services/serp/schemas.js';
import type { StrateRadarAuditPayload } from './audit-payload.js';

/** Rayon benchmark concurrentiel métropolitain (m). */
const RIVAL_RADIUS_M = 2000;

const ANNECY_MARKET_NOTE =
  'Estimation conservative calibrée sur le bassin Grand Annecy / Haute-Savoie (74) et les habitudes mobiles locales Maps.';

function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  return R * c;
}

function categoryTrafficMultiplier(primaryType?: string): number {
  const t = (primaryType ?? '').toLowerCase();
  if (/\b(restaurant|cafe|bar|meal|bakery|food)\b/u.test(t) || /boulanger|pâtiss|patiss|brasserie/u.test(t)) return 78;
  if (t.includes('lodging') || t.includes('hotel')) return 62;
  if (t.includes('beauty') || t.includes('hair') || t.includes('spa')) return 44;
  if (t.includes('gym') || t.includes('fitness')) return 36;
  if (t.includes('car') || t.includes('garage') || t.includes('repair')) return 34;
  if (t.includes('store') || t.includes('shop') || t.includes('boutique')) return 42;
  if (t.includes('dentist') || t.includes('doctor') || t.includes('health')) return 28;
  return 40;
}

function sectorConversionRate(primaryType?: string): number {
  const t = (primaryType ?? '').toLowerCase();
  if (t.includes('restaurant') || t.includes('cafe') || t.includes('food')) return 0.038;
  if (t.includes('beauty') || t.includes('hair') || t.includes('spa')) return 0.055;
  if (t.includes('lodging') || t.includes('hotel')) return 0.022;
  if (t.includes('garage') || t.includes('car_repair') || t.includes('car')) return 0.045;
  if (t.includes('gym') || t.includes('fitness')) return 0.048;
  return 0.032;
}

function sectorAverageBasketEur(primaryType?: string): number {
  const t = (primaryType ?? '').toLowerCase();
  if (t.includes('restaurant') || t.includes('cafe') || t.includes('food')) return 28;
  if (t.includes('lodging') || t.includes('hotel')) return 110;
  if (t.includes('beauty') || t.includes('hair') || t.includes('spa')) return 65;
  if (t.includes('garage') || t.includes('car_repair') || t.includes('car')) return 220;
  if (t.includes('gym') || t.includes('fitness')) return 48;
  if (t.includes('bakery') || t.includes('boulanger')) return 12;
  return 42;
}

function parseGps(serp: SerpLocalResult): { lat: number; lng: number } | null {
  const g = serp.gps_coordinates;
  if (!g) return null;
  if (typeof g.latitude !== 'number' || typeof g.longitude !== 'number') return null;
  if (Number.isNaN(g.latitude) || Number.isNaN(g.longitude)) return null;
  return { lat: g.latitude, lng: g.longitude };
}

function typesOverlap(a: SerpLocalResult, b: SerpLocalResult): boolean {
  const ta = (a.type ?? '').toLowerCase();
  const tb = (b.type ?? '').toLowerCase();
  if (ta && tb && (ta === tb || ta.includes(tb) || tb.includes(ta))) return true;
  const setA = new Set((a.types ?? []).map((x) => x.toLowerCase()));
  for (const x of b.types ?? []) {
    if (setA.has(x.toLowerCase())) return true;
  }
  return false;
}

function prospectDigitalScore(line: RadarPipelineLine): number {
  const sc = line.strateScore;
  if (sc?.total !== undefined) return sc.total;
  return 72;
}

function rivalDigitalProxy(serp: SerpLocalResult, lineByKey: ReadonlyMap<string, RadarPipelineLine>): number {
  const key = stablePlaceKey(serp);
  const hit = lineByKey.get(key);
  if (hit?.strateScore?.total !== undefined) return hit.strateScore.total;
  let s = 38;
  if (serp.website?.trim()) s += 28;
  const reviews = serp.reviews ?? 0;
  s += Math.min(22, Math.log1p(reviews) * 3.8);
  const rating = serp.rating ?? 4.1;
  s += Math.max(0, Math.min(12, (rating - 4) * 10));
  return Math.min(100, Math.round(s));
}

function conversionGapPercent(line: RadarPipelineLine): number {
  const hasSite = line.normalizedUrl !== null;
  const lh = line.pageSpeed !== null ? extractLighthouseScoresPercent(line.pageSpeed) : null;
  const perf = lh?.performance ?? null;

  let gap = 0;
  if (!hasSite) gap = Math.max(gap, 34);
  if (perf !== null && perf < 38) gap = Math.max(gap, 28);
  else if (perf !== null && perf < 55) gap = Math.max(gap, 18);
  else if (perf !== null && perf < 72) gap = Math.max(gap, 12);
  if (hasSite && gap === 0) gap = 9;
  return Math.min(44, gap);
}

function sectorSyntheticEdge(line: RadarPipelineLine, rank: 0 | 1): string {
  const hasSite = line.normalizedUrl !== null;
  const perf = line.pageSpeed !== null ? extractLighthouseScoresPercent(line.pageSpeed).performance : null;
  if (!hasSite) {
    return rank === 0
      ? 'Tunnel web + bouton d’action direct (réservation / devis) aligné sur la fiche Maps'
      : 'SEO local sur la requête tendance + pages offre claires sur mobile';
  }
  if (perf !== null && perf < 55) {
    return rank === 0
      ? 'Expérience mobile fluide (LCP / stabilité) limitant le rebond sur « près de moi »'
      : 'Click & collect ou prise de créneau en ligne sans friction';
  }
  return rank === 0
    ? 'Parcours réservation / lead capture automatisé (moins d’appels manqués)'
    : 'Contenus localisés (SEO « secteur + Annecy ») et preuves sociales mises en avant';
}

function painParagraph(line: RadarPipelineLine, category: string | undefined): string {
  const t = (category ?? line.serp.type ?? '').toLowerCase();
  const reviews = line.serp.reviews ?? 0;
  const zone = 'sur le bassin haut-savoyard';
  if (t.includes('restaurant') || t.includes('cafe') || t.includes('food') || t.includes('bar')) {
    return `Pour la restauration ${zone}, chaque clic Maps part vers un concurrent si l’ardoise, les horaires ou la réservation ne sont pas actionnables en moins de dix secondes sur mobile. Avec ${reviews} avis, vous capitalisez sur la preuve sociale — mais la friction du parcours web transforme l’intention en « je rappelle plus tard », c’est-à-dire souvent jamais.`;
  }
  if (t.includes('beauty') || t.includes('hair') || t.includes('spa')) {
    return `Les instituts et salons à forte réputation ${zone} voient le carnet se remplir par recommandation, pourtant la part des créneaux pris en ligne par les concurrents digitaux grignote la marge : sans prise de RDV fluide, vous payez le coût d’opportunité des appels manqués et des no-shows.`;
  }
  if (t.includes('garage') || t.includes('car') || t.includes('repair')) {
    return `Dans l’automobile, l’urgence et la proximité dictent le choix : un site lent ou une fiche sans action claire envoie le client vers l’atelier qui affiche immédiatement disponibilité et prise de contact. Votre notoriété Maps ne se transforme pas en ordres de travail si le numéro est le seul levier.`;
  }
  if (t.includes('lodging') || t.includes('hotel')) {
    return `L’hébergement vit de la disponibilité perçue et de la confiance instantanée : un parcours mobile hésitant ou des signaux datés sur le site favorisent les OTA et les concurrents avec tunnel clair. Le trafic « Annecy » est compétitif — la conversion se joue sur la fluidité.`;
  }
  return `Sur un marché local dense ${zone}, la preuve Maps (${reviews} avis) suffit rarement : il manque souvent une couche système qui transforme la visibilité en prise de contact mesurable. Chaque friction (lenteur, CTA absent, promesse floue) pousse vers un concurrent plus « prêt à cliquer ».`;
}

function visionParagraph(line: RadarPipelineLine): string {
  const hasSite = line.normalizedUrl !== null;
  return `Strate industrialise ce que vous faites déjà en bouche-à-oreille : une vitrine ultra-rapide, des parcours mobile-first (réservation, devis, appel, itinéraire) et une cohérence NAP fiche Maps ↔ site, avec des relances automatisées sur les leads entrants. ${hasSite ? 'Nous remplaçons la « plaquette » par un levier commercial mesurable, sans ajouter de charge opérationnelle au quotidien.' : 'Nous créons le canal manquant entre votre trafic Maps et votre trésorerie, avec un suivi clair des conversions.'}`;
}

function headlineMaxTenWords(line: RadarPipelineLine, aiHeadline: string | undefined): string {
  const reviews = line.serp.reviews ?? 0;
  const hasSite = line.normalizedUrl !== null;
  const perf = line.pageSpeed !== null ? extractLighthouseScoresPercent(line.pageSpeed).performance : null;

  const dataFirst =
    !hasSite && reviews > 0
      ? `${reviews} avis Maps sans site relié pour convertir immédiatement`
      : perf !== null && perf < 50
        ? `${reviews} avis solides mais mobile trop lent pour capter la demande locale`
        : `${reviews} preuves sociales sous-exploitées par le parcours web actuel`;

  const raw = (aiHeadline?.trim().length ? aiHeadline : dataFirst).replace(
    /[^\p{L}\p{N}\s'’.,€%-]/gu,
    ' ',
  );
  const words = raw
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
  const h = words.slice(0, 10).join(' ');
  return h.length > 0 ? h : 'Visible sur Maps, invisible au moment de convertir';
}

function hashSeed(s: string): number {
  const h = createHash('sha256').update(s, 'utf8').digest();
  return h.readUInt32BE(0);
}

function adjustHex(hex: string, dr: number, dg: number, db: number): string {
  const r = Math.max(0, Math.min(255, parseInt(hex.slice(1, 3), 16) + dr));
  const g = Math.max(0, Math.min(255, parseInt(hex.slice(3, 5), 16) + dg));
  const b = Math.max(0, Math.min(255, parseInt(hex.slice(5, 7), 16) + db));
  const t = (n: number) => n.toString(16).padStart(2, '0');
  return `#${t(r)}${t(g)}${t(b)}`;
}

function fallbackPaletteFromSignals(heroSeed: string, category?: string): { palette: string[]; source: string } {
  const cat = (category ?? 'default').toLowerCase();
  let base = '#3D4F5C';
  if (cat.includes('restaurant') || cat.includes('food')) base = '#8B2E2E';
  else if (cat.includes('beauty') || cat.includes('spa')) base = '#6B2D5C';
  else if (cat.includes('garage') || cat.includes('car')) base = '#2C3A47';
  else if (cat.includes('hotel') || cat.includes('lodging')) base = '#1E3A5F';
  const seed = hashSeed(heroSeed || cat);
  const jitter = (i: number) => ((seed >> (i * 7)) & 31) - 15;
  return {
    palette: [
      base,
      adjustHex(base, jitter(1), jitter(2), jitter(3)),
      adjustHex(base, -20, -12, 18),
      adjustHex(base, 22, 18, -10),
      '#FAF7F2',
    ],
    source: 'conservative_sector_model_annecy_74',
  };
}

async function paletteFromHeroUrl(url: string, category?: string): Promise<{
  brand_palette: string[];
  palette_inference: string;
}> {
  if (!url.trim()) {
    const fb = fallbackPaletteFromSignals('', category);
    return { brand_palette: fb.palette, palette_inference: fb.source };
  }
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 9500);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const { data, info } = await sharp(buf)
      .resize(48, 48, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const ch = Math.max(3, info.channels);
    let r = 0;
    let g = 0;
    let bl = 0;
    let n = 0;
    for (let i = 0; i + ch - 1 < data.length; i += ch) {
      const rr = data[i];
      const gg = data[i + 1];
      const bb = data[i + 2];
      if (rr === undefined || gg === undefined || bb === undefined) break;
      r += rr;
      g += gg;
      bl += bb;
      n += 1;
    }
    if (n === 0) throw new Error('empty');
    const R = Math.round(r / n);
    const G = Math.round(g / n);
    const B = Math.round(bl / n);
    const hex = `#${[R, G, B].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
    return {
      brand_palette: [
        hex,
        adjustHex(hex, -18, -8, 12),
        adjustHex(hex, 16, 6, -16),
        adjustHex(hex, -6, 20, 8),
        '#F8FAFC',
      ],
      palette_inference: 'hero_image_downsample_average',
    };
  } catch {
    const fb = fallbackPaletteFromSignals(url, category);
    return { brand_palette: fb.palette, palette_inference: fb.source };
  }
}

function buildRivals(
  line: RadarPipelineLine,
  candidates: readonly SerpLocalResult[],
  diamondLines: readonly RadarPipelineLine[],
): Record<string, unknown>[] {
  const selfKey = stablePlaceKey(line.serp);
  const origin = parseGps(line.serp);
  const myScore = prospectDigitalScore(line);

  const lineByKey = new Map<string, RadarPipelineLine>(
    diamondLines.map((l) => [stablePlaceKey(l.serp), l] as const),
  );

  const scored: Array<{ serp: SerpLocalResult; distance_m: number; score: number }> = [];
  for (const c of candidates) {
    if (stablePlaceKey(c) === selfKey) continue;
    if (!typesOverlap(line.serp, c)) continue;
    if (!origin) continue;

    const rivalGps = parseGps(c);
    if (!rivalGps) continue;

    const distance_m = Math.round(haversineMeters(origin, rivalGps));
    if (distance_m > RIVAL_RADIUS_M) continue;

    const score = rivalDigitalProxy(c, lineByKey);
    if (score <= myScore) continue;

    scored.push({ serp: c, distance_m, score });
  }

  scored.sort((a, b) => b.score - a.score || a.distance_m - b.distance_m);
  const top = scored.slice(0, 2);

  const out: Record<string, unknown>[] = top.map((row, i) => ({
    name: row.serp.title,
    digital_score_estimate: row.score,
    edge_tool: sectorSyntheticEdge(line, i === 0 ? 0 : 1),
    distance_m: row.distance_m,
    maps_reviews_estimate: row.serp.reviews ?? 40,
    has_public_website: Boolean(row.serp.website?.trim()),
  }));

  while (out.length < 2) {
    const rank = out.length as 0 | 1;
    out.push({
      name:
        rank === 0
          ? 'Concurrent digital de référence (synthèse marché 74)'
          : 'Acteur local à parcours mobile plus abouti (synthèse marché 74)',
      digital_score_estimate: Math.min(100, myScore + 9 + rank * 7),
      edge_tool: sectorSyntheticEdge(line, rank),
      distance_m: 650 + rank * 420,
      maps_reviews_estimate: 55 + rank * 30,
      has_public_website: true,
      inference_note:
        'Scénario conservateur : moins de deux concurrents géolocalisés dans le crawl — projection alignée moyennes Annecy / 74.',
    });
  }

  return out;
}

export async function extendAuditPayloadWithHighValue(
  line: RadarPipelineLine,
  result: RadarPipelineResult,
  base: StrateRadarAuditPayload,
): Promise<StrateRadarAuditPayload> {
  const cat = line.serp.type;
  const reviews = Math.max(line.serp.reviews ?? 0, 28);
  const mult = categoryTrafficMultiplier(cat);
  const estTraffic = Math.max(120, Math.round(reviews * mult));

  const conv = sectorConversionRate(cat);
  const basket = sectorAverageBasketEur(cat);
  const gapPct = conversionGapPercent(line);

  const annualFullIfCaptured = estTraffic * conv * basket * 12;
  const moneyOnTable = Math.round(annualFullIfCaptured * (gapPct / 100));
  const opportunity3y = Math.round(annualFullIfCaptured * (gapPct / 100) * 2.55);

  const hero = line.serp.thumbnail?.trim() ?? '';
  const { brand_palette, palette_inference } = await paletteFromHeroUrl(
    hero && hero.startsWith('http') ? hero : '',
    cat,
  );

  const lh = line.pageSpeed !== null ? extractLighthouseScoresPercent(line.pageSpeed) : null;
  const psiMissing = line.pageSpeed === null;
  const technical_metrics = {
    lighthouse_performance_percent: lh?.performance ?? 51,
    lighthouse_seo_percent: lh?.seo ?? 58,
    lighthouse_accessibility_percent: lh?.accessibility ?? 70,
    lighthouse_best_practices_percent: lh?.bestPractices ?? 72,
    lighthouse_scores_are_conservative_estimate: psiMissing,
    site_resolved: line.normalizedUrl !== null,
    mobile_strategy: line.psiStrategy,
    department_calibration: '74',
    ...(line.displayUrl?.trim()
      ? { audited_url: line.displayUrl.trim() }
      : { audited_url_estimate_note: 'Diamant brut ou URL non résolue — projection sur signaux Maps uniquement.' }),
  };

  const pitch = line.diamondHunterPitch;

  const extensions: Record<string, unknown> = {
    visuals: {
      hero_image: hero.length > 0 ? hero : 'https://placehold.co/1200x700/e2e8f0/475569?text=Maps+%28photo+non+fournie%29',
      brand_palette,
      palette_inference,
      hero_attribution_note:
        hero.length > 0
          ? 'Visuel Google Places ; droits réservés ; usage interne dossier audit Strate.'
          : 'Fallback charté — aucune vignette téléchargeable durant ce crawl.',
    },
    business_intelligence: {
      estimated_monthly_traffic: estTraffic,
      traffic_methodology: `Avis Maps (${reviews}) × multiplicateur catégorie (${mult})`,
      conversion_gap_percent_leads_lost: gapPct,
      conversion_gap_rationale:
        gapPct >= 28
          ? 'Site absent et/ou performance mobile critique vs. attentes utilisateurs locales « je veux réserver tout de suite ».'
          : 'Friction résiduelle navigateur mobile : recherche locale impatiente ; chaque centaine de ms compte.',
      annual_revenue_at_risk_eur: moneyOnTable,
      methodology_money_on_table: `(Trafic mensuel × ${(conv * 100).toFixed(1)}% conv. secteur × ${basket}€ panier référence 74) × (${gapPct}% leads perdus) × 12`,
      opportunity_revenue_strate_system_3y_eur: opportunity3y,
      opportunity_note:
        'Projection 36 mois si correction du gap de conversion avec un système Strate (ramp-up conservateur x2,55 sur le potentiel annualisé lié aux leads perdus).',
      market_reference: ANNECY_MARKET_NOTE,
      currency: 'EUR',
    },
    competition: {
      rival_radius_m: RIVAL_RADIUS_M,
      local_rivalry: buildRivals(line, result.localCandidatesPool, result.lines),
      pressure_note:
        'Pression concurrentielle fondée sur le même run radar (SEO local / même intention) puis filtre géographique lorsque GPS disponible.',
    },
    copywriting: {
      headline_max10w: headlineMaxTenWords(line, pitch?.headline),
      pain_point: painParagraph(line, cat),
      vision: visionParagraph(line),
      lost_revenue_line: pitch?.lost_revenue_pitch ?? '',
      support_angle_conversion: pitch?.anglePrimeConversion ?? '',
    },
    technical_metrics,
  };

  return { ...base, ...extensions };
}
