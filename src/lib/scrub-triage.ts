import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { WebsitePresenceStatus } from './website-presence-types.js';

export type ScrubTriageEntry = {
  readonly businessName: string;
  readonly slug: string | null;
  readonly status: WebsitePresenceStatus;
  readonly url: string | null;
  readonly reason: string | null;
};

export function isScrubReadyProspect(status: WebsitePresenceStatus): boolean {
  return status === 'presence_only';
}

export function isScrubNeedsReview(status: WebsitePresenceStatus): boolean {
  return status === 'needs_review';
}

export function isScrubDisqualifiedStatus(status: WebsitePresenceStatus): boolean {
  return status === 'owner_site' || status === 'corporate_parent';
}

export function printScrubTriageSummary(args: {
  readonly ready: readonly ScrubTriageEntry[];
  readonly disqualified: readonly ScrubTriageEntry[];
  readonly needsReview: readonly ScrubTriageEntry[];
}): void {
  console.log('\n[SCRUB] ═══ Synthèse triage ═══');

  console.log(`\n🟢 BONS PROSPECTS (${args.ready.length}) — prêts pour impression`);
  if (args.ready.length === 0) {
    console.log('  (aucun)');
  } else {
    for (const entry of args.ready) {
      const slug = entry.slug ? ` · ${entry.slug}` : '';
      const url = entry.url ? ` · ${entry.url}` : '';
      console.log(`  · ${entry.businessName}${slug}${url}`);
    }
  }

  console.log(`\n🔴 DISQUALIFIÉS (${args.disqualified.length}) — poubelle`);
  if (args.disqualified.length === 0) {
    console.log('  (aucun)');
  } else {
    for (const entry of args.disqualified) {
      const slug = entry.slug ? ` · ${entry.slug}` : '';
      const url = entry.url ? ` · ${entry.url}` : '';
      console.log(`  · ${entry.businessName}${slug}${url}`);
    }
  }

  console.log(`\n🟠 À VÉRIFIER MANUELLEMENT (${args.needsReview.length}) — quarantaine`);
  if (args.needsReview.length === 0) {
    console.log('  (aucun)');
  } else {
    for (const entry of args.needsReview) {
      const slug = entry.slug ? ` · ${entry.slug}` : '';
      const url = entry.url ? ` · ${entry.url}` : '';
      const reason = entry.reason ? ` — ${entry.reason.slice(0, 100)}` : '';
      console.log(`  · ${entry.businessName}${slug}${url}${reason}`);
    }
  }
}

export type ScrubTriageExport = {
  readonly generatedAt: string;
  readonly dryRun: boolean;
  readonly counts: {
    readonly ready: number;
    readonly disqualified: number;
    readonly needsReview: number;
  };
  readonly ready: readonly ScrubTriageEntry[];
  readonly disqualified: readonly ScrubTriageEntry[];
  readonly needsReview: readonly ScrubTriageEntry[];
};

export async function writeScrubTriageExport(args: {
  readonly outputDir: string;
  readonly dryRun: boolean;
  readonly ready: readonly ScrubTriageEntry[];
  readonly disqualified: readonly ScrubTriageEntry[];
  readonly needsReview: readonly ScrubTriageEntry[];
}): Promise<string> {
  const payload: ScrubTriageExport = {
    generatedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    counts: {
      ready: args.ready.length,
      disqualified: args.disqualified.length,
      needsReview: args.needsReview.length,
    },
    ready: args.ready,
    disqualified: args.disqualified,
    needsReview: args.needsReview,
  };

  await mkdir(args.outputDir, { recursive: true });
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const latestPath = path.join(args.outputDir, 'scrub-triage-latest.json');
  await writeFile(latestPath, json, 'utf8');
  return latestPath;
}

function triageEntryKey(entry: Pick<ScrubTriageEntry, 'slug' | 'businessName'>): string {
  if (entry.slug) return `slug:${entry.slug}`;
  return `name:${entry.businessName.trim().toLowerCase()}`;
}

export function quarantineEntryToTriageEntry(entry: ScrubQuarantinePersistedEntry): ScrubTriageEntry {
  return {
    businessName: entry.businessName,
    slug: entry.slug,
    status: entry.websiteStatus as WebsitePresenceStatus,
    url: typeof entry.resolution.url === 'string' ? entry.resolution.url : null,
    reason:
      typeof entry.resolution.classificationReason === 'string'
        ? entry.resolution.classificationReason
        : null,
  };
}

