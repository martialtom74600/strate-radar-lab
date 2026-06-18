import type { RunTelemetryPayload } from './run-telemetry.js';

const TELEGRAM_MAX_MESSAGE = 4000;

function truncateTitle(text: string, max = 52): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function formatParisDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function statusHeader(jobStatus: 'success' | 'failure' | 'cancelled'): {
  emoji: string;
  label: string;
} {
  if (jobStatus === 'success') return { emoji: '✅', label: 'Run terminé' };
  if (jobStatus === 'cancelled') return { emoji: '⏹', label: 'Run annulé' };
  return { emoji: '❌', label: 'Échec' };
}

function leadBadgeByName(
  leads: RunTelemetryPayload['leads'],
): Map<string, RunTelemetryPayload['leads'][number]['badge']> {
  const map = new Map<string, RunTelemetryPayload['leads'][number]['badge']>();
  for (const lead of leads) {
    map.set(lead.name.trim().toLowerCase(), lead.badge);
  }
  return map;
}

function badgeLabel(badge: string | undefined): string {
  if (badge === 'DIAMANT_PRESENCE') return 'présence';
  if (badge === 'DIAMANT_REFONTE') return 'refonte';
  if (badge === 'DIAMANT_CREATION') return 'création';
  return '';
}

function formatPublishedLines(telemetry: RunTelemetryPayload): string[] {
  const badgeMap = leadBadgeByName(telemetry.leads);
  const lines: string[] = [];

  for (const pub of telemetry.ingest.successes) {
    const kind = badgeLabel(badgeMap.get(pub.name.trim().toLowerCase()));
    const suffix = kind ? ` · ${kind}` : '';
    lines.push(`${truncateTitle(pub.name)}${suffix}`);
    lines.push(pub.publicUrl);
    lines.push('');
  }

  if (lines.length > 0) {
    lines.pop();
  }

  return lines;
}

function formatSerpHealth(telemetry: RunTelemetryPayload): string {
  const boot = telemetry.webSearchBootStatus;
  if (!telemetry.webSearchConfigured) return 'Web : inactif';
  if (boot.includes('Serper') && boot.includes('Brave')) return 'Serper + Brave';
  if (boot.includes('Brave fallback') && !boot.includes('Serper')) {
    return '⚠️ Brave seul — Serper absent';
  }
  if (boot.includes('Serper')) return 'Serper actif';
  return boot.replace(/^actif · /, '').replace(/ · plafond.*/, '');
}

function collectActionableAlerts(telemetry: RunTelemetryPayload): string[] {
  const alerts: string[] = [...telemetry.errors];

  for (const w of telemetry.warnings) {
    if (w.includes('Gatekeeper')) continue;
    if (w.includes('sous seuil refonte')) continue;
    if (w.includes('Quota refonte non atteint')) continue;
    if (w.includes('Quota création non atteint')) continue;
    if (w.startsWith('Creation Hunt :')) continue;
    if (w.startsWith('Mode audit ciblé')) continue;
    alerts.push(w);
  }

  if (telemetry.placesStoppedEarly && !alerts.some((a) => a.includes('Places'))) {
    alerts.push('Google Places interrompu (quota / 429)');
  }
  if (telemetry.serpQuotasExhausted && !alerts.some((a) => a.includes('SERP'))) {
    alerts.push('Quotas recherche web épuisés');
  }

  const serp = formatSerpHealth(telemetry);
  if (serp.includes('Serper absent')) {
    alerts.push(serp);
  }

  return alerts;
}

