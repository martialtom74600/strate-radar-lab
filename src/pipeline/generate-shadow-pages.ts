/**
 * Génère des landing HTML « Shadow Pages » — audit premium, une seule page autonome (CSS + JS inline).
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ShadowSiteExportRecord } from './shadow-export.js';

export type GenerateShadowPagesOptions = {
  readonly exportPath: string;
  readonly outputDir: string;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJsString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
}

function safeSlug(s: string): string {
  const base = s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return base.length > 0 ? base : 'prospect';
}

function fileBaseForDiamond(rec: ShadowSiteExportRecord): string {
  const slug = safeSlug(rec.name);
  const id = rec.place_id ?? rec.name;
  const h = createHash('sha1').update(id).digest('hex').slice(0, 8);
  return `${slug}-${h}`;
}

function coerceDiamonds(raw: unknown): ShadowSiteExportRecord[] {
  if (!raw || typeof raw !== 'object') return [];
  const d = (raw as { diamonds?: unknown }).diamonds;
  if (!Array.isArray(d)) return [];
  const out: ShadowSiteExportRecord[] = [];
  for (const row of d) {
    if (!row || typeof row !== 'object') continue;
    const o = row as Record<string, unknown>;
    if (typeof o.name !== 'string' || typeof o.lost_revenue_pitch !== 'string') continue;
    const pain = o.diamond_pain;
    if (
      pain !== 'diamant_brut' &&
      pain !== 'strate_matrix' &&
      pain !== 'no_website' &&
      pain !== 'site_not_linked_to_maps' &&
      pain !== 'mobile_performance_critical'
    ) {
      continue;
    }
    out.push({
      name: o.name,
      metier: typeof o.metier === 'string' ? o.metier : null,
      address: typeof o.address === 'string' ? o.address : null,
      rating: typeof o.rating === 'number' ? o.rating : null,
      reviews: typeof o.reviews === 'number' ? o.reviews : null,
      lost_revenue_pitch: o.lost_revenue_pitch,
      maps_cover_image_url:
        typeof o.maps_cover_image_url === 'string' ? o.maps_cover_image_url : null,
      diamond_pain: pain,
      seed_category: typeof o.seed_category === 'string' ? o.seed_category : null,
      place_id: typeof o.place_id === 'string' ? o.place_id : null,
      trending_query:
        typeof o.trending_query === 'string'
          ? o.trending_query
          : typeof o.seed_category === 'string'
            ? o.seed_category
            : 'recherches locales à forte intention',
      strate_score_total: typeof o.strate_score_total === 'number' ? o.strate_score_total : 0,
      strate_is_diamant_brut:
        typeof o.strate_is_diamant_brut === 'boolean'
          ? o.strate_is_diamant_brut
          : pain === 'diamant_brut',
      strate_failures_vulgarized: Array.isArray(o.strate_failures_vulgarized)
        ? (o.strate_failures_vulgarized as unknown[]).filter((x): x is string => typeof x === 'string')
        : [],
    });
  }
  return out;
}

/** Estimation pédagogique « clients potentiels » (non juridique) pour le hero. */
function estimateMonthlyLeakClients(rec: ShadowSiteExportRecord): number {
  const r = rec.reviews ?? 40;
  const base = 22 + Math.round(r * 0.22) + (rec.strate_score_total < 50 ? 18 : 8);
  return Math.max(18, Math.min(195, base));
}

function buildCurrentPainBullets(rec: ShadowSiteExportRecord): string[] {
  const raw = rec.strate_failures_vulgarized.filter(Boolean).slice(0, 6);
  const defaults = [
    'Expérience mobile lente ou fragile au-delà de la fiche Maps.',
    'Pas de parcours de réservation / devis clair en moins de trois clics.',
    'Signaux de confiance et sécurité web perfectibles (perception « insécurité » côté utilisateur).',
  ];
  if (rec.strate_is_diamant_brut) {
    return [
      'Aucun site relié à votre trafic Maps : la demande locale ne convertit pas en rendez-vous.',
      'Vous dépendez entièrement des plateformes tierces pour la prise de contact.',
      'Vos concurrents avec site premium absorbent les recherches à forte intention.',
    ];
  }
  if (raw.length >= 3) {
    return raw.slice(0, 4);
  }
  return [...raw, ...defaults].slice(0, 4);
}

