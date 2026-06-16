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
