import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildTelegramReportSections,
  flattenTelegramMessages,
} from './telegram-notify.js';
import type { RunTelemetryPayload } from './run-telemetry.js';

function baseTelemetry(
  overrides: Partial<RunTelemetryPayload> = {},
): RunTelemetryPayload {
  return {
    lastRunIso: '2026-06-18T02:03:00.000Z',
    workflow: 'github-actions',
    campaign: null,
    diamondsFound: 2,
    creationsFound: 2,
    refontesFound: 0,
    targetCreationCount: 5,
    targetRefonteCount: 0,
    totalBusinessesScanned: 47,
    placesRequestsUsed: 52,
    placesRequestsMax: 120,
    webSearchRequestsUsed: 38,
    webSearchRequestsMax: 120,
    webSearchConfigured: true,
    webSearchBootStatus:
      'actif · Serper (40 car.) → Brave fallback (31 car.) · plafond 120 req/run',
    placesStoppedEarly: false,
    placesStopMessage: null,
    placesBudgetExhausted: false,
    serpQuotasExhausted: false,
    serpStopMessage: null,
    searchLocation: 'Annecy, France',
    searchQuery: 'Creation Hunt',
    weekBucket: '2026-W25',
    demandDrivenMode: false,
    multiCategoryMode: false,
    seedCategories: [],
    trendQueries: ['plombier Annecy'],
    gatekeeperExclusionCount: 3,
    gatekeeperExclusions: [{ name: 'Test', reason: 'chain' }],
    webSearchIssues: [{ name: 'Foo', note: 'HTTP 429' }],
    ingest: {
      configured: true,
      successCount: 2,
      failureCount: 0,
      skippedRefonteCount: 0,
      failures: [],
      successes: [
        {
          name: 'Nails.ByTaïss',
          publicUrl: 'https://www.strate-studio.fr/audit/nails-bytaiss',
        },
        {
          name: 'Gaulthier Sanitaire',
          publicUrl: 'https://www.strate-studio.fr/audit/gaulthier-sanitaire',
        },
      ],
    },
    leads: [
      {
        name: 'Nails.ByTaïss',
        badge: 'DIAMANT_PRESENCE',
        displayUrl: 'https://booksy.com/...',
        webStatus: 'presence_only',
        presencePlatform: 'booksy.com',
        webSource: 'web_search',
        strateScore: null,
        publicAuditUrl: 'https://www.strate-studio.fr/audit/nails-bytaiss',
        trendingQuery: 'institut ongles Annecy',
      },
      {
        name: 'Gaulthier Sanitaire',
        badge: 'DIAMANT_CREATION',
        displayUrl: null,
        webStatus: 'none',
        presencePlatform: null,
        webSource: null,
        strateScore: null,
        publicAuditUrl: 'https://www.strate-studio.fr/audit/gaulthier-sanitaire',
        trendingQuery: 'plombier Annecy',
      },
    ],
    warnings: [
      'Creation Hunt : 2/5 après anneau 1 — zones : Annecy.',
      '3 fiche(s) écartée(s) par le Gatekeeper.',
      '8 fiche(s) sous seuil refonte (5 plus proches du seuil ci-dessous · +3 dans rapport_matinal.md).',
    ],
    errors: [],
    targetedMode: false,
    targetedMisses: [],
    scoreNearMisses: [],
    scoreNearMissesTotal: 0,
    creationHuntMode: true,
    ...overrides,
  };
}

describe('buildTelegramReportSections', () => {
  it('formate un run nocturne court et lisible', () => {
    const [msg] = buildTelegramReportSections({
      telemetry: baseTelemetry(),
      rapportMarkdown: '# long rapport',
      jobStatus: 'success',
      runUrl: 'https://github.com/org/repo/actions/runs/1',
    });

    assert.match(msg, /✅ Strate Radar · Run terminé/);
    assert.match(msg, /Annecy, France/);
    assert.match(msg, /💎 2 publiés \/ 5 visés/);
    assert.match(msg, /Nails\.ByTaïss · présence/);
    assert.match(msg, /Gaulthier Sanitaire · création/);
    assert.match(msg, /47 fiches · Places 52\/120/);
    assert.match(msg, /Serper \+ Brave/);
    assert.match(msg, /github\.com\/org\/repo\/actions\/runs\/1/);

    assert.doesNotMatch(msg, /——/);
    assert.doesNotMatch(msg, /Gatekeeper/);
    assert.doesNotMatch(msg, /sous seuil refonte/);
    assert.doesNotMatch(msg, /LEADS QUALIFIÉS/);
    assert.doesNotMatch(msg, /rapport_matinal/);
  });

  it('signale Serper absent et les échecs ingest', () => {
    const [msg] = buildTelegramReportSections({
      telemetry: baseTelemetry({
        webSearchBootStatus: 'actif · Brave fallback (31 car.) · plafond 120 req/run',
        ingest: {
          ...baseTelemetry().ingest,
          successCount: 1,
          failureCount: 1,
          successes: [
            {
              name: 'OK Shop',
              publicUrl: 'https://www.strate-studio.fr/audit/ok',
            },
          ],
          failures: [
            {
              name: 'Failed Shop',
              status: 500,
              message: 'Internal error',
              slug: 'failed-shop',
            },
          ],
        },
        errors: ['Ingest vitrine · Failed Shop · HTTP 500 · Internal error'],
      }),
      rapportMarkdown: null,
      jobStatus: 'success',
      runUrl: 'https://github.com/run/2',
    });

    assert.match(msg, /Brave seul — Serper absent/);
    assert.match(msg, /❌ Ingest échoué/);
    assert.match(msg, /Failed Shop · HTTP 500/);
  });

  it('formate un audit ciblé sans dump markdown', () => {
    const [msg] = buildTelegramReportSections({
      telemetry: baseTelemetry({
        targetedMode: true,
        leads: [
          {
            name: 'Mercier Chauffage Sanitaire',
            badge: 'DIAMANT_CREATION',
            displayUrl: 'https://mercierchauffagesanitaire.fr/',
            webStatus: 'owner_site',
            presencePlatform: null,
            webSource: 'top5_scanner',
            strateScore: 42,
            publicAuditUrl: null,
            trendingQuery: 'chauffage Annecy',
          },
        ],
        ingest: { ...baseTelemetry().ingest, successCount: 0, successes: [] },
      }),
      rapportMarkdown: '# énorme rapport markdown',
      jobStatus: 'success',
      runUrl: 'https://github.com/run/3',
    });

    assert.match(msg, /Audit ciblé/);
    assert.match(msg, /Mercier Chauffage/);
    assert.match(msg, /owner_site/);
    assert.match(msg, /Non publié sur la vitrine/);
    assert.doesNotMatch(msg, /énorme rapport/);
  });

  it('gère l’absence de heartbeat', () => {
    const [msg] = buildTelegramReportSections({
      telemetry: null,
      rapportMarkdown: null,
      jobStatus: 'failure',
      runUrl: 'https://github.com/run/4',
    });

    assert.match(msg, /❌ Strate Radar · Échec/);
    assert.match(msg, /pas de heartbeat/);
  });
});

describe('flattenTelegramMessages', () => {
  it('reste en un seul message si court', () => {
    const out = flattenTelegramMessages(['hello\nworld']);
    assert.equal(out.length, 1);
    assert.equal(out[0], 'hello\nworld');
  });
});
