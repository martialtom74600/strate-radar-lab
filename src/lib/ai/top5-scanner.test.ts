import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import '../../config/index.js';
import type { AppConfig } from '../../config/index.js';
import type { JinaReaderFetchResult } from './jina-reader.js';
import {
  buildTop5ScannerUserPrompt,
  prepareTop5ScannerCandidates,
  scanTop5CandidatesDetailed,
  TOP5_SCANNER_SYSTEM_PROMPT,
} from './top5-scanner.js';
import { RateLimitError } from 'groq-sdk';

const baseConfig = {
  STRATE_RADAR_SIMULATION: false,
  GROQ_API_KEY: 'test-key',
  GROQ_MODEL: 'llama-3.3-70b-versatile',
  GROQ_PREFLIGHT_TIMEOUT_MS: 5_000,
  RADAR_TOP5_GROQ_TIMEOUT_MS: 20_000,
  RADAR_JINA_TIMEOUT_MS: 12_000,
  RADAR_JINA_MAX_MARKDOWN_CHARS: 12_000,
} as AppConfig;

function mockJina(markdown: string) {
  return async (): Promise<JinaReaderFetchResult> => ({
    ok: true,
    markdown,
    latencyMs: 10,
  });
}

function mockGroq(official: boolean, reason: string) {
  return async () => ({
    parsed: { official, confidence: official ? 0.92 : 0.85, reason },
    rawResponse: JSON.stringify({ official, confidence: 0.92, reason }),
    latencyMs: 50,
    model: 'mock',
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
  });
}

describe('prepareTop5ScannerCandidates', () => {
  it('priorise Maps/Details puis filtre les plateformes', () => {
    const prep = prepareTop5ScannerCandidates({
      priorityUrls: ['https://www.annecy-mobilites.fr'],
      urlsCollected: [
        'https://www.annecy-mobilites.fr',
        'https://www.facebook.com/foo',
        'https://www.pappers.fr/bar',
        'https://o-poil-toilettage.fr',
      ],
    });
    assert.deepEqual(prep.candidates, [
      'https://www.annecy-mobilites.fr',
      'https://o-poil-toilettage.fr',
    ]);
    assert.equal(prep.platformUrls.length, 2);
  });

  it('Ma chouette boutique — petitfute seul → aucun candidat dédié', () => {
    const prep = prepareTop5ScannerCandidates({
      priorityUrls: [],
      urlsCollected: [
        'https://www.petitfute.com/ma-chouette-boutique',
        'https://www.instagram.com/ma_chouette_boutique_',
      ],
    });
    assert.equal(prep.candidates.length, 0);
    assert.equal(prep.platformUrls.length, 2);
  });

  it('limite à 5 candidats dédiés', () => {
    const prep = prepareTop5ScannerCandidates({
      priorityUrls: [],
      urlsCollected: [
        'https://a.example.fr',
        'https://b.example.fr',
        'https://c.example.fr',
        'https://d.example.fr',
        'https://e.example.fr',
        'https://f.example.fr',
      ],
    });
    assert.equal(prep.candidates.length, 5);
    assert.ok(prep.droppedUrls.includes('https://f.example.fr'));
  });
});

describe('TOP5_SCANNER_SYSTEM_PROMPT', () => {
  it('couvre official true/false et annuaires', () => {
    assert.match(TOP5_SCANNER_SYSTEM_PROMPT, /official/i);
    assert.match(TOP5_SCANNER_SYSTEM_PROMPT, /annuaire/i);
  });
});

