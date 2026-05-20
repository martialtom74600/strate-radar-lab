import type { RunTelemetryPayload } from './run-telemetry.js';

const TELEGRAM_MAX_MESSAGE = 4000;
/** Sous-seuil refonte : détail limité sur Telegram (nuit = long). */
const TELEGRAM_NEAR_MISS_DETAIL_MAX = 5;

function truncateTitle(text: string, max = 56): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function formatNearMissTelegramBlock(
  misses: RunTelemetryPayload['scoreNearMisses'],
  total?: number,
): string {
  if (misses.length === 0) return '';
  const shown = misses.slice(0, TELEGRAM_NEAR_MISS_DETAIL_MAX);
  const lines = shown.map((m) => {
    const score = m.strateScore !== null ? `${m.strateScore}/${m.threshold}` : '—';
    return `• ${truncateTitle(m.name)} · ${score}${m.displayUrl ? ` · ${truncateTitle(m.displayUrl, 48)}` : ''}`;
  });
  const grandTotal = total ?? misses.length;
  const omitted = grandTotal - misses.length;
  if (omitted > 0) {
    lines.push(`… +${omitted} autre(s) — voir rapport_matinal.md (artefact Actions).`);
  }
  return ['—— SOUS SEUIL REFONTE ——', '', ...lines].join('\n');
}

function chunkText(text: string, max = TELEGRAM_MAX_MESSAGE): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < Math.floor(max * 0.4)) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function formatMode(t: RunTelemetryPayload): string {
  if (t.targetedMode) return `Audit ciblé · ${t.searchQuery}`;
  if (t.campaign) return `Campagne · ${t.campaign.city} × ${t.campaign.category}`;
  if (t.demandDrivenMode) return `Demand-driven · ${t.trendQueries.length} intention(s)`;
  if (t.multiCategoryMode) return `Grainage multi-métiers · ${t.seedCategories.length} famille(s)`;
  return 'Requête unique';
}

function formatLeadBlock(lead: RunTelemetryPayload['leads'][number], index: number): string {
  const lines = [
    `${index + 1}. ${lead.name}`,
    `   Badge : ${lead.badge}`,
    `   Strate : ${lead.strateScore ?? '—'}/100`,
    `   Web : ${lead.webStatus ?? '—'}${lead.presencePlatform ? ` (${lead.presencePlatform})` : ''}`,
    `   URL : ${lead.displayUrl ?? '—'}`,
    `   Source web : ${lead.webSource ?? '—'}`,
    `   Intention : ${lead.trendingQuery}`,
  ];
  if (lead.publicAuditUrl) {
    lines.push(`   Audit : ${lead.publicAuditUrl}`);
  }
  return lines.join('\n');
}

