/**
 * Dry-run verbose — 3 cas CEO pour le classifieur SERP (Groq live).
 *
 * Affiche tout le payload : URLs (7 max), prompts system/user, réponse brute, JSON parsé.
 *
 * Usage : npm run serp-classifier:dry-run
 */

import '../config/index.js';
import type { AppConfig } from '../config/index.js';
import {
  classifySerpUrlsDetailed,
  DEFAULT_SERP_CLASSIFIER_MODEL,
  extractMatchedUrl,
  presencePlatformFromUrl,
  type SerpClassifierDetailedResult,
} from '../lib/ai/serp-classifier.js';
import { normalizeProspectUrl, toAbsoluteHttpUrl } from '../lib/url.js';

type CeoDryRunCase = {
  readonly label: string;
  readonly companyName: string;
  readonly city: string;
  readonly expected: 'owner_site' | 'presence_only' | 'corporate_parent' | 'none';
  /** URLs simulant la cascade Maps + Google organique + Brave (ordre de collecte). */
  readonly urlsCollected: readonly string[];
  readonly notes?: string;
};

const CASES: readonly CeoDryRunCase[] = [
  {
    label: 'Bijouterie LAMY',
    companyName: 'Bijouterie LAMY',
    city: 'Annecy',
    expected: 'owner_site',
    notes: 'Site propriétaire lamy-joaillerie.com noyé dans des présences tierces.',
    urlsCollected: [
      'https://www.lamy-joaillerie.com/',
      'https://www.facebook.com/lamyannecy',
      'https://www.instagram.com/lamy_joaillerie_annecy/',
      'https://www.pagesjaunes.fr/pros/bijouterie-lamy-annecy',
      'https://www.google.com/maps/place/Bijouterie+LAMY',
      'https://annuaire-entreprises.data.gouv.fr/entreprise/lamy',
      'https://www.tripadvisor.fr/Attraction_Review-lamy',
      'https://www.yelp.fr/biz/bijouterie-lamy-annecy',
    ],
  },
  {
    label: 'Le Balcon du Lac',
    companyName: 'Le Balcon du Lac',
    city: 'Annecy',
    expected: 'presence_only',
    notes: 'Menu partagé lacarte.menu — pas de domaine exclusif.',
    urlsCollected: [
      'https://lacarte.menu/le-balcon-du-lac',
      'https://www.tripadvisor.fr/Restaurant_Review-le-balcon-du-lac',
      'https://www.facebook.com/lebalcondulac',
      'https://www.google.com/maps/place/Le+Balcon+du+Lac',
      'https://www.lafourchette.com/restaurant/le-balcon-du-lac-r123456',
      'https://www.instagram.com/lebalcondulac/',
      'https://www.pagesjaunes.fr/pros/le-balcon-du-lac',
      'https://www.suggest.com/restaurant/annecy/le-balcon',
    ],
  },
  {
    label: 'Le Vieil Annecy',
    companyName: 'Le Vieil Annecy',
    city: 'Annecy',
    expected: 'presence_only',
    notes: 'Fiche sur le site institutionnel annecy-ville.fr.',
    urlsCollected: [
      'https://www.annecy-ville.fr/activites/le-vieil-annecy',
      'https://www.tourisme-annecy.net/hebergements/le-vieil-annecy',
      'https://www.google.com/maps/place/Le+Vieil+Annecy',
      'https://www.booking.com/hotel/fr/le-vieil-annecy',
      'https://www.facebook.com/levieilannecy',
      'https://www.savoie-mont-blanc.com/hebergement/le-vieil-annecy',
      'https://www.tripadvisor.fr/Hotel_Review-le-vieil-annecy',
    ],
  },
];

function classifierConfigFromEnv(): AppConfig {
  return {
    STRATE_RADAR_SIMULATION: false,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GROQ_MODEL: process.env.GROQ_MODEL?.trim() || DEFAULT_SERP_CLASSIFIER_MODEL,
    GROQ_PREFLIGHT_TIMEOUT_MS: Number(process.env.GROQ_PREFLIGHT_TIMEOUT_MS ?? 15_000),
  } as AppConfig;
}

function hr(char = '═', width = 78): string {
  return char.repeat(width);
}

