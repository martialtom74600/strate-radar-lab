/**
 * Vérification live du Top 5 Scanner (Brave/Serper → Jina → Groq).
 *
 * Usage : npm run verify:top5
 */

import { loadScrubConfig } from '../config/index.js';
import { fetchJinaReaderMarkdown } from '../lib/ai/jina-reader.js';
import {
  prepareTop5ScannerCandidates,
  scanTop5CandidatesDetailed,
} from '../lib/ai/top5-scanner.js';
import { createSerpManagerWebClient } from '../services/serp/serp-manager.js';
import { buildOwnerDiscoveryQuery } from '../lib/search-location-hint.js';
import { isDedicatedOwnerUrl } from '../lib/host-presence.js';

type VerifyCase = {
  readonly label: string;
  readonly companyName: string;
  readonly city: string;
  readonly expected: 'owner_site' | 'presence_only' | 'needs_review' | 'corporate_parent';
  readonly acceptAlso?: readonly ('owner_site' | 'presence_only' | 'needs_review' | 'corporate_parent')[];
};

const CASES: readonly VerifyCase[] = [
  {
    label: 'Annecy Assistance (site dédié)',
    companyName: 'Annecy Assistance Depannage SARL',
    city: 'Annecy',
    expected: 'owner_site',
    acceptAlso: ['needs_review'],
  },
  {
    label: 'Ma chouette boutique (annuaires seuls)',
    companyName: 'Ma chouette boutique',
    city: 'Annecy',
    expected: 'presence_only',
    acceptAlso: ['needs_review'],
  },
];

function icon(status: string): string {
  if (status === 'owner_site') return '🔴';
  if (status === 'presence_only') return '🟢';
  if (status === 'needs_review') return '🟠';
  if (status === 'corporate_parent') return '🔴';
  return '⚪';
}

async function verifyJina(config: ReturnType<typeof loadScrubConfig>): Promise<boolean> {
  console.log('\n── 1. Jina Reader ──');
  const result = await fetchJinaReaderMarkdown({
    url: 'https://www.annecy-mobilites.fr/',
    timeoutMs: config.RADAR_JINA_TIMEOUT_MS,
    maxMarkdownChars: 2_000,
    apiKey: config.JINA_API_KEY,
  });
  if (!result.ok) {
    console.log(`  ✗ Jina échec · ${result.error}`);
    return false;
  }
  console.log(`  ✓ Jina OK · ${result.latencyMs}ms · ${result.markdown.length} car.`);
  console.log(`    extrait · ${result.markdown.slice(0, 120).replace(/\s+/g, ' ')}…`);
  return true;
}

async function verifyWebDiscovery(
  config: ReturnType<typeof loadScrubConfig>,
): Promise<boolean> {
  console.log('\n── 2. Recherche web (Brave/Serper) ──');
  const web = createSerpManagerWebClient(config);
  if (!web) {
    console.log('  ✗ Client web absent (clés Serper/Brave ou RADAR_WEB_SEARCH_ENABLED)');
    return false;
  }

  const q = buildOwnerDiscoveryQuery('Annecy Assistance Depannage SARL', 'Annecy', 'Annecy, France');
  const r1 = await web.searchWeb(q, { hl: 'fr', gl: 'fr', location: 'Annecy, France' });
  if (r1.error) {
    console.log(`  ✗ Pass 1 · ${r1.error.message}`);
    return false;
  }
  const dedicated1 = r1.hits.filter((h) => isDedicatedOwnerUrl(h.link));
  console.log(`  ✓ Pass 1 · ${r1.hits.length} hit(s) · ${dedicated1.length} domaine(s) dédié(s)`);

  const r2 = await web.searchWeb(`${q} site`, { hl: 'fr', gl: 'fr', location: 'Annecy, France' });
  if (r2.error) {
    console.log(`  ✗ Pass 2 (fallback site) · ${r2.error.message}`);
    return false;
  }
  const mobilites = r2.hits.find((h) => h.link.includes('annecy-mobilites.fr'));
  console.log(
    `  ✓ Pass 2 · ${r2.hits.length} hit(s) · annecy-mobilites.fr ${mobilites ? 'trouvé ✓' : 'absent ✗'}`,
  );
  return Boolean(mobilites);
}

