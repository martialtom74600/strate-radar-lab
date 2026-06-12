import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import '../../config/index.js';
import type { AppConfig } from '../../config/index.js';
import { serpClassificationSchema } from './serp-classification-schema.js';
import {
  buildSerpClassifierUserPrompt,
  classifySerpUrls,
  DEFAULT_SERP_CLASSIFIER_MODEL,
  extractMatchedUrl,
  parseGroqRetryAfterDelayMs,
} from './serp-classifier.js';
import { RateLimitError } from 'groq-sdk';

describe('serpClassificationSchema', () => {
  it('accepte un objet valide', () => {
    const parsed = serpClassificationSchema.parse({
      status: 'owner_site',
      confidence: 0.92,
      reason: 'lamy-joaillerie.com est le domaine exclusif de la bijouterie LAMY.',
    });
    assert.equal(parsed.status, 'owner_site');
    assert.equal(parsed.confidence, 0.92);
  });

  it('rejette un status inconnu', () => {
    assert.throws(() =>
      serpClassificationSchema.parse({
        status: 'directory',
        confidence: 0.5,
        reason: 'test',
      }),
    );
  });
});

describe('extractMatchedUrl', () => {
  it('retrouve le hostname cité dans la raison', () => {
    const url = extractMatchedUrl(
      'lacarte.menu est une plateforme de menu partagée, pas un site propriétaire.',
      ['https://lacarte.menu/le-balcon', 'https://example.com'],
    );
    assert.equal(url, 'https://lacarte.menu/le-balcon');
  });

  it('ne retombe pas sur la première URL si la raison est vague', () => {
    const url = extractMatchedUrl('Présence tierce détectée sans URL citée.', [
      'https://lacarte.menu/le-balcon',
      'https://example.com',
    ]);
    assert.equal(url, null);
  });
});

describe('buildSerpClassifierUserPrompt', () => {
  it('inclut commerce, ville et URLs numérotées', () => {
    const prompt = buildSerpClassifierUserPrompt({
      companyName: 'Bijouterie LAMY',
      city: 'Annecy',
      urls: ['https://www.lamy-joaillerie.com/'],
    });
    assert.match(prompt, /Bijouterie LAMY/);
    assert.match(prompt, /Annecy/);
    assert.match(prompt, /lamy-joaillerie\.com/);
  });
});

describe('parseGroqRetryAfterDelayMs', () => {
  it('lit retry-after en secondes', () => {
    const err = new RateLimitError(429, undefined, 'rate limit', { 'retry-after': '12' });
    assert.equal(parseGroqRetryAfterDelayMs(err), 12_000);
  });

  it('lit retry-after-ms en priorité', () => {
    const err = new RateLimitError(429, undefined, 'rate limit', {
      'retry-after': '12',
      'retry-after-ms': '1500',
    });
    assert.equal(parseGroqRetryAfterDelayMs(err), 1500);
  });

  it('retourne null si header absent', () => {
    assert.equal(parseGroqRetryAfterDelayMs(new Error('429')), null);
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
  {
    label: 'Le Vieil Annecy',
    companyName: 'Le Vieil Annecy',
    city: 'Annecy',
    urls: ['https://www.annecy-ville.fr/activites/le-vieil-annecy', 'https://www.google.com/maps'],
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
      assert.equal(
        result.status,
        testCase.expected,
        `reason=${result.reason} · matched=${result.matchedUrl ?? '—'}`,
      );
      assert.ok(result.confidence >= 0.5 && result.confidence <= 1);
      assert.ok(result.reason.length > 10);
    });
  }
});
