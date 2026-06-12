import type { SerpClassifierDetailedResult } from './serp-classifier.js';
import type { WebsitePresenceStatus } from '../website-presence-types.js';

/** Audit trail persisté + loggable pour le classifieur SERP (Groq). */
export type SerpClassifierAuditRecord = {
  readonly model: string;
  readonly latencyMs: number;
  readonly urlsSent: readonly string[];
  readonly urlsDropped: readonly string[];
  readonly matchedUrl: string | null;
  readonly status: WebsitePresenceStatus;
  readonly confidence: number;
  readonly reason: string;
  readonly rawResponse: string;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
};

export function buildSerpClassifierAuditRecord(
  detailed: SerpClassifierDetailedResult,
): SerpClassifierAuditRecord {
  const { result, trace } = detailed;
  return {
    model: trace.model,
    latencyMs: trace.latencyMs,
    urlsSent: [...trace.urlsSent],
    urlsDropped: [...trace.urlsDropped],
    matchedUrl: result.matchedUrl,
    status: result.status,
    confidence: result.confidence,
    reason: result.reason,
    rawResponse: trace.rawResponse,
    promptTokens: trace.usage.promptTokens,
    completionTokens: trace.usage.completionTokens,
    totalTokens: trace.usage.totalTokens,
  };
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function formatUrlList(urls: readonly string[], maxItems = 7): string {
  if (urls.length === 0) return '(aucune)';
  return urls
    .slice(0, maxItems)
    .map((url, index) => `${index + 1}. ${url}`)
    .join(' · ');
}

/** Journal structuré — grep-friendly via préfixe `[serp-classifier]`. */
export function logSerpClassifierAudit(args: {
  readonly logPrefix: string;
  readonly businessName: string;
  readonly city: string | null;
  readonly audit: SerpClassifierAuditRecord;
  readonly cascadeNote?: string;
}): void {
  const city = args.city?.trim() || '—';
  const p = args.logPrefix;
  const a = args.audit;

  console.log(`${p}[serp-classifier] ${args.businessName} · ville ${city}`);
  if (args.cascadeNote) {
    console.log(`${p}[serp-classifier] cascade · ${args.cascadeNote}`);
  }
  console.log(
    `${p}[serp-classifier] verdict · status=${a.status} · conf=${a.confidence.toFixed(2)} · latency=${a.latencyMs}ms · model=${a.model}`,
  );
  console.log(`${p}[serp-classifier] matched · ${a.matchedUrl ?? '—'}`);
  console.log(`${p}[serp-classifier] reason · ${a.reason}`);
  console.log(
    `${p}[serp-classifier] urls_sent(${a.urlsSent.length}) · ${formatUrlList(a.urlsSent)}`,
  );
  if (a.urlsDropped.length > 0) {
    console.log(
      `${p}[serp-classifier] urls_dropped(${a.urlsDropped.length}) · ${formatUrlList(a.urlsDropped)}`,
    );
  }
  if (a.rawResponse) {
    console.log(`${p}[serp-classifier] groq_raw · ${truncate(a.rawResponse, 480)}`);
  }
  const tokens = [
    a.promptTokens !== null ? `prompt=${a.promptTokens}` : null,
    a.completionTokens !== null ? `completion=${a.completionTokens}` : null,
    a.totalTokens !== null ? `total=${a.totalTokens}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (tokens) {
    console.log(`${p}[serp-classifier] tokens · ${tokens}`);
  }
}

export function logSerpClassifierFailure(args: {
  readonly logPrefix: string;
  readonly businessName: string;
  readonly city: string | null;
  readonly urlsSent: readonly string[];
  readonly error: string;
}): void {
  const city = args.city?.trim() || '—';
  const p = args.logPrefix;
  console.log(`${p}[serp-classifier] ${args.businessName} · ville ${city} · ERREUR`);
  console.log(`${p}[serp-classifier] urls_sent(${args.urlsSent.length}) · ${formatUrlList(args.urlsSent)}`);
  console.log(`${p}[serp-classifier] error · ${truncate(args.error, 320)}`);
}
