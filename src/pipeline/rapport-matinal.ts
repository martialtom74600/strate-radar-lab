import path from 'node:path';
import fs from 'node:fs/promises';

import { extractLighthouseScoresPercent } from '../lib/lighthouse.js';

import { STRATE_DIAMOND_THRESHOLD, type StrateScoreResult } from '../lib/strate-scorer.js';

import { stablePlaceKey } from '../lib/place-key.js';
import type { StudioIngestSuccess } from '../lib/strate-studio/audit-ingest.js';
import type { DiamondPainType } from '../lib/diamond.js';
import type { PipelineStrateScore, RadarPipelineResult } from './radar-pipeline.js';

function painLabelFr(p: DiamondPainType): string {
  switch (p) {
    case 'no_website':
      return 'Sans site (ancienne règle)';
    case 'site_not_linked_to_maps':
      return 'Site hors Maps (ancienne règle)';
    case 'mobile_performance_critical':
      return 'Perf mobile critique (ancienne règle)';
    case 'diamant_brut':
      return 'Diamant brut — aucun site web, 100/100 (bypass matrice)';
    case 'strate_matrix':
      return `Diamant Strate — matrice ≥ ${STRATE_DIAMOND_THRESHOLD} pts`;
  }
}

function formatStrateScoreSection(s: PipelineStrateScore | undefined): string[] {
  if (s === undefined) return [];
  if (s.isDiamantBrut || s.matrix === null) {
    return [
      `#### Strate Score`,
      ``,
      `- **Total :** ${s.total}/100 — _Diamant brut : pas d’analyse technique (fetch / Groq conversion / PageSpeed non exécutés)._`,
      ``,
    ];
  }
  const m: StrateScoreResult = s.matrix;
  type StratePilier = StrateScoreResult['pilier1'];
  const row = (title: string, p: StratePilier): string =>
    `- **${title}** (${p.earned}/${p.max}) : ${p.items.length > 0 ? p.items.join(' · ') : '—'}`;

  const out: string[] = [
    `#### Strate Score (${m.total}/100)`,
    ``,
    row('Pilier 1 · Potentiel financier', m.pilier1),
    row('Pilier 2 · Dette technique', m.pilier2),
    row('Pilier 3 · Conversion & UX locale', m.pilier3),
  ];
  if (m.pilier4 !== undefined) {
    out.push(row('Pilier 4 · Performance (PageSpeed)', m.pilier4));
  }
  if (m.pageSpeedSkippedReason !== undefined) {
    out.push(`- _${m.pageSpeedSkippedReason}_`);
  }
  out.push(``);
  return out;
}

