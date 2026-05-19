import fs from 'node:fs/promises';

import {
  buildTelegramReportSections,
  flattenTelegramMessages,
  sendTelegramMessages,
} from '../lib/telegram-notify.js';
import type { RunTelemetryPayload } from '../lib/run-telemetry.js';

async function readOptional(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function readTelemetry(path: string): Promise<RunTelemetryPayload | null> {
  const raw = await readOptional(path);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RunTelemetryPayload;
  } catch {
    return null;
  }
}

function parseJobStatus(raw: string | undefined): 'success' | 'failure' | 'cancelled' {
  if (raw === 'success' || raw === 'failure' || raw === 'cancelled') return raw;
  return 'failure';
}

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) {
    console.log('Telegram ignoré : TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID absent.');
    return;
  }

  const runUrl =
    process.env.RUN_URL?.trim() ??
    (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : '—');

  const jobStatus = parseJobStatus(process.env.JOB_STATUS);
  const heartbeatPath = process.env.RADAR_HEARTBEAT_PATH?.trim() || 'data/heartbeat.json';
  const rapportPath = process.env.RADAR_REPORT_PATH?.trim() || 'rapport_matinal.md';

  const telemetry = await readTelemetry(heartbeatPath);
  const rapportMarkdown = await readOptional(rapportPath);

  const sections = buildTelegramReportSections({
    telemetry,
    rapportMarkdown,
    jobStatus,
    runUrl,
  });
  const messages = flattenTelegramMessages(sections);

  console.log(`Telegram : envoi de ${messages.length} message(s)…`);
  await sendTelegramMessages({ token, chatId, messages });
  console.log('Telegram : OK.');
}

main().catch((err: unknown) => {
  console.error('Telegram : échec envoi.', err);
  process.exitCode = 1;
});
