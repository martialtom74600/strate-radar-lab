import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import '../../config/index.js';
import type { AppConfig } from '../../config/index.js';
import { serpClassificationSchema } from './serp-classification-schema.js';
import {
  assessSerpClassificationCoherence,
  buildSerpClassifierUserPrompt,
  classifySerpUrls,
  classifySerpUrlsDetailed,
  DEFAULT_SERP_CLASSIFIER_MODEL,
  extractMatchedUrl,
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
  it('relève owner_site si domaine dédié ignoré par le LLM', () => {
    const coherence = assessSerpClassificationCoherence(
      {
        reason: 'Présence sur pappers.fr uniquement.',
        confidence: 0.8,
        status: 'presence_only',
      },
      ['https://www.pappers.fr/foo', 'https://www.annecy-mobilites.fr'],
    );
    assert.equal(coherence.coherent, false);
    assert.equal(coherence.fallback?.status, 'owner_site');
  });

  it('laisse passer presence_only sans domaine dédié', () => {
    const coherence = assessSerpClassificationCoherence(
      {
        reason: 'https://www.facebook.com/funny-dog/ — réseau social.',
        confidence: 1,
        status: 'presence_only',
      },
      ['https://www.facebook.com/funny-dog/', 'https://www.pagesjaunes.fr/pros/123'],
    );
    assert.equal(coherence.coherent, true);
  });
});

describe('classifySerpUrlsDetailed — structurel sans Groq', () => {
  const simConfig = {
    STRATE_RADAR_SIMULATION: true,
    GROQ_API_KEY: undefined,
    GROQ_PREFLIGHT_TIMEOUT_MS: 15_000,
  } as AppConfig;

  it('presence_only sans appel Groq (Facebook + PagesJaunes)', async () => {
    const detailed = await classifySerpUrlsDetailed({
      config: simConfig,
      companyName: 'Funny Dog',
      city: 'Annecy',
      urls: ['https://www.facebook.com/funny-dog/', 'https://www.pagesjaunes.fr/pros/123'],
    });
    assert.equal(detailed.result.status, 'presence_only');
    assert.equal(detailed.trace.llmSkipped, true);
    assert.equal(detailed.trace.model, 'structural');
  });

  it('owner_site en simulation si domaine dédié (Annecy Assistance)', async () => {
    const detailed = await classifySerpUrlsDetailed({
      config: simConfig,
      companyName: 'Annecy Assistance Depannage SARL',
      city: 'Annecy',
      urls: [
        'http://annecyassistancedepannage.site-solocal.com/',
        'https://www.annecy-mobilites.fr',
        'https://www.pappers.fr/entreprise/foo',
      ],
    });
    assert.equal(detailed.result.status, 'owner_site');
    assert.match(detailed.result.matchedUrl ?? '', /annecy-mobilites\.fr/i);
  });

  it('presence_only pour lacarte.menu sans Groq', async () => {
    const detailed = await classifySerpUrlsDetailed({
      config: simConfig,
      companyName: 'Le Balcon du Lac',
      city: 'Annecy',
      urls: ['https://lacarte.menu/le-balcon', 'https://www.tripadvisor.fr/foo'],
    });
    assert.equal(detailed.result.status, 'presence_only');
    assert.equal(detailed.trace.llmSkipped, true);
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
  it('inclut commerce, ville et URLs dédiées', () => {
    const prompt = buildSerpClassifierUserPrompt({
      companyName: 'Bijouterie LAMY',
      city: 'Annecy',
      urls: ['https://www.lamy-joaillerie.com/'],
      platformUrls: ['https://www.facebook.com/lamyannecy'],
    });
    assert.match(prompt, /Bijouterie LAMY/);
    assert.match(prompt, /lamy-joaillerie\.com/);
    assert.match(prompt, /facebook\.com/);
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