/** Retire les 🟠 résolus de needsReview et les ajoute à ready. */
export function mergeQuarantineResolvedIntoTriage(
  triage: ScrubTriageExport,
  quarantine: ScrubQuarantineExport,
): ScrubTriageExport {
  const resolvedKeys = new Set<string>();
  const promoted: ScrubTriageEntry[] = [];
  const readyKeys = new Set(triage.ready.map(triageEntryKey));

  for (const entry of quarantine.entries) {
    const status = entry.websiteStatus as WebsitePresenceStatus;
    if (isScrubNeedsReview(status) || entry.disqualified) continue;

    const triageEntry = quarantineEntryToTriageEntry(entry);
    const key = triageEntryKey(triageEntry);
    resolvedKeys.add(key);
    if (!readyKeys.has(key)) {
      promoted.push(triageEntry);
      readyKeys.add(key);
    }
  }

  const needsReview = triage.needsReview.filter((e) => !resolvedKeys.has(triageEntryKey(e)));
  const ready = [...triage.ready, ...promoted];

  return {
    generatedAt: new Date().toISOString(),
    dryRun: false,
    counts: {
      ready: ready.length,
      disqualified: triage.disqualified.length,
      needsReview: needsReview.length,
    },
    ready,
    disqualified: triage.disqualified,
    needsReview,
  };
}

export async function refreshScrubTriageAfterQuarantine(args: {
  readonly triagePath?: string;
  readonly quarantinePath?: string;
  readonly outputDir?: string;
}): Promise<string> {
  const triagePath = args.triagePath ?? defaultScrubTriageExportPath();
  const quarantinePath = args.quarantinePath ?? defaultScrubQuarantineExportPath();
  const triage = await loadScrubTriageExport(triagePath);
  const quarantine = await loadScrubQuarantineExport(quarantinePath);
  const merged = mergeQuarantineResolvedIntoTriage(triage, quarantine);
  return writeScrubTriageExport({
    outputDir: args.outputDir ?? path.dirname(triagePath),
    dryRun: false,
    ready: merged.ready,
    disqualified: merged.disqualified,
    needsReview: merged.needsReview,
  });
}

export function defaultScrubTriageExportPath(cwd: string = process.cwd()): string {
  return path.join(cwd, 'data', 'scrub-triage-latest.json');
}

export async function loadScrubTriageExport(filePath: string): Promise<ScrubTriageExport> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as ScrubTriageExport;
  if (!Array.isArray(parsed.needsReview)) {
    throw new Error(`Export triage invalide : needsReview absent dans ${filePath}`);
  }
  return parsed;
}

export type ScrubQuarantinePersistedEntry = {
  readonly slug: string | null;
  readonly businessName: string;
  readonly auditId: string | null;
  readonly placeKey: string;
  readonly dryRun: boolean;
  readonly disqualified: boolean;
  readonly websiteStatus: string;
  readonly resolution: Record<string, unknown>;
};

export type ScrubQuarantineExport = {
  readonly generatedAt: string;
  readonly dryRun: boolean;
  readonly persisted: boolean;
  readonly entries: readonly ScrubQuarantinePersistedEntry[];
};

export function defaultScrubQuarantineExportPath(cwd: string = process.cwd()): string {
  return path.join(cwd, 'data', 'scrub-quarantine-latest.json');
}

export async function loadScrubQuarantineExport(filePath: string): Promise<ScrubQuarantineExport> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as ScrubQuarantineExport;
  if (!Array.isArray(parsed.entries)) {
    throw new Error(`Export quarantaine invalide : entries absent dans ${filePath}`);
  }
  return parsed;
}

export async function writeScrubQuarantineExport(args: {
  readonly outputDir: string;
  readonly dryRun: boolean;
  readonly persisted: boolean;
  readonly entries: readonly ScrubQuarantinePersistedEntry[];
}): Promise<string> {
  const payload: ScrubQuarantineExport = {
    generatedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    persisted: args.persisted,
    entries: args.entries,
  };
  await mkdir(args.outputDir, { recursive: true });
  const latestPath = path.join(args.outputDir, 'scrub-quarantine-latest.json');
  await writeFile(latestPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return latestPath;
}
