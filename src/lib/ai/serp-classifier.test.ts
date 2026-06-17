import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import '../../config/index.js';
import type { AppConfig } from '../../config/index.js';
import { serpClassificationSchema } from './serp-classification-schema.js';
import {
  applyQuarantinePolicy,
  assessSerpClassificationCoherence,
  buildSerpClassifierUserPrompt,
  classifySerpUrls,
  classifySerpUrlsDetailed,
  DEFAULT_SERP_CLASSIFIER_MODEL,
  extractMatchedUrl,
  formatGroqRateLimitReason,
  parseGroqRetryAfterDelayMs,
  parseGroqRateLimitKind,
  SERP_CLASSIFIER_SYSTEM_PROMPT,
} from './serp-classifier.js';
import { RateLimitError } from 'groq-sdk';

describe('serpClassificationSchema', () => {
  it('accepte un objet valide (ordre CoT)', () => {
    const parsed = serpClassificationSchema.parse({
      reason: 'lamy-joaillerie.com est le domaine exclusif de la bijouterie LAMY.',
      confidence: 0.92,
      status: 'owner_site',
    });
    assert.equal(parsed.status, 'owner_site');
  });

  it('accepte corporate_parent', () => {
    const parsed = serpClassificationSchema.parse({
      reason: 'agences.fiducial.fr/annecy est une page succursale sur fiducial.fr.',
      confidence: 0.88,
      status: 'corporate_parent',
    });
    assert.equal(parsed.status, 'corporate_parent');
  });

  it('rejette un status inconnu', () => {
    assert.throws(() =>
      serpClassificationSchema.parse({
        reason: 'test',
        confidence: 0.5,
        status: 'directory',
      }),
    );
  });
});

describe('SERP_CLASSIFIER_SYSTEM_PROMPT', () => {
  it('couvre owner_site, corporate_parent et presence_only', () => {
    assert.match(SERP_CLASSIFIER_SYSTEM_PROMPT, /owner_site/i);
    assert.match(SERP_CLASSIFIER_SYSTEM_PROMPT, /corporate_parent/i);
    assert.match(SERP_CLASSIFIER_SYSTEM_PROMPT, /presence_only/i);
  });
});

describe('assessSerpClassificationCoherence', () => {
  it('relève owner_site si domaine dédié ignoré et raison cite une plateforme', () => {
    const coherence = assessSerpClassificationCoherence(
      {
        reason: 'Présence sur pappers.fr uniquement.',
        confidence: 0.8,
        status: 'presence_only',
        matchedUrl: null,
      },
      ['https://www.pappers.fr/foo', 'https://www.annecy-mobilites.fr'],
    );
    assert.equal(coherence.coherent, false);
    assert.equal(coherence.fallback?.status, 'owner_site');
  });

  it('laisse passer presence_only si le LLM cite un annuaire vertical', () => {
    const coherence = assessSerpClassificationCoherence(
      {
        reason: 'https://www.petitfute.com/ma-chouette-boutique — annuaire, pas de site propre.',
        confidence: 0.9,
        status: 'presence_only',
        matchedUrl: 'https://www.petitfute.com/ma-chouette-boutique',
      },
      [
        'https://www.petitfute.com/ma-chouette-boutique',
        'https://www.instagram.com/ma_chouette_boutique_',
      ],
    );
    assert.equal(coherence.coherent, true);
  });

  it('corrige owner_site sur plateforme Solocal', () => {
    const coherence = assessSerpClassificationCoherence(
      {
        reason: 'https://foo.site-solocal.com/ est le site du commerce.',
        confidence: 1,
        status: 'owner_site',
        matchedUrl: 'https://foo.site-solocal.com/',
      },
      ['https://foo.site-solocal.com/'],
    );
    assert.equal(coherence.coherent, false);
    assert.equal(coherence.fallback?.status, 'presence_only');
  });

  it('laisse passer presence_only sans domaine dédié', () => {
    const coherence = assessSerpClassificationCoherence(
      {
        reason: 'https://www.facebook.com/funny-dog/ — réseau social.',
        confidence: 1,
        status: 'presence_only',
        matchedUrl: 'https://www.facebook.com/funny-dog/',
      },
      ['https://www.facebook.com/funny-dog/', 'https://www.pagesjaunes.fr/pros/123'],
    );
    assert.equal(coherence.coherent, true);
  });
});

describe('classifySerpUrlsDetailed — sans Groq', () => {
  const simConfig = {
    STRATE_RADAR_SIMULATION: true,
    GROQ_API_KEY: undefined,
    GROQ_PREFLIGHT_TIMEOUT_MS: 15_000,
  } as AppConfig;

  it('rejette si Groq indisponible et URLs présentes', async () => {
    await assert.rejects(
      () =>
        classifySerpUrlsDetailed({
          config: simConfig,
          companyName: 'Funny Dog',
          city: 'Annecy',
          urls: ['https://www.facebook.com/funny-dog/'],
        }),
      (err: unknown) =>
        err instanceof Error && /GROQ_API_KEY absente|mode simulation/i.test(err.message),
    );
  });

  it('needs_review si bucket vide (quarantaine)', async () => {
    const detailed = await classifySerpUrlsDetailed({
      config: simConfig,
      companyName: 'Vide',
      city: 'Annecy',
      urls: [],
    });
    assert.equal(detailed.result.status, 'needs_review');
  });
});