function buildPageHtml(
  rec: ShadowSiteExportRecord,
  cityLabel: string,
  auditGeneratedAtIso: string,
): string {
  const cityDisplay = cityLabel.trim() || 'votre zone';
  const score = rec.strate_is_diamant_brut ? 100 : Math.max(0, Math.min(100, rec.strate_score_total));
  const monthlyLeak = estimateMonthlyLeakClients(rec);
  const painLeft = buildCurrentPainBullets(rec);
  const leftLis = painLeft
    .map(
      (t) =>
        `<li><span class="cmp-ico" aria-hidden="true">✕</span><span>${escapeHtml(t)}</span></li>`,
    )
    .join('\n');

  const strateStandardLis = [
    'Temps de chargement cible &lt; 1 s sur mobile (perception instantanée).',
    'Réservation ou devis en 2 clics, depuis la fiche Maps jusqu’à l’action.',
    'Design premium, HTTPS, preuves sociales et parcours orienté conversion.',
  ]
    .map(
      (t) =>
        `<li><span class="cmp-ico cmp-ico--ok" aria-hidden="true">✓</span><span>${t}</span></li>`,
    )
    .join('\n');

  const circumference = 2 * Math.PI * 44;
  const dashOffset = circumference * (1 - score / 100);
  const pitchBlock = escapeHtml(rec.lost_revenue_pitch);

  const endMs = new Date(auditGeneratedAtIso).getTime() + 72 * 3600 * 1000;
  const endIso = new Date(endMs).toISOString();

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Audit stratégique — ${escapeHtml(rec.name)} · Strate Studio</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,600;0,700;0,800;1,600&amp;family=Inter:wght@400;600;700&amp;display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #050505;
      --card-border: #1a1a1a;
      --accent: #6366f1;
      --accent-dim: rgba(99, 102, 241, 0.35);
      --text: #f4f4f5;
      --muted: #a1a1aa;
      --danger: #f87171;
      --danger-bg: rgba(127, 29, 29, 0.22);
      --success: #4ade80;
      --success-bg: rgba(22, 101, 52, 0.2);
      --font: 'Plus Jakarta Sans', 'Inter', system-ui, sans-serif;
    }
    *, *::before, *::after { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: var(--font);
      background: var(--bg);
      color: var(--text);
      -webkit-font-smoothing: antialiased;
      line-height: 1.55;
    }
    .dot-layer {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 0;
      background-color: var(--bg);
      background-image: radial-gradient(circle at center, rgba(99, 102, 241, 0.11) 1px, transparent 1px);
      background-size: 28px 28px;
      mask-image: linear-gradient(to bottom, black 0%, black 70%, transparent 100%);
    }
    .wrap {
      position: relative;
      z-index: 1;
      max-width: 1120px;
      margin: 0 auto;
      padding: 0 1.25rem 8rem;
    }
    .topbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: 1.5rem 0 2rem;
      border-bottom: 1px solid var(--card-border);
    }
    .brand {
      font-size: 0.72rem;
      font-weight: 800;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: var(--accent);
    }
    .hero {
      padding: 3rem 0 2.5rem;
      text-align: center;
    }
    .badge-pulse {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.45rem 1rem;
      border-radius: 999px;
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #c7d2fe;
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.25), rgba(79, 70, 229, 0.12));
      border: 1px solid var(--accent-dim);
      animation: badgeGlow 2.8s ease-in-out infinite;
    }
    .badge-pulse::before {
      content: '';
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #818cf8;
      box-shadow: 0 0 12px var(--accent);
      animation: blink 1.2s ease-in-out infinite;
    }
    @keyframes badgeGlow {
      0%, 100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.35); }
      50% { box-shadow: 0 0 28px 4px rgba(99, 102, 241, 0.15); }
    }
    @keyframes blink {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.55; transform: scale(0.92); }
    }
    .hero-name {
      margin: 1.75rem 0 0.5rem;
      font-size: clamp(2.75rem, 8vw, 4.75rem);
      font-weight: 800;
      line-height: 1.05;
      letter-spacing: -0.03em;
      background: linear-gradient(135deg, #fff 0%, #e4e4e7 35%, #a5b4fc 90%);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .hero-kicker {
      margin: 0 0 1.25rem;
      font-size: 1.05rem;
      font-weight: 600;
      color: var(--muted);
    }
    .hero-title {
      margin: 0 auto;
      max-width: 900px;
      font-size: clamp(1.35rem, 3.8vw, 1.95rem);
      font-weight: 700;
      line-height: 1.3;
      color: #fafafa;
    }
    .hero-title em {
      font-style: normal;
      color: #a5b4fc;
    }
    .card {
      border: 1px solid var(--card-border);
      border-radius: 1.25rem;
      background: rgba(10, 10, 10, 0.85);
      padding: 2rem 1.75rem;
      margin-bottom: 1.5rem;
    }
    .card h2 {
      margin: 0 0 1.25rem;
      font-size: 0.78rem;
      font-weight: 800;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .viz-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
      gap: 2.5rem;
    }
    .gauge-box {
      position: relative;
      width: 200px;
      height: 200px;
    }
    .gauge-box svg {
      transform: rotate(-90deg);
      width: 200px;
      height: 200px;
    }
    .gauge-bg {
      fill: none;
      stroke: #1a1a1a;
      stroke-width: 8;
    }
    .gauge-fill {
      fill: none;
      stroke: url(#gaugeGrad);
      stroke-width: 8;
      stroke-linecap: round;
      stroke-dasharray: ${circumference};
      stroke-dashoffset: ${circumference};
      animation: gaugeDraw 1.4s cubic-bezier(0.45, 0, 0.2, 1) 0.2s forwards;
    }
    @keyframes gaugeDraw {
      to { stroke-dashoffset: ${dashOffset}; }
    }
    .gauge-num {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }
    .gauge-num strong {
      font-size: 2.65rem;
      font-weight: 800;
      font-variant-numeric: tabular-nums;
      line-height: 1;
      background: linear-gradient(180deg, #fff, #a5b4fc);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .gauge-num span {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--muted);
      margin-top: 0.35rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .seal {
      text-align: center;
      padding: 2rem 1.5rem;
    }
    .seal-ring {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      width: 200px;
      height: 200px;
      border-radius: 50%;
      background: conic-gradient(from 220deg, #fbbf24, #f59e0b, #d97706, #fbbf24);
      padding: 4px;
      filter: drop-shadow(0 0 24px rgba(251, 191, 36, 0.35));
    }
    .seal-inner {
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background: radial-gradient(circle at 30% 25%, #292524, #0c0a09 65%);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 1rem;
      border: 1px solid rgba(251, 191, 36, 0.4);
    }
    .seal-inner strong {
      font-size: 0.72rem;
      font-weight: 800;
      letter-spacing: 0.12em;
      color: #fcd34d;
    }
    .seal-inner em {
      font-style: normal;
      font-size: 2rem;
      font-weight: 800;
      color: #fef3c7;
      margin-top: 0.35rem;
    }
    .pitch {
      flex: 1;
      min-width: 240px;
      max-width: 420px;
    }
    .pitch p {
      margin: 0;
      font-size: 1.05rem;
      line-height: 1.65;
      color: #d4d4d8;
    }
    .compare {
      display: grid;
      grid-template-columns: 1fr;
      gap: 1.25rem;
    }
    @media (min-width: 768px) {
      .compare { grid-template-columns: 1fr 1fr; }
    }
    .cmp {
      border-radius: 1.1rem;
      padding: 1.75rem;
      border: 1px solid var(--card-border);
    }
    .cmp--bad {
      background: var(--danger-bg);
      border-color: rgba(248, 113, 113, 0.25);
    }
    .cmp--bad h3 { color: #fecaca; }
    .cmp--good {
      background: var(--success-bg);
      border-color: rgba(74, 222, 128, 0.22);
    }
    .cmp--good h3 { color: #bbf7d0; }
    .cmp h3 {
      margin: 0 0 1rem;
      font-size: 0.95rem;
      font-weight: 800;
    }
    .cmp ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .cmp li {
      display: flex;
      gap: 0.65rem;
      margin-bottom: 0.85rem;
      font-size: 0.92rem;
      color: #e4e4e7;
    }
    .cmp-ico {
      flex-shrink: 0;
      width: 1.35rem;
      height: 1.35rem;
      border-radius: 0.35rem;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.7rem;
      font-weight: 800;
      background: rgba(0,0,0,0.35);
      color: var(--danger);
    }
    .cmp-ico--ok {
      color: var(--success);
      background: rgba(0,0,0,0.25);
    }
    .meta {
      font-size: 0.88rem;
      color: var(--muted);
    }
    .meta strong { color: #e4e4e7; }
    .cta-bar {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 50;
      padding: 1rem 1.25rem 1.25rem;
      background: linear-gradient(to top, rgba(5,5,5,0.97), rgba(5,5,5,0.88));
      border-top: 1px solid var(--card-border);
      backdrop-filter: blur(12px);
    }
    .cta-inner {
      max-width: 1120px;
      margin: 0 auto;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }
    .countdown {
      font-size: 0.82rem;
      color: var(--muted);
    }
    .countdown strong {
      font-variant-numeric: tabular-nums;
      color: #fcd34d;
    }
    .cta-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 1rem 1.75rem;
      font-family: var(--font);
      font-size: 0.95rem;
      font-weight: 800;
      color: #fff;
      text-decoration: none;
      border-radius: 0.65rem;
      border: none;
      cursor: pointer;
      background: linear-gradient(135deg, #4f46e5, #6366f1, #4338ca);
      box-shadow: 0 8px 32px rgba(99, 102, 241, 0.35);
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .cta-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 12px 40px rgba(99, 102, 241, 0.45);
    }
  </style>
</head>
<body>
  <div class="dot-layer" aria-hidden="true"></div>
  <div class="wrap">
    <header class="topbar">
      <div>
        <div class="brand">Strate Studio</div>
        <p style="margin:0.35rem 0 0;font-size:0.88rem;color:var(--muted)">Audit stratégique confidentiel</p>
      </div>
      <p style="margin:0;font-size:0.82rem;color:var(--muted)">${escapeHtml(cityDisplay)}</p>
    </header>

    <section class="hero">
      <div class="badge-pulse">Alerte : opportunité de marché détectée à ${escapeHtml(cityDisplay)}</div>
      <h1 class="hero-name">${escapeHtml(rec.name)}</h1>
      <p class="hero-kicker">Strate Score — lecture instantanée de votre retard conversion vs. la concurrence locale.</p>
      <p class="hero-title">Pourquoi <em>${escapeHtml(rec.name)}</em> perd environ <strong>${monthlyLeak}</strong> clients par mois au profit de concurrents plus fluides sur mobile.</p>
    </section>

    <section class="card">
      <h2>Performance &amp; diagnostic</h2>
      ${
        rec.strate_is_diamant_brut
          ? `<div class="viz-row seal">
        <div>
          <div class="seal-ring"><div class="seal-inner">
            <strong>POTENTIEL INEXPLOITÉ</strong>
            <em>100%</em>
          </div></div>
          <p style="margin:1.25rem 0 0;text-align:center;font-size:0.88rem;color:var(--muted);max-width:280px;margin-left:auto;margin-right:auto">Diamant brut : trafic Maps massif sans site de conversion — priorité stratégique maximale.</p>
        </div>
        <div class="pitch"><p>${pitchBlock}</p></div>
      </div>`
          : `<div class="viz-row">
        <div class="gauge-box" role="img" aria-label="Strate Score ${score} sur 100">
          <svg viewBox="0 0 100 100" aria-hidden="true">
            <defs>
              <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#818cf8" />
                <stop offset="100%" stop-color="#4f46e5" />
              </linearGradient>
            </defs>
            <circle class="gauge-bg" cx="50" cy="50" r="44" />
            <circle class="gauge-fill" cx="50" cy="50" r="44" />
          </svg>
          <div class="gauge-num">
            <strong>${score}</strong>
            <span>Strate Score</span>
          </div>
        </div>
        <div class="pitch"><p>${pitchBlock}</p></div>
      </div>`
      }
    </section>

    <section class="card">
      <h2>Le comparatif létal</h2>
      <div class="compare">
        <div class="cmp cmp--bad">
          <h3>Votre situation actuelle</h3>
          <ul>${leftLis}</ul>
        </div>
        <div class="cmp cmp--good">
          <h3>Le standard Strate Studio</h3>
          <ul>${strateStandardLis}</ul>
        </div>
      </div>
    </section>

    <section class="card meta">
      <p><strong>Métier (Maps)</strong> — ${escapeHtml(rec.metier ?? '—')}</p>
      <p><strong>Adresse</strong> — ${escapeHtml(rec.address ?? '—')}</p>
      <p><strong>Preuve sociale</strong> — ${rec.rating ?? '—'} / 5 · ${rec.reviews ?? 0} avis</p>
      <p style="margin-top:1rem;font-size:0.8rem;opacity:0.85">Document généré automatiquement à partir de signaux publics — chiffrages indicatifs non contractuels.</p>
    </section>
  </div>

  <div class="cta-bar">
    <div class="cta-inner">
      <p class="countdown">Validité de cet audit : <strong id="audit-countdown">—</strong></p>
      <a class="cta-btn" href="#">Réclamer mon avantage concurrentiel</a>
    </div>
  </div>

  <script>
    (function () {
      var end = new Date('${escapeJsString(endIso)}').getTime();
      var el = document.getElementById('audit-countdown');
      function pad(n) { return n < 10 ? '0' + n : String(n); }
      function tick() {
        var now = Date.now();
        var ms = Math.max(0, end - now);
        var h = Math.floor(ms / 3600000);
        var m = Math.floor((ms % 3600000) / 60000);
        var s = Math.floor((ms % 60000) / 1000);
        if (el) el.textContent = h + 'h ' + pad(m) + 'm ' + pad(s) + 's';
      }
      tick();
      setInterval(tick, 1000);
    })();
  </script>
</body>
</html>
`;
}

export async function generateShadowPagesFromExport(
  options: GenerateShadowPagesOptions,
): Promise<readonly string[]> {
  const resolvedExport = path.resolve(process.cwd(), options.exportPath);
  const outDir = path.resolve(process.cwd(), options.outputDir);
  const rawText = await fs.readFile(resolvedExport, 'utf8');
  const parsed = JSON.parse(rawText) as unknown;
  const cityLabel =
    typeof (parsed as { cityLabel?: string })?.cityLabel === 'string'
      ? (parsed as { cityLabel: string }).cityLabel
      : 'Votre zone';
  const generatedAtIso =
    typeof (parsed as { generatedAtIso?: string })?.generatedAtIso === 'string'
      ? (parsed as { generatedAtIso: string }).generatedAtIso
      : new Date().toISOString();

  const diamonds = coerceDiamonds(parsed);
  const written: string[] = [];
  await fs.mkdir(outDir, { recursive: true });

  for (const rec of diamonds) {
    const base = fileBaseForDiamond(rec);
    const html = buildPageHtml(rec, cityLabel, generatedAtIso);
    const target = path.join(outDir, `${base}.html`);
    await fs.writeFile(target, html, 'utf8');
    written.push(target);
  }

  return written;
}

function isRunAsMain(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(arg)).href;
  } catch {
    return false;
  }
}

async function runCli(): Promise<void> {
  const { loadConfig } = await import('../config/index.js');
  const config = loadConfig();
  const files = await generateShadowPagesFromExport({
    exportPath: config.RADAR_SHADOW_EXPORT_PATH,
    outputDir: config.RADAR_SHADOW_PAGES_DIR,
  });
  console.log(`Shadow Pages : ${files.length} fichier(s) → ${path.resolve(process.cwd(), config.RADAR_SHADOW_PAGES_DIR)}`);
}

if (isRunAsMain()) {
  runCli().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
