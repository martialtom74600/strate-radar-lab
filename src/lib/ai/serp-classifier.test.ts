import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import '../../config/index.js';
import type { AppConfig } from '../../config/index.js';
import { serpClassificationSchema } from './serp-classification-schema.js';
import {
  assessSerpClassificationCoherence,
  buildSerpClassifierUserPrompt,
  classifySerpUrls,
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
    assert.equal(parsed.confidence, 0.92);
  });

  it('accepte corporate_parent', () => {
    const parsed = serpClassificationSchema.parse({
      reason: 'agences.fiducial.fr/annecy est une page succursale sur le domaine fiducial.fr.',
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
  it('exige le CoT et le format JSON sans markdown', () => {
    assert.match(SERP_CLASSIFIER_SYSTEM_PROMPT, /reason.*en premier/i);
    assert.match(SERP_CLASSIFIER_SYSTEM_PROMPT, /\{"reason":".*", "confidence":1\.0, "status":"\.\.\."\}/);
    assert.match(SERP_CLASSIFIER_SYSTEM_PROMPT, /sans aucun bloc de code markdown/i);
  });
});

describe('assessSerpClassificationCoherence', () => {
  it('détecte owner_site avec confidence=0 et raison presence_only (Ma chouette boutique)', () => {
    const coherence = assessSerpClassificationCoherence({
      reason:
        "Aucune URL ne correspond à owner_site. La règle 'presence_only' est la plus proche car https://www.instagram.com/ma_chouette_boutique_/ est un réseau social.",
      confidence: 0,
      status: 'owner_site',
    });
    assert.equal(coherence.coherent, false);
    assert.equal(coherence.fallback?.status, 'presence_only');
  });

  it('détecte owner_site contredit par annuaires/réseaux sociaux (Le Pas Sage)', () => {
    const coherence = assessSerpClassificationCoherence({
      reason:
        "Aucune URL pertinente pour confirmer owner_site. Présence sur des annuaires neutres ou réseaux sociaux (https://www.facebook.com/profile.php?id=100085295809924, https://www.pagesjaunes.fr/pros/58427535).",
      confidence: 0,
      status: 'owner_site',
    });
    assert.equal(coherence.coherent, false);
    assert.ok(
      coherence.fallback?.status === 'presence_only' || coherence.fallback?.status === 'none',
    );
  });

  it('laisse passer une classification cohérente', () => {
    const coherence = assessSerpClassificationCoherence({
      reason:
        "L'URL https://www.pagesjaunes.fr/pros/53558464 montre une présence sur annuaire neutre, correspond à presence_only.",
      confidence: 1,
      status: 'presence_only',
    });
    assert.equal(coherence.coherent, true);
    assert.equal(coherence.fallback, null);
  });

  it('ignore corporate_parent mentionné en exclusion (Funny dog)', () => {
    const coherence = assessSerpClassificationCoherence({
      reason:
        "L'URL https://www.pagesjaunes.fr/pros/00823321 montre une présence sur annuaire neutre. Aucune URL ne suggère corporate_parent ni owner_site.",
      confidence: 1,
      status: 'presence_only',
    });
    assert.equal(coherence.coherent, true);
  });

  it('corrige none quand la raison décrit une présence tierce (Le Paradis de Talie)', () => {
    const coherence = assessSerpClassificationCoherence({
      reason:
        'Le commerce est listé sur https://www.pagesjaunes.fr/pros/52690542 et facebook.com. Aucune URL ne correspond à un site web propriétaire indépendant.',
      confidence: 1,
      status: 'none',
    });
    assert.equal(coherence.coherent, false);
    assert.equal(coherence.fallback?.status, 'presence_only');
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

describe('parseGroqRateLimitKind', () => {
  it('détecte le quota journalier TPD', () => {
    const err = new Error(
      '429 {"error":{"message":"Rate limit reached for model `llama-3.3-70b-versatile` on tokens per day (TPD): Limit 100000, Used 99900"}}',
    );
    assert.equal(parseGroqRateLimitKind(err), 'tpd');
  });

  it('détecte le quota minute TPM', () => {
    const err = new Error('429 rate limit on tokens per minute (TPM)');
    assert.equal(parseGroqRateLimitKind(err), 'tpm');
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