/** Rapport « acquisition autonome » : uniquement les pépites + Value-at-Risk IA. */
/** @param studioByPlaceKey clés = `stablePlaceKey(serp)` · liens vitrine après ingest réussi. */
export function renderRapportMatinal(
  result: RadarPipelineResult,
  studioByPlaceKey?: ReadonlyMap<string, StudioIngestSuccess>,
): string {
  const dateLabel = new Date(result.generatedAtIso).toLocaleString('fr-FR', {
    dateStyle: 'full',
    timeStyle: 'short',
  });

  const diamants = result.lines.filter((l) => l.conversionBadge === 'DIAMANT');
  const pepites = diamants.slice(0, 5);

  const header = [
    `# 📡 Strate Radar — acquisition autonome`,
    ``,
    `**Date :** ${dateLabel}`,
    `**Zone :** ${result.search.location ?? '—'}`,
    `**Recherche :** ${result.search.q}`,
    `**Semaine ISO :** \`${result.weekBucket}\``,
    `${result.demandDrivenMode ? `**Mode :** demand-driven (${result.trendQueriesResolved.length} intentions Suggest)` : result.multiCategoryMode ? `**Mode :** liste de grainage (${result.seedCategoriesResolved.length} familles)` : `**Mode :** requête unique`}`,
    ``,
    `---`,
    ``,
  ].join('\n');

  const hero =
    pepites.length === 0
      ? [
          `## 💎 BUTIN DU JOUR : LES 5 PÉPITES`,
          ``,
          `_Aucune pépite qualifiée dans les limites du run (requêtes recherche locale \`${result.serpApiCallsUsed}/${result.serpApiCallsMax}\`, seuils ou filtres)._`,
          ``,
          `---`,
          ``,
        ].join('\n')
      : [
          `## 💎 BUTIN DU JOUR : LES 5 PÉPITES`,
          ``,
          `_Qualification : trésorerie Maps (avis > 50, note > 4.2) + zone ; puis **Strate Score** ≥ ${STRATE_DIAMOND_THRESHOLD}/100 sur site existant, ou **Diamant brut** à 100/100 sans aucun site (Maps + organique). Les runs demand-driven croisent les intentions **Suggest** du moment. Voir détail des piliers sous chaque fiche._`,
          ``,
          ...pepites.flatMap((l) => {
            const pitch = l.diamondHunterPitch;
            const pk = stablePlaceKey(l.serp);
            const vitrine = studioByPlaceKey?.get(pk);
            const vitrineLine =
              vitrine !== undefined
                ? [
                    `- **Audit vitrine (Strate Studio) :** ${vitrine.publicUrl}`,
                    ``,
                  ]
                : [];
            const perfBlock =
              l.pageSpeed !== null
                ? (() => {
                    const s = extractLighthouseScoresPercent(l.pageSpeed);
                    return [
                      `- **Perf mobile (Lighthouse 0–100) :** ${s.performance ?? '—'}`,
                      ``,
                    ];
                  })()
                : [];

            const siteLine =
              l.displayUrl !== null
                ? `- **Site :** ${l.displayUrl}${l.websiteSource === 'organic_deep_search' ? ' _(découvert hors champ Maps)_' : ''}`
                : `- **Site :** _aucun site résolu (Maps + organique)_`;

            const block = [
              `### 💎 ${l.serp.title}`,
              ``,
              `> ### ⚠️ Value-at-Risk ${
                l.diamondPain === 'diamant_brut' ? '(modèle statique — bypass IA)' : '(estimation Groq)'
              }`,
              `> `,
              `> **${pitch?.lost_revenue_pitch ?? '_(pitch indisponible)_'}**`,
              ``,
              `- **Douleur :** ${l.diamondPain !== undefined ? painLabelFr(l.diamondPain) : '—'}`,
              `- **Métier (Maps) :** ${l.serp.type?.trim() || '—'}`,
              `- **Grainage :** ${l.seedCategory ?? '—'}`,
              `- **Note / avis :** ${l.serp.rating ?? '—'} (${l.serp.reviews ?? 0} avis)`,
              `- **Adresse :** ${l.serp.address ?? '—'}`,
              siteLine,
              ``,
              ...vitrineLine,
              ...formatStrateScoreSection(l.strateScore),
              ...(pitch
                ? [
                    `#### Arguments de vente ${
                      l.diamondPain === 'diamant_brut' ? '(modèle statique)' : '(IA)'
                    }`,
                    ``,
                    `- **Accroche :** ${pitch.headline}`,
                    `- **Temps & automatisation :** ${pitch.gainTempsEtAutomatisation}`,
                    `- **Conversion :** ${pitch.anglePrimeConversion}`,
                    ``,
                  ]
                : []),
              ...perfBlock,
            ];
            return block;
          }),
          `---`,
          ``,
        ].join('\n');

  const vitrineCount = studioByPlaceKey?.size ?? 0;
  const synth = [
    `## 📊 Synthèse run`,
    ``,
    `- **Pépites obtenues :** ${result.diamondsFound} / ${result.targetDiamondCount}`,
    `- **Fiches Maps parcourues :** ${result.totalBusinessesScanned}`,
    `- **Requêtes recherche locale (plafond run) :** ${result.serpApiCallsUsed} / ${result.serpApiCallsMax}`,
    ...(result.serpApiStoppedEarly
      ? [
          `- **⚠ Arrêt Google Places :** quota / limite (HTTP 429) — run terminé avec résultats partiels.`,
          ...(result.serpApiStopMessage !== undefined
            ? [`  - _${result.serpApiStopMessage.replace(/\s+/g, ' ').trim()}_`]
            : []),
        ]
      : []),
    `- **Audits vitrine Strate Studio :** ${vitrineCount > 0 ? `${vitrineCount} publication(s) — liens sous chaque pépite` : '_aucun envoi (configurez RADAR_INGEST_SECRET) ou échec API_'}`,
    `- **Export JSON local (Shadow) :** \`data/shadow-sites-export.json\``,
    `- **Écartements Gatekeeper (non-commercial) :** ${result.gatekeeperExclusions.length}`,
    ``,
  ].join('\n');

  const gatekeeperSection =
    result.gatekeeperExclusions.length === 0
      ? ''
      : [
          `## Entités non-commerciales écartées`,
          ``,
          `_Filtrage Gatekeeper (IA + bypass si niveau de prix Maps renseigné)._`,
          ``,
          ...result.gatekeeperExclusions.map((e) => {
            const name = e.name.replace(/\s+/g, ' ').trim();
            const reason = e.reason.replace(/\s+/g, ' ').trim();
            return `- **${name}** — ${reason}`;
          }),
          ``,
        ].join('\n');

  const footer = [
    `---`,
    ``,
    `*Strate Radar — Strate Studio · système d’acquisition autonome.*`,
    ``,
  ].join('\n');

  return [header, hero, synth, gatekeeperSection, footer].filter((s) => s.length > 0).join('\n');
}

export async function writeRapportMatinalFile(
  reportPath: string,
  result: RadarPipelineResult,
  studioByPlaceKey?: ReadonlyMap<string, StudioIngestSuccess>,
): Promise<string> {
  const md = renderRapportMatinal(result, studioByPlaceKey);
  const resolved = path.resolve(process.cwd(), reportPath);
  await fs.writeFile(resolved, md, 'utf8');
  return resolved;
}