describe('buildTop5ScannerUserPrompt', () => {
  it('inclut commerce, ville, URL et markdown', () => {
    const prompt = buildTop5ScannerUserPrompt({
      companyName: 'Funny Dog',
      city: 'Annecy',
      url: 'https://o-poil-toilettage.fr',
      markdown: '# Toilettage canin',
    });
    assert.match(prompt, /Funny Dog/);
    assert.match(prompt, /o-poil-toilettage\.fr/);
    assert.match(prompt, /Toilettage canin/);
  });

  it('injecte les hints structurels pour Groq', () => {
    const prompt = buildTop5ScannerUserPrompt({
      companyName: 'Annecy Assistance Depannage SARL',
      city: 'Annecy',
      url: 'https://www.annecy-mobilites.fr/contact',
      markdown: '# Contact',
      structuralHints: '- URL page d\'accueil (/) : non',
    });
    assert.match(prompt, /Indices structurels/);
    assert.match(prompt, /page d'accueil/);
  });
});

describe('scanTop5CandidatesDetailed', () => {
  it('presence_only si seulement plateformes (Ma chouette boutique)', async () => {
    const detailed = await scanTop5CandidatesDetailed({
      config: baseConfig,
      companyName: 'Ma chouette boutique',
      city: 'Annecy',
      priorityUrls: [],
      urlsCollected: [
        'https://www.petitfute.com/ma-chouette-boutique',
        'https://www.instagram.com/ma_chouette_boutique_',
      ],
      discovery: { attempted: true, ok: true, hits: 4, error: null },
    });
    assert.equal(detailed.result.status, 'presence_only');
    assert.match(detailed.result.reason, /plateforme/i);
  });

  it('needs_review si plateformes seules mais recherche web en échec', async () => {
    const detailed = await scanTop5CandidatesDetailed({
      config: baseConfig,
      companyName: 'Annecy Assistance Depannage SARL',
      city: 'Annecy',
      priorityUrls: [],
      urlsCollected: ['http://annecyassistancedepannage.site-solocal.com/'],
      discovery: {
        attempted: true,
        ok: false,
        hits: 0,
        error: 'HTTP 422 · ErrorResponse',
      },
    });
    assert.equal(detailed.result.status, 'needs_review');
    assert.match(detailed.result.reason, /quarantaine/i);
  });

  it('corporate_parent sans Jina sur réseau connu', async () => {
    let jinaCalled = false;
    const detailed = await scanTop5CandidatesDetailed({
      config: baseConfig,
      companyName: 'Agence Fiducial',
      city: 'Annecy',
      priorityUrls: [],
      urlsCollected: ['https://agences.fiducial.fr/annecy'],
      deps: {
        fetchPage: async () => {
          jinaCalled = true;
          return { ok: true, markdown: 'x', latencyMs: 1 };
        },
      },
    });
    assert.equal(detailed.result.status, 'corporate_parent');
    assert.equal(jinaCalled, false);
  });

  it('Annecy Assistance homepage — Groq tranche (pas voie rapide, domaines différents)', async () => {
    let groqCalls = 0;
    let jinaCalls = 0;

    const detailed = await scanTop5CandidatesDetailed({
      config: baseConfig,
      companyName: 'Annecy Assistance Depannage SARL',
      city: 'Annecy',
      priorityUrls: ['https://www.annecy-mobilites.fr'],
      urlsCollected: [
        'https://www.pappers.fr/foo',
        'https://www.annecy-mobilites.fr',
      ],
      deps: {
        fetchPage: async () => {
          jinaCalls += 1;
          return {
            ok: true,
            markdown: `# Annecy Assistance Dépannage\nRemorquage à Annecy`,
            latencyMs: 10,
          };
        },
        askOfficialSite: async () => {
          groqCalls += 1;
          return mockGroq(true, 'Site indépendant Annecy Mobilités.')();
        },
      },
    });

    assert.equal(detailed.result.status, 'owner_site');
    assert.equal(detailed.result.matchedUrl, 'https://www.annecy-mobilites.fr');
    assert.equal(jinaCalls, 1);
    assert.equal(groqCalls, 1);
    assert.match(detailed.result.reason ?? '', /top5-scanner/i);
  });

  it("L'Arbre à Fées — voie rapide sur arbreafees.fr (inclusion normalisée)", async () => {
    let groqCalls = 0;

    const detailed = await scanTop5CandidatesDetailed({
      config: baseConfig,
      companyName: "L'Arbre à Fées - Artisan Fleuriste Salon De Thé Naturel",
      city: 'Sevrier',
      priorityUrls: ['https://www.arbreafees.fr/'],
      urlsCollected: ['https://www.arbreafees.fr/'],
      deps: {
        fetchPage: mockJina(`# L'Arbre à Fées\nSalon de thé et fleuriste à Sevrier`),
        askOfficialSite: async () => {
          groqCalls += 1;
          return mockGroq(true, 'Site officiel indépendant.')();
        },
      },
    });

    assert.equal(groqCalls, 0);
    assert.equal(detailed.result.status, 'owner_site');
    assert.match(detailed.result.reason ?? '', /structure/i);
    assert.equal(detailed.result.matchedUrl, 'https://www.arbreafees.fr/');
  });

  it('Annecy Assistance /contact — Groq tranche, pas de voie rapide', async () => {
    let groqCalls = 0;

    const detailed = await scanTop5CandidatesDetailed({
      config: baseConfig,
      companyName: 'Annecy Assistance Depannage SARL',
      city: 'Annecy',
      priorityUrls: [],
      urlsCollected: ['https://www.annecy-mobilites.fr/contact'],
      deps: {
        fetchPage: mockJina('# Contact\nAnnecy Assistance Dépannage à Annecy'),
        askOfficialSite: async () => {
          groqCalls += 1;
          return mockGroq(true, 'Page contact du site officiel Annecy Assistance.')();
        },
      },
    });

    assert.equal(groqCalls, 1);
    assert.equal(detailed.result.status, 'owner_site');
    assert.equal(detailed.result.matchedUrl, 'https://www.annecy-mobilites.fr/contact');
  });

  it('Funny dog — owner_site sur domaine dédié (priorisé avant blog)', async () => {
    let groqCalls = 0;

    const detailed = await scanTop5CandidatesDetailed({
      config: baseConfig,
      companyName: 'Funny Dog',
      city: 'Annecy',
      priorityUrls: [],
      urlsCollected: [
        'https://blog.example.fr/funny-dog',
        'https://o-poil-toilettage.fr',
      ],
      deps: {
        fetchPage: mockJina('# contenu'),
        askOfficialSite: async (args) => {
          groqCalls += 1;
          const official = args.url.includes('o-poil-toilettage.fr');
          return mockGroq(official, official ? 'Site toilettage.' : 'Blog tiers.')();
        },
      },
    });

    assert.equal(detailed.result.status, 'owner_site');
    assert.equal(detailed.result.matchedUrl, 'https://o-poil-toilettage.fr');
    assert.ok(groqCalls >= 1);
  });

  it('needs_review si Jina échoue sur tous les candidats', async () => {
    const detailed = await scanTop5CandidatesDetailed({
      config: baseConfig,
      companyName: 'Funny Dog',
      city: 'Annecy',
      priorityUrls: [],
      urlsCollected: ['https://o-poil-toilettage.fr'],
      deps: {
        fetchPage: async () => ({
          ok: false,
          error: 'Jina HTTP 503',
          latencyMs: 5,
        }),
      },
    });
    assert.equal(detailed.result.status, 'needs_review');
    assert.match(detailed.result.reason, /Jina/i);
  });

  it('needs_review si Groq quota journalier (TPD, sans retry)', async () => {
    let calls = 0;
    const detailed = await scanTop5CandidatesDetailed({
      config: baseConfig,
      companyName: 'Test',
      city: 'Annecy',
      priorityUrls: [],
      urlsCollected: ['https://example.fr'],
      discovery: { attempted: true, ok: true, hits: 2, error: null },
      deps: {
        fetchPage: mockJina('# page annuaire'),
        askOfficialSite: async () => {
          calls += 1;
          throw new Error('429 tokens per day (TPD)');
        },
      },
    });
    assert.equal(calls, 1);
    assert.equal(detailed.result.status, 'needs_review');
    assert.match(detailed.result.reason, /TPD/i);
  });

  it('retry TPM puis classifie (pas de quarantaine technique)', async () => {
    let calls = 0;
    const detailed = await scanTop5CandidatesDetailed({
      config: baseConfig,
      companyName: 'Test',
      city: 'Annecy',
      priorityUrls: [],
      urlsCollected: ['https://annuaire.example.fr/fiche'],
      discovery: { attempted: true, ok: true, hits: 2, error: null },
      deps: {
        fetchPage: mockJina('# Annuaire\nFiche établissement sur annuaire.example.fr'),
        askOfficialSite: async () => {
          calls += 1;
          if (calls < 3) {
            throw new RateLimitError(429, undefined, 'tokens per minute (TPM)', {
              'retry-after': '0',
            });
          }
          return mockGroq(false, 'Fiche annuaire, pas un site propriétaire.')();
        },
      },
    });
    assert.equal(calls, 3);
    assert.equal(detailed.result.status, 'presence_only');
  });

  it('presence_only si Groq FALSE sur annuaire vertical (fleuristes-et-fleurs)', async () => {
    const detailed = await scanTop5CandidatesDetailed({
      config: baseConfig,
      companyName: 'Test Fleuriste',
      city: 'Annecy',
      priorityUrls: [],
      urlsCollected: ['https://fleuristes-et-fleurs.com/boutique'],
      discovery: { attempted: true, ok: true, hits: 3, error: null },
      deps: {
        fetchPage: mockJina(
          '# Fleuristes et Fleurs\nAnnuaire national — fiche établissement référencée sur fleuristes-et-fleurs.com',
        ),
        askOfficialSite: mockGroq(false, 'Annuaire vertical listant plusieurs commerces, pas un site propre.'),
      },
    });
    assert.equal(detailed.result.status, 'presence_only');
  });

  it('corporate_parent si plusieurs fiches magasin sur le même domaine parent (réseau)', async () => {
    const detailed = await scanTop5CandidatesDetailed({
      config: baseConfig,
      companyName: 'Carrefour City',
      city: 'Annecy',
      priorityUrls: [],
      urlsCollected: [
        'https://www.carrefour.fr/magasin/annecy-centre',
        'https://www.carrefour.fr/magasin/annecy-nord',
        'https://www.mappy.com/poi/carrefour-city-annecy',
      ],
      discovery: { attempted: true, ok: true, hits: 5, error: null },
      deps: {
        fetchPage: mockJina('# Carrefour City Annecy\nFiche magasin sur carrefour.fr'),
        askOfficialSite: async (args) => {
          if (args.url.includes('carrefour.fr')) {
            return mockGroq(
              false,
              'Page magasin sur le réseau national Carrefour — pas un site indépendant.',
            )();
          }
          return mockGroq(false, 'Fiche Mappy, pas un site propriétaire.')();
        },
      },
    });
    assert.equal(detailed.result.status, 'corporate_parent');
    assert.match(detailed.result.matchedUrl ?? '', /carrefour\.fr/);
    assert.match(detailed.result.reason ?? '', /top5-scanner/i);
  });

  it('corporate_parent si Groq TRUE sur page locator du domaine parent (Hase)', async () => {
    const detailed = await scanTop5CandidatesDetailed({
      config: baseConfig,
      companyName: 'Hase Chauffage',
      city: 'Annecy',
      priorityUrls: [],
      urlsCollected: ['https://www.hase.fr/installateurs/delegues/annecy-chauffage'],
      discovery: { attempted: true, ok: true, hits: 3, error: null },
      deps: {
        fetchPage: mockJina('# Hase Chauffage Annecy\nInstallateur délégué Hase à Annecy'),
        askOfficialSite: mockGroq(
          true,
          'Page installateur sur le site du réseau Hase — site officiel de la marque.',
        ),
      },
    });
    assert.equal(detailed.result.status, 'corporate_parent');
    assert.match(detailed.result.matchedUrl ?? '', /hase\.fr/);
    assert.doesNotMatch(detailed.result.reason ?? '', /owner/i);
  });
});