function formatTargetedRun(telemetry: RunTelemetryPayload, runUrl: string): string {
  const lead = telemetry.leads[0];
  const lines = [
    `${statusHeader('success').emoji} Audit ciblé · ${formatParisDate(telemetry.lastRunIso)}`,
    '',
    lead ? truncateTitle(lead.name, 64) : telemetry.searchQuery,
  ];

  if (lead) {
    lines.push(
      `Web : ${lead.webStatus ?? '—'}${lead.presencePlatform ? ` (${lead.presencePlatform})` : ''}`,
    );
    if (lead.displayUrl) lines.push(lead.displayUrl);
  }

  if (telemetry.ingest.successes.length > 0) {
    lines.push('', 'Publié :', telemetry.ingest.successes[0]!.publicUrl);
  } else if (telemetry.ingest.failures.length > 0) {
    const f = telemetry.ingest.failures[0]!;
    lines.push('', `Ingest échoué · HTTP ${f.status} · ${f.message}`);
  } else {
    lines.push('', 'Non publié sur la vitrine.');
  }

  const alerts = collectActionableAlerts(telemetry);
  if (alerts.length > 0) {
    lines.push('', '⚠️', ...alerts.map((a) => `• ${a}`));
  }

  lines.push('', `🔗 ${runUrl}`);
  return lines.join('\n');
}

function formatNightlyRun(
  telemetry: RunTelemetryPayload,
  jobStatus: 'success' | 'failure' | 'cancelled',
  runUrl: string,
): string {
  const { emoji, label } = statusHeader(jobStatus);
  const zone = telemetry.searchLocation ?? '—';
  const published = telemetry.ingest.successCount;
  const target = telemetry.targetCreationCount;

  const lines = [
    `${emoji} Strate Radar · ${label}`,
    `${formatParisDate(telemetry.lastRunIso)} · ${zone}`,
    '',
    `💎 ${published} publié${published > 1 ? 's' : ''} / ${target} visé${target > 1 ? 's' : ''}`,
    '',
  ];

  if (published > 0) {
    lines.push(...formatPublishedLines(telemetry));
  } else {
    lines.push('Aucun audit publié ce run.');
  }

  if (telemetry.ingest.failures.length > 0) {
    lines.push('', '❌ Ingest échoué');
    for (const f of telemetry.ingest.failures) {
      lines.push(`• ${truncateTitle(f.name)} · HTTP ${f.status}`);
    }
  }

  const alerts = collectActionableAlerts(telemetry);
  if (alerts.length > 0) {
    lines.push('', '⚠️ À surveiller');
    for (const a of alerts) {
      lines.push(`• ${a}`);
    }
  }

  lines.push(
    '',
    `🔌 ${telemetry.totalBusinessesScanned} fiches · Places ${telemetry.placesRequestsUsed}/${telemetry.placesRequestsMax} · Web ${telemetry.webSearchRequestsUsed}/${telemetry.webSearchRequestsMax}`,
    formatSerpHealth(telemetry),
    '',
    `🔗 ${runUrl}`,
  );

  return lines.join('\n');
}

function formatFailureWithoutTelemetry(
  jobStatus: 'success' | 'failure' | 'cancelled',
  runUrl: string,
): string {
  const { emoji, label } = statusHeader(jobStatus);
  return [
    `${emoji} Strate Radar · ${label}`,
    '',
    'Le pipeline a planté avant la fin — pas de heartbeat.',
    '',
    `🔗 ${runUrl}`,
  ].join('\n');
}

/** Message Telegram court — une seule section lisible. */
export function buildTelegramReportSections(args: {
  readonly telemetry: RunTelemetryPayload | null;
  readonly rapportMarkdown: string | null;
  readonly jobStatus: 'success' | 'failure' | 'cancelled';
  readonly runUrl: string;
}): string[] {
  const { telemetry, jobStatus, runUrl } = args;

  if (!telemetry) {
    return [formatFailureWithoutTelemetry(jobStatus, runUrl)];
  }

  if (telemetry.targetedMode) {
    return [formatTargetedRun(telemetry, runUrl)];
  }

  return [formatNightlyRun(telemetry, jobStatus, runUrl)];
}

export function flattenTelegramMessages(sections: readonly string[]): string[] {
  const full = sections.join('\n\n');
  if (full.length <= TELEGRAM_MAX_MESSAGE) return [full];

  const chunks: string[] = [];
  let rest = full;
  while (rest.length > TELEGRAM_MAX_MESSAGE) {
    let cut = rest.lastIndexOf('\n', TELEGRAM_MAX_MESSAGE);
    if (cut < Math.floor(TELEGRAM_MAX_MESSAGE * 0.4)) cut = TELEGRAM_MAX_MESSAGE;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);

  return chunks.map((body, i, all) =>
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
