import type { WebsiteResolution } from './website-resolver.js';
import type { ProspectRepository } from '../storage/index.js';
import type { SupabaseScrubClient } from '../storage/supabase-scrub.js';

export type ScrubClassifierPersistInput = {
  readonly auditId: string | null;
  readonly slug: string | null;
  readonly placeKey: string;
  readonly businessName: string;
  readonly dryRun: boolean;
  readonly disqualified: boolean;
  readonly resolution: WebsiteResolution;
};

/** Payload JSON persisté (SQLite + Supabase `audits.payload.websiteResolution`). */
export function websiteResolutionForPersistence(
  resolution: WebsiteResolution,
): Record<string, unknown> {
  return {
    status: resolution.status,
    confidence: resolution.confidence,
    url: resolution.url,
    displayUrl: resolution.displayUrl,
    normalizedUrl: resolution.normalizedUrl,
    source: resolution.source,
    mapsListingWebsite: resolution.mapsListingWebsite,
    presencePlatform: resolution.presencePlatform,
    classificationReason: resolution.classificationReason,
    classifierAudit: resolution.classifierAudit,
    attempts: resolution.attempts,
  };
}

export function scrubActionFromEvaluation(input: ScrubClassifierPersistInput): 'kept' | 'disqualified' {
  return input.disqualified ? 'disqualified' : 'kept';
}

export function scrubClassifierLogRow(input: ScrubClassifierPersistInput): {
  readonly auditId: string | null;
  readonly slug: string | null;
  readonly placeKey: string;
  readonly businessName: string;
  readonly dryRun: number;
  readonly scrubAction: 'kept' | 'disqualified';
  readonly websiteStatus: string;
  readonly matchedUrl: string | null;
  readonly classificationReason: string | null;
  readonly resolutionJson: string;
} {
  const payload = websiteResolutionForPersistence(input.resolution);
  return {
    auditId: input.auditId,
    slug: input.slug,
    placeKey: input.placeKey,
    businessName: input.businessName,
    dryRun: input.dryRun ? 1 : 0,
    scrubAction: scrubActionFromEvaluation(input),
    websiteStatus: input.resolution.status,
    matchedUrl: input.resolution.url ?? input.resolution.classifierAudit?.matchedUrl ?? null,
    classificationReason: input.resolution.classificationReason,
    resolutionJson: JSON.stringify(payload),
  };
}

export async function persistClassifierDecision(args: {
  readonly repo: ProspectRepository;
  readonly supabase: SupabaseScrubClient | null;
  readonly input: ScrubClassifierPersistInput;
}): Promise<void> {
  await args.repo.insertScrubClassifierLog(scrubClassifierLogRow(args.input));
  if (args.input.auditId && args.supabase) {
    await args.supabase.patchAuditWebsiteResolution(
      args.input.auditId,
      websiteResolutionForPersistence(args.input.resolution),
    );
  }
}
