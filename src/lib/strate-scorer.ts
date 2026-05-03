import {
  DIAMOND_MIN_RATING_EXCLUSIVE,
  DIAMOND_MIN_REVIEWS_EXCLUSIVE,
  hasTreasuryAndZone,
  type ResolvedWebsite,
} from './diamond.js';
import type { SerpLocalResult } from '../services/serp/schemas.js';
import type { PageSpeedInsightsV5 } from '../services/pagespeed/schemas.js';

/** Seuil Diamant sur la matrice Strate (hors bypass « Diamant brut »). */
export const STRATE_DIAMOND_THRESHOLD = 60;

/** Score fixe bypass : entreprise à flux Maps sans site web. */
export const STRATE_DIAMANT_BRUT_SCORE = 100;

/** Pilier 4 (PageSpeed) uniquement si pilier2 + pilier3 > cette valeur. */
export const STRATE_PILIER4_SUM_TRIGGER_EXCLUSIVE = 40;

export type StratePilierBreakdown = {
  readonly earned: number;
  readonly max: number;
  readonly items: readonly string[];
};

export type StrateScoreResult = {
  readonly total: number;
  readonly pilier1: StratePilierBreakdown;
  readonly pilier2: StratePilierBreakdown;
  readonly pilier3: StratePilierBreakdown;
  readonly pilier4?: StratePilierBreakdown;
  readonly pageSpeedRun: boolean;
  readonly pageSpeedSkippedReason?: string;
};

export type HtmlFetchResult = {
  readonly ok: boolean;
  readonly html: string;
  readonly finalUrl: string;
  readonly error?: string;
};

const USER_AGENT =
  'StrateRadar/1.0 (+https://strate-studio.fr; acquisition locale; contact@strate-studio.fr)';

