/**
 * Test scrub / website-resolver sur une seule entreprise (Supabase published).
 *
 * Usage :
 *   npm run scrub:one -- "Annecy Assistance Depannage SARL"
 *   npm run scrub:one -- "LAMY" --dry-run
 *   npm run scrub:one -- "LAMY" --apply   # révoque + option --purge
 */

import { loadScrubConfig } from '../config/index.js';
import { createRadarSearchClient } from '../lib/google-places.client.js';
import {
  evaluateScrubCandidateWithWebsiteResolver,
  loadScrubCandidates,
} from '../lib/retroactive-scrub.js';
import { createSerpManagerWebClient } from '../services/serp/serp-manager.js';
import {
  closeDatabase,
  migrateRadarDiamondSnapshot,
  migrateRadarPlaceLastOutcome,
  migrateRadarScrubClassifierLog,
  openDatabase,
  ProspectRepository,
} from '../storage/index.js';
import { createSupabaseScrubClient } from '../storage/supabase-scrub.js';

function parseArgs(argv: readonly string[]): {
  readonly nameQuery: string;
  readonly dryRun: boolean;
  readonly apply: boolean;
  readonly purge: boolean;
} {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const nameQuery = positional.join(' ').trim();
  if (!nameQuery) {
    throw new Error(
      'Nom requis : npm run scrub:one -- "Annecy Assistance Depannage SARL" [--dry-run] [--apply] [--purge]',
    );
  }
  const apply = flags.has('--apply');
  return {
    nameQuery,
    dryRun: flags.has('--dry-run') || !apply,
    apply,
    purge: flags.has('--purge'),
  };
}

function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

async function main(): Promise<void> {
  const { nameQuery, dryRun, apply, purge } = parseArgs(process.argv.slice(2));
  const config = loadScrubConfig(process.env, { dryRun: true });

  const databaseUrl = config.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('[SCRUB-ONE] DATABASE_URL absente.');
    process.exit(1);
  }

  const supabase = createSupabaseScrubClient(databaseUrl);
  const db = await openDatabase(config.STRATE_RADAR_DB_PATH);
  await migrateRadarPlaceLastOutcome(db);
  await migrateRadarDiamondSnapshot(db);
  await migrateRadarScrubClassifierLog(db);
  const repo = new ProspectRepository(db);
  const serpClient = createRadarSearchClient(config);
  const webSearchClient = createSerpManagerWebClient(config);

  try {
    const candidates = await loadScrubCandidates({
      config,
      repo,
      supabase,
      importShadowExport: false,
    });

    const needle = normalizeForMatch(nameQuery);
    const matches = candidates.filter((c) =>
      normalizeForMatch(c.businessName).includes(needle),
    );

    if (matches.length === 0) {
      console.log(`[SCRUB-ONE] Aucun audit publié (création/présence) pour « ${nameQuery} ».`);
      console.log('[SCRUB-ONE] Déjà révoqué, purgé, ou jamais ingéré.');
      process.exit(1);
    }

    if (matches.length > 1) {
      console.log(`[SCRUB-ONE] ${matches.length} correspondance(s) :`);
      for (const m of matches) {
        console.log(`  · ${m.businessName} · ${m.slug ?? m.auditId ?? '—'}`);
      }
    }

    const candidate = matches[0]!;
    console.log(
      `[SCRUB-ONE] Cible · ${candidate.businessName} · ${candidate.slug ?? candidate.auditId} · ${dryRun ? 'DRY-RUN' : apply ? 'APPLY' : 'analyse seule'}`,
    );

    const evaluated = await evaluateScrubCandidateWithWebsiteResolver({
      config,
      serp: candidate.serp,
      serpClient,
      webSearchClient,
      searchLocation: candidate.searchLocation,
      fetchTimeoutMs: config.RADAR_FETCH_TIMEOUT_MS,
    });

    console.log(`[SCRUB-ONE] ${candidate.businessName} · ${evaluated.resolution.status} · shouldDisqualify=${evaluated.shouldDisqualify}`);
    if (evaluated.resolution.url) {
      console.log(`[SCRUB-ONE] matched · ${evaluated.resolution.url}`);
    }
    if (evaluated.resolution.classificationReason) {
      console.log(`[SCRUB-ONE] reason · ${evaluated.resolution.classificationReason}`);
    }

    if (evaluated.resolution.classifierAudit) {
      const audit = evaluated.resolution.classifierAudit;
      console.log(
        `[SCRUB-ONE] Classifier · conf=${audit.confidence?.toFixed(2) ?? '—'} · ${audit.latencyMs ?? '—'}ms · model=${audit.model ?? '—'}`,
      );
      if (audit.urlsSent.length > 0) {
        console.log('[SCRUB-ONE] URLs envoyées :');
        audit.urlsSent.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));
      }
      if (audit.urlsDropped.length > 0) {
        console.log('[SCRUB-ONE] URLs écartées :');
        audit.urlsDropped.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));
      }
    }

    const attempts = evaluated.resolution.attempts ?? [];
    if (attempts.length > 0) {
      console.log(
        `[SCRUB-ONE] cascade · ${attempts.map((a) => `${a.layer}=${a.outcome}${a.note ? `(${a.note.slice(0, 60)})` : ''}`).join(' · ')}`,
      );
    }

    if (!evaluated.shouldDisqualify) {
      if (evaluated.resolution.status === 'needs_review') {
        console.log('[SCRUB-ONE] 🟠 Quarantaine — vérification manuelle requise (pas de révocation).');
      } else {
        console.log('[SCRUB-ONE] 🟢 Conservé — pas de révocation (presence_only).');
      }
      return;
    }

    if (dryRun) {
      console.log('[SCRUB-ONE] DRY-RUN · serait disqualifié (revoke Supabase). Relance avec --apply.');
      return;
    }

    if (candidate.auditId) {
      await supabase.revokeAudit(candidate.auditId);
      console.log(`[SCRUB-ONE] Supabase · status=revoked · ${candidate.auditId}`);
      if (purge) {
        const deleted = await supabase.purgeRevokedDiamondAudit(candidate.auditId);
        console.log(deleted ? '[SCRUB-ONE] Supabase · DELETE OK' : '[SCRUB-ONE] Purge ignorée');
      }
    }
    await repo.recordPlaceOutcome(candidate.placeKey, 'disqualified');
    console.log('[SCRUB-ONE] SQLite · outcome=disqualified');
  } finally {
    await supabase.close();
    await closeDatabase(db);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