export function buildTelegramReportSections(args: {
  readonly telemetry: RunTelemetryPayload | null;
  readonly rapportMarkdown: string | null;
  readonly jobStatus: 'success' | 'failure' | 'cancelled';
  readonly runUrl: string;
}): string[] {
  const { telemetry, rapportMarkdown, jobStatus, runUrl } = args;
  const sections: string[] = [];

  const statusEmoji =
    jobStatus === 'success' ? '✅' : jobStatus === 'cancelled' ? '⏹' : '❌';
  const statusLabel =
    jobStatus === 'success'
      ? 'RUN TERMINÉ'
      : jobStatus === 'cancelled'
        ? 'RUN ANNULÉ'
        : 'ÉCHEC WORKFLOW';

  if (!telemetry) {
    sections.push(
      [
        `${statusEmoji} Strate Radar — ${statusLabel}`,
        '',
        'Aucune télémétrie (heartbeat) — le pipeline a probablement planté avant la fin.',
        `Run : ${runUrl}`,
      ].join('\n'),
    );
    return sections;
  }

  const header = [
    `${statusEmoji} Strate Radar — ${statusLabel}`,
    '',
    `📅 ${telemetry.lastRunIso} (${telemetry.workflow})`,
    `📍 Zone : ${telemetry.searchLocation ?? '—'}`,
    `🔎 Requête : ${telemetry.searchQuery}`,
    `📆 Semaine : ${telemetry.weekBucket}`,
    `⚙️ Mode : ${formatMode(telemetry)}`,
    ...(telemetry.targetedMisses.length > 0
      ? [`🎯 Cibles manquées : ${telemetry.targetedMisses.join(' · ')}`]
      : []),
    '',
    '—— QUOTAS ——',
    `💎 Création : ${telemetry.creationsFound}/${telemetry.targetCreationCount}`,
    `🔧 Refonte : ${telemetry.refontesFound}/${telemetry.targetRefonteCount}`,
    `∑ Leads : ${telemetry.diamondsFound}`,
    '',
    '—— SCAN ——',
    `Fiches parcourues : ${telemetry.totalBusinessesScanned}`,
    `Places API : ${telemetry.placesRequestsUsed}/${telemetry.placesRequestsMax}`,
    `Brave Search : ${telemetry.webSearchRequestsUsed}/${telemetry.webSearchRequestsMax} · ${telemetry.webSearchConfigured ? 'clé OK' : 'inactif'}`,
    '',
    '—— INGEST VITRINE ——',
    `Configuré : ${telemetry.ingest.configured ? 'oui' : 'non'}`,
    `Publiés : ${telemetry.ingest.successCount}`,
    `Échecs : ${telemetry.ingest.failureCount}`,
    `Refontes ignorées (non ingestées) : ${telemetry.ingest.skippedRefonteCount}`,
  ];

  if (telemetry.ingest.successes.length > 0) {
    header.push('', 'Audits publiés :');
    for (const s of telemetry.ingest.successes) {
      header.push(`• ${s.name}`);
      header.push(`  ${s.publicUrl}`);
    }
  }

  sections.push(header.join('\n'));

  if (telemetry.leads.length > 0) {
    sections.push(
      [
        '—— LEADS QUALIFIÉS ——',
        '',
        ...telemetry.leads.map((l, i) => formatLeadBlock(l, i)),
      ].join('\n'),
    );
  } else {
    sections.push('—— LEADS QUALIFIÉS ——\n\nAucun diamant qualifié ce run.');
  }

  if (telemetry.scoreNearMisses.length > 0) {
    sections.push(
      formatNearMissTelegramBlock(telemetry.scoreNearMisses, telemetry.scoreNearMissesTotal),
    );
  }

  if (telemetry.warnings.length > 0 || telemetry.errors.length > 0) {
    const alertLines = ['—— ALERTES ——', ''];
    if (telemetry.warnings.length > 0) {
      alertLines.push('⚠️ Avertissements :');
      for (const w of telemetry.warnings) alertLines.push(`• ${w}`);
      alertLines.push('');
    }
    if (telemetry.errors.length > 0) {
      alertLines.push('🚨 Erreurs :');
      for (const e of telemetry.errors) alertLines.push(`• ${e}`);
    }
    sections.push(alertLines.join('\n'));
  }

  if (telemetry.webSearchIssues.length > 0) {
    sections.push(
      [
        '—— RECHERCHE WEB (détail) ——',
        '',
        ...telemetry.webSearchIssues.map((i) => `• ${i.name}\n  ${i.note}`),
      ].join('\n'),
    );
  }

  if (telemetry.gatekeeperExclusions.length > 0) {
    const gkLines = [
      `—— GATEKEEPER (${telemetry.gatekeeperExclusionCount} écart(s)) ——`,
      '',
    ];
    for (const g of telemetry.gatekeeperExclusions) {
      gkLines.push(`• ${g.name}`);
      gkLines.push(`  ${g.reason}`);
    }
    if (telemetry.gatekeeperExclusionCount > telemetry.gatekeeperExclusions.length) {
      gkLines.push(
        `… +${telemetry.gatekeeperExclusionCount - telemetry.gatekeeperExclusions.length} autre(s) (voir rapport).`,
      );
    }
    sections.push(gkLines.join('\n'));
  }

  if (telemetry.placesStoppedEarly || telemetry.placesBudgetExhausted) {
    const infra: string[] = ['—— INFRA API ——', ''];
    if (telemetry.placesStoppedEarly) {
      infra.push('⚠️ Places arrêt anticipé (429 / quota).');
      if (telemetry.placesStopMessage) infra.push(telemetry.placesStopMessage);
    }
    if (telemetry.placesBudgetExhausted) {
      infra.push('⚠️ Budget Places du run épuisé.');
    }
    sections.push(infra.join('\n'));
  }

  sections.push(`—— LIEN RUN ——\n${runUrl}`);

  if (rapportMarkdown && rapportMarkdown.trim()) {
    if (telemetry.targetedMode) {
      sections.push(`—— RAPPORT MATINAL ——\n\n${rapportMarkdown.trim()}`);
    } else {
      sections.push(
        '—— RAPPORT ——\n\n📄 Rapport markdown complet : artefact GitHub Actions (`rapport_matinal.md`).',
      );
    }
  }

  return sections;
}

export function flattenTelegramMessages(sections: readonly string[]): string[] {
  const full = sections.join('\n\n');
  return chunkText(full).map((body, i, all) =>
    all.length > 1 ? `[${i + 1}/${all.length}]\n${body}` : body,
  );
}

export async function sendTelegramMessages(args: {
  readonly token: string;
  readonly chatId: string;
  readonly messages: readonly string[];
}): Promise<void> {
  const { token, chatId, messages } = args;
  for (const text of messages) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    const json = (await res.json()) as { ok?: boolean; description?: string };
    if (!json.ok) {
      throw new Error(json.description ?? `Telegram HTTP ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 350));
  }
}