/** Fetch HTML avec timeout — ne bloque pas indéfiniment la boucle radar. */
export async function fetchHtmlWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<HtmlFetchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    const html = await res.text();
    return {
      ok: res.ok,
      html,
      finalUrl: res.url || url,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      html: '',
      finalUrl: url,
      error: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Bypass « Diamant brut » : trésorerie + zone + aucun site (Maps ni organique). */
export function qualifiesDiamantBrut(
  serp: SerpLocalResult,
  resolved: ResolvedWebsite | null,
  locationHints: readonly string[],
): boolean {
  if (resolved !== null) return false;
  return hasTreasuryAndZone(serp, locationHints);
}

function isPremiumPriceTier(price: string | undefined): boolean {
  if (!price?.trim()) return false;
  const p = price.trim();
  if (/€{3,}/.test(p) || /\${3,}/.test(p)) return true;
  return p.includes('€€€') || p.includes('$$$');
}

function pilierEmpty(max: number): StratePilierBreakdown {
  return { earned: 0, max, items: [] };
}

/** Pilier 1 — potentiel financier (données Serp), max 20. */
export function scorePilier1Potential(serp: SerpLocalResult): StratePilierBreakdown {
  const max = 20;
  const items: string[] = [];
  let earned = 0;

  const reviews = serp.reviews ?? 0;
  const rating = serp.rating ?? 0;

  if (reviews > DIAMOND_MIN_REVIEWS_EXCLUSIVE && rating > DIAMOND_MIN_RATING_EXCLUSIVE) {
    earned += 10;
    items.push(`Trésorerie Maps : avis > ${DIAMOND_MIN_REVIEWS_EXCLUSIVE} et note > ${DIAMOND_MIN_RATING_EXCLUSIVE} (+10)`);
  }

  if (reviews > 150 || isPremiumPriceTier(serp.price)) {
    earned += 10;
    if (reviews > 150) items.push(`Dynamique : avis > 150 (+10)`);
    else if (isPremiumPriceTier(serp.price))
      items.push(`Dynamique : palier prix premium (type €€€/$$$) (+10)`);
  }

  return { earned: Math.min(earned, max), max, items };
}

const VIEWPORT_RE = /<meta[^>]+name=["']viewport["'][^>]*>/i;

function isEffectivelyHttps(urlToCheck: string): boolean {
  try {
    const u = new URL(urlToCheck);
    return u.protocol === 'https:';
  } catch {
    return urlToCheck.trim().toLowerCase().startsWith('https://');
  }
}

/** Pilier 2 — dette technique (HTML + URL), max 30. */
export function scorePilier2Technical(
  html: string | null,
  displayUrl: string,
  finalUrl: string | null,
): StratePilierBreakdown {
  const max = 30;
  const items: string[] = [];
  let earned = 0;

  const urlForScheme = (finalUrl && finalUrl.length > 0 ? finalUrl : displayUrl).trim();
  if (!isEffectivelyHttps(urlForScheme)) {
    earned += 15;
    items.push('Faille : URL en HTTP ou non-HTTPS (+15)');
  }

  if (!html || html.length === 0) {
    if (earned < max) {
      earned += 10;
      items.push('HTML indisponible — viewport non vérifiable (+10, proxy de non-responsive)');
    }
    return { earned: Math.min(earned, max), max, items };
  }

  if (!VIEWPORT_RE.test(html)) {
    earned += 10;
    items.push('Non-responsive probable : absence de meta viewport (+10)');
  }

  const tableCount = (html.match(/<table\b/gi) ?? []).length;
  const wix =
    /\bwix\.com\b/i.test(html) ||
    /\b_wix_browser_sess\b/i.test(html) ||
    /static\.parastorage\.com/i.test(html);
  const scriptTags = html.match(/<script\b[^>]*>/gi) ?? [];
  let heavySyncScripts = 0;
  for (const tag of scriptTags) {
    const lower = tag.toLowerCase();
    if (lower.includes('src=') && !lower.includes('defer') && !lower.includes('async')) {
      heavySyncScripts += 1;
    }
  }
  const legacyPattern =
    tableCount >= 2 ||
    wix ||
    heavySyncScripts >= 8 ||
    (scriptTags.length >= 20 && heavySyncScripts >= 5);

  if (legacyPattern) {
    earned += 5;
    const bits: string[] = [];
    if (tableCount >= 2) bits.push(`layout <table>×${tableCount}`);
    if (wix) bits.push('empreinte constructeur type Wix');
    if (heavySyncScripts >= 8) bits.push(`${heavySyncScripts} scripts src sans defer/async`);
    items.push(`Vétusté / lourdeur : ${bits.join(' · ')} (+5)`);
  }

  return { earned: Math.min(earned, max), max, items };
}

const SERVICE_HINTS =
  /boulanger|restaurant|hôtel|hotel|salon|coiff|cabinet|dent|vétér|veterin|garage|plomb|électric|electric|artisan|notaire|avocat|spa|clinique|agence|traiteur|café|cafe|coiffure|institut|beauté|mécan|pressing|plombier|épicier|boucher|primeur|pharmac|ostéopathe|kiné/i;

export function isLikelyServiceBusiness(serp: SerpLocalResult): boolean {
  const t = `${serp.type ?? ''} ${serp.title}`.toLowerCase();
  return SERVICE_HINTS.test(t);
}

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** +10 si incohérence NAP / identité locale vs HTML. */
export function scoreNapMismatch(html: string | null, serp: SerpLocalResult): StratePilierBreakdown {
  const max = 10;
  if (!html || html.length < 50) {
    return { earned: 0, max, items: [] };
  }

  const hay = normalizeText(html).slice(0, 200_000);
  const titleWords = normalizeText(serp.title)
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 8);

  let nameHits = 0;
  for (const w of titleWords) {
    if (hay.includes(w)) nameHits += 1;
  }
  const nameCoverage =
    titleWords.length > 0 ? nameHits / Math.min(titleWords.length, 4) : 1;

  let addressSignal = false;
  const addr = serp.address?.trim();
  if (addr) {
    const normAddr = normalizeText(addr);
    const cp = /\b(\d{5})\b/.exec(normAddr);
    if (cp?.[1] && hay.includes(cp[1])) addressSignal = true;
    const tokens = normAddr.split(/\s+/).filter((t) => t.length > 3);
    let aHits = 0;
    for (const t of tokens.slice(0, 4)) {
      if (hay.includes(t)) aHits += 1;
    }
    if (tokens.length > 0 && aHits / tokens.length >= 0.5) addressSignal = true;
  }

  const cat = serp.type?.trim();
  let catOk = true;
  if (cat) {
    const ck = normalizeText(cat).split(/\s+/).filter((w) => w.length > 3);
    catOk = ck.length === 0 || ck.some((w) => hay.includes(w));
  }

  const mismatch =
    (titleWords.length >= 2 && nameCoverage < 0.35) ||
    (addr && !addressSignal) ||
    !catOk;

  if (!mismatch) {
    return { earned: 0, max, items: [] };
  }

  return {
    earned: max,
    max,
    items: ['Incohérence NAP / identité : nom, adresse ou catégorie Maps peu absents du site (+10)'],
  };
}

/** +10 friction mobile : métier de service mais pas de tel:/mailto: dans le HTML. */
export function scoreContactFriction(
  html: string | null,
  serp: SerpLocalResult,
): StratePilierBreakdown {
  const max = 10;
  if (!isLikelyServiceBusiness(serp)) {
    return { earned: 0, max, items: [] };
  }
  if (!html || html.length < 30) {
    return { earned: 0, max, items: [] };
  }

  const hasTel = /href\s*=\s*["']tel:/i.test(html);
  const hasMail = /href\s*=\s*["']mailto:/i.test(html);
  if (hasTel || hasMail) {
    return { earned: 0, max, items: [] };
  }

  return {
    earned: max,
    max,
    items: ['Friction mobile : métier de service sans liens cliquables tel: / mailto: (+10)'],
  };
}

export type StrateMatrixContext = {
  readonly serp: SerpLocalResult;
  readonly resolved: ResolvedWebsite;
  readonly fetchResult: HtmlFetchResult;
  readonly analyzeDeadBrochure: (
    htmlExcerpt: string,
    businessName: string,
  ) => Promise<{ readonly deadBrochureSite: boolean; readonly briefReason: string }>;
  readonly loadOrRunPageSpeed: () => Promise<{
    readonly psi: PageSpeedInsightsV5 | null;
    readonly mobilePercent: number | null;
  }>;
};

function excerptForAi(html: string, maxLen = 14_000): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  return stripped.slice(0, maxLen);
}

/**
 * Matrice Strate complète (prospect avec site). Pilier 4 seulement si p2+p3 > 40.
 */
export type StrateMatrixRunOutput = {
  readonly strate: StrateScoreResult;
  readonly pageSpeed: PageSpeedInsightsV5 | null;
  readonly mobilePerfPercent: number | null;
};

export async function runStrateMatrixScore(
  ctx: StrateMatrixContext,
): Promise<StrateMatrixRunOutput> {
  const { serp, resolved, fetchResult } = ctx;
  const html = fetchResult.ok && fetchResult.html.length > 0 ? fetchResult.html : null;
  const finalUrl = fetchResult.finalUrl || null;

  const p1 = scorePilier1Potential(serp);
  const p2 = scorePilier2Technical(html, resolved.displayUrl, finalUrl);

  const nap = scoreNapMismatch(html, serp);
  const friction = scoreContactFriction(html, serp);

  let p3EarnedSub = nap.earned + friction.earned;
  const p3Items = [...nap.items, ...friction.items];

  let groqBrochure = false;
  let groqReason = '';
  if (html && html.length > 80) {
    try {
      const ai = await ctx.analyzeDeadBrochure(excerptForAi(html), serp.title);
      groqBrochure = ai.deadBrochureSite;
      groqReason = ai.briefReason;
    } catch {
      /* Groq échoué : pas de points plaquette */
    }
  }

  if (groqBrochure) {
    p3EarnedSub += 10;
    p3Items.push(
      groqReason
        ? `Plaquette / zéro CTA (Groq) : ${groqReason} (+10)`
        : 'Plaquette morte / intention de conversion floue (Groq) (+10)',
    );
  }

  const p3: StratePilierBreakdown = {
    earned: Math.min(p3EarnedSub, 30),
    max: 30,
    items: p3Items,
  };

  const techConvSum = p2.earned + p3.earned;
  let p4: StratePilierBreakdown | undefined;
  let pageSpeedRun = false;
  let pageSpeedSkippedReason: string | undefined;
  let pageSpeedPsi: PageSpeedInsightsV5 | null = null;
  let pageSpeedMobilePercent: number | null = null;

  if (techConvSum <= STRATE_PILIER4_SUM_TRIGGER_EXCLUSIVE) {
    pageSpeedSkippedReason = `Pilier 2+3 = ${techConvSum} ≤ ${STRATE_PILIER4_SUM_TRIGGER_EXCLUSIVE} — PageSpeed non sollicité`;
  } else {
    pageSpeedRun = true;
    const { psi, mobilePercent } = await ctx.loadOrRunPageSpeed();
    pageSpeedPsi = psi;
    pageSpeedMobilePercent = mobilePercent;
    const items: string[] = [];
    let earned = 0;
    if (mobilePercent === null || Number.isNaN(mobilePercent)) {
      items.push('PageSpeed : score mobile indisponible (0 pt)');
    } else if (mobilePercent < 35) {
      earned = 20;
      items.push(`Performance mobile < 35 (${mobilePercent}) (+20)`);
    } else if (mobilePercent <= 50) {
      earned = 10;
      items.push(`Performance mobile 35–50 (${mobilePercent}) (+10)`);
    }
    p4 = { earned, max: 20, items };
  }

  const total = p1.earned + p2.earned + p3.earned + (p4?.earned ?? 0);

  const strate: StrateScoreResult = {
    total,
    pilier1: p1,
    pilier2: p2,
    pilier3: p3,
    ...(p4 !== undefined ? { pilier4: p4 } : {}),
    pageSpeedRun,
    ...(pageSpeedSkippedReason !== undefined ? { pageSpeedSkippedReason } : {}),
  };

  return {
    strate,
    pageSpeed: pageSpeedPsi,
    mobilePerfPercent: pageSpeedMobilePercent,
  };
}