async function verifyCase(
  config: ReturnType<typeof loadScrubConfig>,
  testCase: VerifyCase,
): Promise<boolean> {
  console.log(`\n── Cas · ${testCase.label} ──`);

  const web = createSerpManagerWebClient(config);
  if (!web) return false;

  const discoveryQuery = buildOwnerDiscoveryQuery(
    testCase.companyName,
    testCase.city,
    config.RADAR_SEARCH_LOCATION,
  );
  const searchOpts = { hl: 'fr', gl: 'fr', location: `${testCase.city}, France` };

  const urlsCollected: string[] = [];
  let webSearchOk = false;
  let webSearchHits = 0;

  const r1 = await web.searchWeb(discoveryQuery, searchOpts);
  if (r1.error) {
    console.log(`  ✗ Web search · ${r1.error.message}`);
    return false;
  }
  for (const hit of r1.hits) urlsCollected.push(hit.link);
  webSearchHits += r1.hits.length;

  const hasDedicated = r1.hits.some((h) => isDedicatedOwnerUrl(h.link));
  if (!hasDedicated) {
    const r2 = await web.searchWeb(`${discoveryQuery} site`, searchOpts);
    if (!r2.error) {
      for (const hit of r2.hits) urlsCollected.push(hit.link);
      webSearchHits += r2.hits.length;
    }
  }
  webSearchOk = true;

  const prep = prepareTop5ScannerCandidates({ urlsCollected, priorityUrls: [] });
  console.log(
    `  collecte · ${urlsCollected.length} URL(s) · ${prep.candidates.length} candidat(s) dédié(s) · ${prep.platformUrls.length} plateforme(s)`,
  );
  if (prep.candidates.length > 0) {
    console.log(`  candidats · ${prep.candidates.slice(0, 3).join(' · ')}`);
  }

  const detailed = await scanTop5CandidatesDetailed({
    config,
    companyName: testCase.companyName,
    city: testCase.city,
    urlsCollected,
    priorityUrls: [],
    discovery: {
      attempted: true,
      ok: webSearchOk,
      hits: webSearchHits,
      error: null,
    },
  });

  const { status, reason, matchedUrl } = detailed.result;
  const accepted = [testCase.expected, ...(testCase.acceptAlso ?? [])];
  const ok = accepted.includes(status);

  console.log(
    `  ${ok ? '✓' : '✗'} ${icon(status)} ${status} · conf=${detailed.result.confidence.toFixed(2)} · ${detailed.trace.latencyMs}ms · model=${detailed.trace.model}`,
  );
  console.log(`  matched · ${matchedUrl ?? '—'}`);
  console.log(`  reason · ${reason.slice(0, 140)}`);

  if (status === 'needs_review' && testCase.expected === 'owner_site') {
    console.log('  ℹ needs_review accepté si Groq quota — revérifier quand TPD recharge');
  }

  return ok;
}

async function main(): Promise<void> {
  const config = loadScrubConfig(process.env, { dryRun: true });

  console.log('═══ Vérification Top 5 Scanner ═══');
  console.log(`RADAR_TOP5_SCANNER · ${config.RADAR_TOP5_SCANNER ? 'ON' : 'OFF'}`);
  console.log(
    `APIs · Groq ${config.GROQ_API_KEY ? '✓' : '✗'} · Jina ${config.JINA_API_KEY ? '✓' : '✗'} · Brave ${config.BRAVE_SEARCH_API_KEY ? '✓' : '✗'} · Serper ${config.SERPER_API_KEY ? '✓' : '✗'}`,
  );

  const checks: boolean[] = [];
  checks.push(await verifyJina(config));
  checks.push(await verifyWebDiscovery(config));

  for (const testCase of CASES) {
    checks.push(await verifyCase(config, testCase));
  }

  const passed = checks.filter(Boolean).length;
  const total = checks.length;
  console.log(`\n═══ Résultat · ${passed}/${total} checks OK ═══`);

  if (passed < total) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
