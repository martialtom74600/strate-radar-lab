import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StrateRadarError } from '../../lib/errors.js';
import {
  createSerpManagerFromClients,
  describeSerpBoot,
  isSerpQuotasExhaustedError,
  SERP_QUOTAS_EXHAUSTED_CODE,
} from './serp-manager.js';
import { isWebSearchQuotaError } from './web-search.types.js';
import type { WebSearchClient, WebSearchResult } from './web-search.types.js';

function mockClient(
  impl: (q: string) => Promise<WebSearchResult>,
): WebSearchClient {
  return { searchWeb: impl };
}

describe('isWebSearchQuotaError', () => {
  it('détecte 402, 403 et 429', () => {
    assert.equal(isWebSearchQuotaError({ httpStatus: 402, reason: 'serper', message: 'payment' }), true);
    assert.equal(isWebSearchQuotaError({ httpStatus: 403, reason: 'serper', message: 'forbidden' }), true);
    assert.equal(isWebSearchQuotaError({ httpStatus: 429, reason: 'brave', message: 'rate limit' }), true);
    assert.equal(isWebSearchQuotaError({ httpStatus: 500, reason: 'serper', message: 'error' }), false);
  });
});

describe('createSerpManagerFromClients', () => {
  it('retourne les hits Serper sans appeler Brave', async () => {
    let braveCalls = 0;
    const manager = createSerpManagerFromClients(
      mockClient(async () => ({
        hits: [{ title: 'Site', link: 'https://example.com' }],
        error: null,
      })),
      mockClient(async () => {
        braveCalls += 1;
        return { hits: [], error: null };
      }),
    );
    assert.ok(manager);
    const result = await manager!.searchWeb('test query');
    assert.equal(result.hits.length, 1);
    assert.equal(braveCalls, 0);
  });

  it('fallback Brave quand Serper quota (429)', async () => {
    let braveCalls = 0;
    const manager = createSerpManagerFromClients(
      mockClient(async () => ({
        hits: [],
        error: { httpStatus: 429, reason: 'serper', message: 'quota exceeded' },
      })),
      mockClient(async () => {
        braveCalls += 1;
        return { hits: [{ title: 'Brave hit', link: 'https://brave.example' }], error: null };
      }),
    );
    const result = await manager!.searchWeb('test');
    assert.equal(braveCalls, 1);
    assert.equal(result.hits[0]?.link, 'https://brave.example');
  });

  it('ne fallback pas sur erreur non-quota Serper', async () => {
    let braveCalls = 0;
    const manager = createSerpManagerFromClients(
      mockClient(async () => ({
        hits: [],
        error: { httpStatus: 500, reason: 'serper', message: 'internal error' },
      })),
      mockClient(async () => {
        braveCalls += 1;
        return { hits: [], error: null };
      }),
    );
    const result = await manager!.searchWeb('test');
    assert.equal(braveCalls, 0);
    assert.equal(result.error?.httpStatus, 500);
  });

  it('accepte 200 Serper avec hits vides (pas de fallback)', async () => {
    let braveCalls = 0;
    const manager = createSerpManagerFromClients(
      mockClient(async () => ({ hits: [], error: null })),
      mockClient(async () => {
        braveCalls += 1;
        return { hits: [], error: null };
      }),
    );
    await manager!.searchWeb('test');
    assert.equal(braveCalls, 0);
  });

  it('kill switch SERP_QUOTAS_EXHAUSTED si Serper et Brave quotas morts', async () => {
    const manager = createSerpManagerFromClients(
      mockClient(async () => ({
        hits: [],
        error: { httpStatus: 403, reason: 'serper', message: 'forbidden' },
      })),
      mockClient(async () => ({
        hits: [],
        error: { httpStatus: 429, reason: 'brave', message: 'rate limit' },
      })),
    );
    await assert.rejects(
      () => manager!.searchWeb('test'),
      (err: unknown) => {
        assert.ok(isSerpQuotasExhaustedError(err));
        assert.ok(err instanceof StrateRadarError);
        assert.equal(err.code, SERP_QUOTAS_EXHAUSTED_CODE);
        return true;
      },
    );
  });

  it('kill switch si Serper quota et pas de client Brave', async () => {
    const manager = createSerpManagerFromClients(
      mockClient(async () => ({
        hits: [],
        error: { httpStatus: 402, reason: 'serper', message: 'payment required' },
      })),
      null,
    );
    await assert.rejects(() => manager!.searchWeb('test'), isSerpQuotasExhaustedError);
  });

  it('utilise Brave seul si Serper absent', async () => {
    const manager = createSerpManagerFromClients(
      null,
      mockClient(async () => ({
        hits: [{ title: 'Only Brave', link: 'https://only-brave.test' }],
        error: null,
      })),
    );
    const result = await manager!.searchWeb('test');
    assert.equal(result.hits[0]?.title, 'Only Brave');
  });
});

describe('describeSerpBoot', () => {
  it('signale inactif sans clé Serper ni Brave', () => {
    const boot = describeSerpBoot({
      SERPER_API_KEY: undefined,
      BRAVE_SEARCH_API_KEY: undefined,
      RADAR_WEB_SEARCH_ENABLED: true,
      RADAR_MAX_WEB_SEARCH_REQUESTS_PER_RUN: 120,
    });
    assert.equal(boot.configured, false);
    assert.match(boot.statusLine, /absentes/);
  });

  it('signale actif avec Serper seul', () => {
    const boot = describeSerpBoot({
      SERPER_API_KEY: 'sk-test-key',
      BRAVE_SEARCH_API_KEY: undefined,
      RADAR_WEB_SEARCH_ENABLED: true,
      RADAR_MAX_WEB_SEARCH_REQUESTS_PER_RUN: 50,
    });
    assert.equal(boot.configured, true);
    assert.match(boot.statusLine, /Serper/);
  });
});