describe('applyQuarantinePolicy', () => {
  it('convertit none en needs_review', () => {
    const out = applyQuarantinePolicy({
      status: 'none',
      confidence: 0,
      reason: 'Indécision LLM.',
    });
    assert.equal(out.status, 'needs_review');
    assert.match(out.reason, /quarantaine/i);
  });

  it('convertit confidence=0 en needs_review', () => {
    const out = applyQuarantinePolicy({
      status: 'presence_only',
      confidence: 0,
      reason: 'Hésitation.',
    });
    assert.equal(out.status, 'needs_review');
  });

  it('laisse passer owner_site avec confiance', () => {
    const out = applyQuarantinePolicy({
      status: 'owner_site',
      confidence: 0.95,
      reason: 'Site dédié.',
    });
    assert.equal(out.status, 'owner_site');
  });
});

describe('extractMatchedUrl', () => {
  it('retrouve le hostname cité dans la raison', () => {
    const url = extractMatchedUrl(
      'lacarte.menu est une plateforme de menu partagée.',
      ['https://lacarte.menu/le-balcon', 'https://example.com'],
    );
    assert.equal(url, 'https://lacarte.menu/le-balcon');
  });
});

describe('buildSerpClassifierUserPrompt', () => {
  it('inclut commerce, ville et URLs organiques', () => {
    const prompt = buildSerpClassifierUserPrompt({
      companyName: 'Bijouterie LAMY',
      city: 'Annecy',
      urls: ['https://www.lamy-joaillerie.com/', 'https://www.facebook.com/lamyannecy'],
    });
    assert.match(prompt, /Bijouterie LAMY/);
    assert.match(prompt, /lamy-joaillerie\.com/);
    assert.match(prompt, /URLs organiques/);
  });
});

describe('parseGroqRetryAfterDelayMs', () => {
  it('lit retry-after en secondes', () => {
    const err = new RateLimitError(429, undefined, 'rate limit', { 'retry-after': '12' });
    assert.equal(parseGroqRetryAfterDelayMs(err), 12_000);
  });
});

describe('parseGroqRateLimitKind', () => {
  it('détecte TPD', () => {
    const err = new Error('429 tokens per day (TPD)');
    assert.equal(parseGroqRateLimitKind(err), 'tpd');
  });
});

describe('formatGroqRateLimitReason', () => {
  it('inclut TPM et retry-after en secondes', () => {
    const err = new RateLimitError(429, undefined, 'tokens per minute (TPM)', {
      'retry-after': '45',
    });
    const reason = formatGroqRateLimitReason(err);
    assert.match(reason, /TPM \(tokens\/minute\)/);
    assert.match(reason, /réessayer dans ~45 s/);
    assert.match(reason, /\[quarantaine\]/);
  });

  it('inclut TPD sans retry-after', () => {
    const err = new Error('429 tokens per day (TPD)');
    const reason = formatGroqRateLimitReason(err);
    assert.match(reason, /TPD \(tokens\/jour\)/);
    assert.match(reason, /réessayer demain/);
  });

  it('accepte un contexte optionnel', () => {
    const err = new Error('429 requests per minute (RPM)');
    const reason = formatGroqRateLimitReason(err, 'après 3 tentatives');
    assert.match(reason, /RPM \(requêtes\/minute\)/);
    assert.match(reason, /après 3 tentatives/);
  });
});

const CEO_CASES = [
  {
    label: 'Bijouterie LAMY',
    companyName: 'Bijouterie LAMY',
    city: 'Annecy',
    urls: ['https://www.lamy-joaillerie.com/', 'https://www.facebook.com/lamyannecy'],
    expected: 'owner_site' as const,
  },
  {
    label: 'Le Balcon du Lac',
    companyName: 'Le Balcon du Lac',
    city: 'Annecy',
    urls: ['https://lacarte.menu/le-balcon-du-lac', 'https://www.tripadvisor.fr/Restaurant_Review'],
    expected: 'presence_only' as const,
  },
];

const runLiveGroq =
  process.env.GROQ_LIVE_TESTS === '1' && Boolean(process.env.GROQ_API_KEY?.trim());

function liveClassifierConfig(): AppConfig {
  return {
    STRATE_RADAR_SIMULATION: false,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GROQ_MODEL: process.env.GROQ_MODEL?.trim() || DEFAULT_SERP_CLASSIFIER_MODEL,
    GROQ_PREFLIGHT_TIMEOUT_MS: Number(process.env.GROQ_PREFLIGHT_TIMEOUT_MS ?? 15_000),
  } as AppConfig;
}

describe('classifySerpUrls — cas CEO (Groq live)', { skip: !runLiveGroq }, () => {
  for (const testCase of CEO_CASES) {
    it(`${testCase.label} → ${testCase.expected}`, async () => {
      const result = await classifySerpUrls({
        config: liveClassifierConfig(),
        companyName: testCase.companyName,
        city: testCase.city,
        urls: testCase.urls,
      });
      assert.equal(result.status, testCase.expected, `reason=${result.reason}`);
    });
  }
});