function indentBlock(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function maskApiKey(key: string | undefined): string {
  const trimmed = key?.trim();
  if (!trimmed) return '(absente)';
  if (trimmed.length <= 8) return '***';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)} (${trimmed.length} car.)`;
}

function describeUrl(raw: string, index: number): string {
  const abs = toAbsoluteHttpUrl(raw);
  const normalized = abs ? normalizeProspectUrl(abs) : null;
  let hostname = '—';
  try {
    if (abs) hostname = new URL(abs).hostname.replace(/^www\./i, '');
  } catch {
    /* ignore */
  }
  return [
    `  [${index}] ${raw}`,
    `       absolu     : ${abs ?? 'INVALIDE'}`,
    `       hostname   : ${hostname}`,
    `       normalisé  : ${normalized ?? '—'}`,
  ].join('\n');
}

function printCaseHeader(index: number, testCase: CeoDryRunCase): void {
  console.log('');
  console.log(hr());
  console.log(` CAS ${index + 1}/${CASES.length} · ${testCase.label}`);
  console.log(hr());
}

function printInputs(testCase: CeoDryRunCase, trace: SerpClassifierDetailedResult['trace']): void {
  console.log('');
  console.log('▸ ENTREES');
  console.log(`  commerce        : ${testCase.companyName}`);
  console.log(`  ville           : ${testCase.city}`);
  console.log(`  statut attendu  : ${testCase.expected}`);
  if (testCase.notes) {
    console.log(`  note scénario   : ${testCase.notes}`);
  }
  console.log('');
  console.log(
    `▸ URLs COLLECTÉES (cascade simulée · ${trace.urlsInput.length} brutes · max ${trace.maxUrls} envoyées au LLM)`,
  );
  for (let i = 0; i < trace.urlsInput.length; i += 1) {
    const sent = i < trace.urlsSent.length;
    const marker = sent ? '→ LLM' : '⊘ coupée';
    console.log(describeUrl(trace.urlsInput[i]!, i + 1));
    console.log(`       statut     : ${marker}`);
  }
  if (trace.urlsDropped.length > 0) {
    console.log('');
    console.log(`▸ URLs NON ENVOYÉES (au-delà de ${trace.maxUrls})`);
    for (let i = 0; i < trace.urlsDropped.length; i += 1) {
      console.log(`  [${trace.urlsSent.length + i + 1}] ${trace.urlsDropped[i]}`);
    }
  }
}

function printGroqConfig(config: AppConfig, trace: SerpClassifierDetailedResult['trace']): void {
  console.log('');
  console.log('▸ APPEL GROQ');
  console.log(`  modèle          : ${trace.model}`);
  console.log(`  timeout         : ${trace.timeoutMs} ms`);
  console.log(`  temperature     : ${trace.temperature}`);
  console.log(`  response_format : json_object`);
  console.log(`  GROQ_API_KEY    : ${maskApiKey(config.GROQ_API_KEY)}`);
}

function printPrompts(trace: SerpClassifierDetailedResult['trace']): void {
  console.log('');
  console.log('▸ PROMPT SYSTEM');
  console.log(indentBlock(trace.systemPrompt));
  console.log('');
  console.log('▸ PROMPT USER (exactement ce qui part à Groq)');
  console.log(indentBlock(trace.userPrompt));
}

function printResponse(detailed: SerpClassifierDetailedResult): void {
  const { result, trace } = detailed;
  console.log('');
  console.log('▸ RÉPONSE BRUTE GROQ');
  console.log(indentBlock(trace.rawResponse || '(vide)'));
  console.log('');
  console.log('▸ JSON VALIDÉ (Zod · serpClassificationSchema)');
  console.log(`  status          : ${result.status}`);
  console.log(`  confidence      : ${result.confidence}`);
  console.log(`  reason          : ${result.reason}`);
  console.log('');
  console.log('▸ POST-TRAITEMENT RADAR');
  console.log(`  matchedUrl      : ${result.matchedUrl ?? '—'}`);
  console.log(
    `  extractMatched  : ${extractMatchedUrl(result.reason, trace.urlsSent) ?? '—'} (depuis reason)`,
  );
  console.log(
    `  presencePlatform: ${presencePlatformFromUrl(result.matchedUrl) ?? '—'} (si presence_only)`,
  );
  console.log('');
  console.log('▸ PERF');
  console.log(`  latence         : ${trace.latencyMs} ms`);
  console.log(`  tokens prompt   : ${trace.usage.promptTokens ?? '—'}`);
  console.log(`  tokens complét. : ${trace.usage.completionTokens ?? '—'}`);
  console.log(`  tokens total    : ${trace.usage.totalTokens ?? '—'}`);
}

function printVerdict(testCase: CeoDryRunCase, detailed: SerpClassifierDetailedResult): boolean {
  const ok = detailed.result.status === testCase.expected;
  console.log('');
  console.log('▸ VERDICT');
  console.log(
    `  ${ok ? '✓ PASS' : '✗ FAIL'} · attendu=${testCase.expected} · obtenu=${detailed.result.status}`,
  );
  if (!ok) {
    console.log(`  écart           : le classifieur a renvoyé "${detailed.result.status}" au lieu de "${testCase.expected}"`);
  }
  console.log(hr('─'));
  return ok;
}

async function main(): Promise<void> {
  const config = classifierConfigFromEnv();
  if (!config.GROQ_API_KEY?.trim()) {
    console.error('GROQ_API_KEY absente — impossible de lancer le dry-run live.');
    process.exit(1);
  }

  console.log(hr());
  console.log(' SERP CLASSIFIER · DRY-RUN VERBOSE · 3 CAS CEO');
  console.log(hr());
  console.log(` modèle Groq : ${config.GROQ_MODEL ?? DEFAULT_SERP_CLASSIFIER_MODEL}`);
  console.log(` timeout     : ${config.GROQ_PREFLIGHT_TIMEOUT_MS} ms`);
  console.log(` clé Groq    : ${maskApiKey(config.GROQ_API_KEY)}`);

  let failures = 0;
  for (let i = 0; i < CASES.length; i += 1) {
    const testCase = CASES[i]!;
    printCaseHeader(i, testCase);

    const detailed = await classifySerpUrlsDetailed({
      config,
      companyName: testCase.companyName,
      city: testCase.city,
      urls: [...testCase.urlsCollected],
    });

    printInputs(testCase, detailed.trace);
    printGroqConfig(config, detailed.trace);
    printPrompts(detailed.trace);
    printResponse(detailed);
    if (!printVerdict(testCase, detailed)) failures += 1;
  }

  console.log('');
  console.log(hr());
  if (failures > 0) {
    console.log(` RÉSULTAT · ${CASES.length - failures}/${CASES.length} PASS · ${failures} échec(s)`);
    console.log(hr());
    process.exit(1);
  }
  console.log(` RÉSULTAT · ${CASES.length}/${CASES.length} cas CEO validés`);
  console.log(hr());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
