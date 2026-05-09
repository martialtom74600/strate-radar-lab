import path from 'node:path';
import fs from 'node:fs/promises';

import { extractLighthouseScoresPercent } from '../lib/lighthouse.js';

import { STRATE_DIAMOND_THRESHOLD, type StrateScoreResult } from '../lib/strate-scorer.js';

import { stablePlaceKey } from '../lib/place-key.js';
import type { StudioIngestSuccess } from '../lib/strate-studio/audit-ingest.js';
import type { DiamondPainType } from '../lib/diamond.js';
import type { RadarNearbyCompetitor } from '../lib/nearby-competitors.js';
import type { PipelineStrateScore, RadarPipelineResult } from './radar-pipeline.js';

function painLabelFr(p: DiamondPainType): string {
  switch (p) {
    case 'no_website':
      return 'Sans site (ancienne règle)';
    case 'site_not_linked_to_maps':
      return 'Site hors Maps (ancienne règle)';
    case 'mobile_performance_critical':
      return 'Perf mobile critique (ancienne règle)';
    case 'diamant_creation':
      return 'Diamant création — pas de site propriétaire (réputation Maps), score symbolique / matrice non appliquée';
    case 'strate_matrix':
      return `Diamant Strate — matrice ≥ ${STRATE_DIAMOND_THRESHOLD} pts`;
  }
}

function formatNearbyCompetitorsMarkdown(
  competitors: readonly RadarNearbyCompetitor[] | undefined,
): string[] {
  if (competitors === undefined || competitors.length === 0) return [];
  return [
    `#### Concurrents à proximité (FOMO)`,
    ``,
    `_Même type d’activité primaire (Google Places), tri par distance — uniquement des fiches avec site web sur Maps._`,
    ``,
    ...competitors.map((c, i) => {
      const note =
        typeof c.rating === 'number' && !Number.isNaN(c.rating)
          ? String(Math.round(c.rating * 100) / 100)
          : '—';
      return `- **${i + 1}.** ${c.name} — ${c.websiteUrl} — note **${note}** — **≈ ${c.distanceMeters} m**`;
    }),
    ``,
  ];
}

function formatDigitalGrowthMarkdown(levers: readonly string[] | undefined): string[] {
  if (levers === undefined || levers.length === 0) return [];
  return [
    `#### Leviers digitaux personnalisés (Groq / avis Places)`,
    ``,
    ...levers.map((x, i) => `- **${i + 1}.** ${x.replace(/\s+/g, ' ').trim()}`),
    ``,
  ];
}

function formatStrateScoreSection(s: PipelineStrateScore | undefined): string[] {
  if (s === undefined) return [];
  if (s.isDiamantCreation || s.matrix === null) {
    return [
      `#### Strate Score`,
      ``,
      `- **Total :** ${s.total}/100 — _Diamant création : pas d’analyse technique (fetch / Groq conversion / PageSpeed non exécutés)._`,
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

  const diamants = result.lines.filter(
    (l) => l.conversionBadge === 'DIAMANT_CREATION' || l.conversionBadge === 'DIAMANT_REFONTE',
  );
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
          `_Aucune pépite qualifiée dans les limites du run (requêtes Places \`${result.placesRequestsUsed}/${result.placesRequestsMax}\`, seuils ou filtres)._`,
          ``,
          `---`,
          ``,
        ].join('\n')
      : [
          `## 💎 BUTIN DU JOUR : LES 5 PÉPITES`,
          ``,
          `_Qualification : **Diamant création** — pas de site propriétaire (réseaux / annuaires exclus) + avis > 5 & note > 3,5. **Diamant refonte** — site résolu + **Strate** ≥ ${STRATE_DIAMOND_THRESHOLD}/100. Intentions **Suggest** en mode demand-driven._`,
          ``,
          ...pepites.flatMap((l) => {
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

            const valueAtRiskSubtitle =
              l.diamondPain === 'diamant_creation'
                ? '(données brutes — pas de pitch radar)'
                : '(matrice Strate — pas d’estimation Groq)';
            const valueAtRiskBody =
              '_Pas d’estimation « manque à gagner » automatique — voir piliers Strate ci-dessous et `googleMapsRaw` / `google_maps_raw` côté vitrine._';

            const block = [
              `### 💎 ${l.serp.title}`,
              ``,
              `> ### ⚠️ Value-at-Risk ${valueAtRiskSubtitle}`,
              `> `,
              `> **${valueAtRiskBody}**`,
              ``,
              `- **Type lead :** ${l.conversionBadge}`,
              `- **Douleur :** ${l.diamondPain !== undefined ? painLabelFr(l.diamondPain) : '—'}`,
              `- **Métier (Maps) :** ${l.serp.type?.trim() || '—'}`,
              `- **Grainage :** ${l.seedCategory ?? '—'}`,
              `- **Note / avis :** ${l.serp.rating ?? '—'} (${l.serp.reviews ?? 0} avis)`,
              `- **Adresse :** ${l.serp.address ?? '—'}`,
              siteLine,
              ``,
              ...formatNearbyCompetitorsMarkdown(l.nearbyCompetitors),
              ...formatDigitalGrowthMarkdown(l.digitalGrowthLevers),
              ...vitrineLine,
              ...formatStrateScoreSection(l.strateScore),
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
    `- **Création :** ${result.creationsFound} / ${result.targetCreationCount} · **Refonte :** ${result.refontesFound} / ${result.targetRefonteCount}`,
    `- **Fiches Maps parcourues :** ${result.totalBusinessesScanned}`,
    `- **Requêtes Places (plafond run) :** ${result.placesRequestsUsed} / ${result.placesRequestsMax}`,
    ...(result.placesStoppedEarly
      ? [
          `- **⚠ Arrêt Google Places :** quota / limite (HTTP 429) — run terminé avec résultats partiels.`,
          ...(result.placesStopMessage !== undefined
            ? [`  - _${result.placesStopMessage.replace(/\s+/g, ' ').trim()}_`]
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
