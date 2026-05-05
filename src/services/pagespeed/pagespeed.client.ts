import type { AppConfig } from '../../config/index.js';
import { StrateRadarError } from '../../lib/errors.js';
import { withRetry } from '../../lib/retry.js';
import { MOCK_PAGESPEED_RESPONSE } from './mock-data.js';
import type { PageSpeedInsightsV5 } from './schemas.js';

export type PageSpeedStrategy = 'mobile' | 'desktop';

export type PageSpeedRunParams = {
  readonly url: string;
  readonly strategy?: PageSpeedStrategy;
};

export type PageSpeedClient = {
  readonly runPagespeed: (params: PageSpeedRunParams) => Promise<PageSpeedInsightsV5>;
};

const PSI_BASE = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

function parsePsiJson(raw: unknown): PageSpeedInsightsV5 {
  if (!raw || typeof raw !== 'object') {
    throw new StrateRadarError(
      'PSI_PARSE',
      'Réponse PageSpeed invalide : objet JSON attendu.',
    );
  }
  return raw as PageSpeedInsightsV5;
}

async function runPagespeedLive(
  apiKey: string,
  params: PageSpeedRunParams,
): Promise<PageSpeedInsightsV5> {
  const url = new URL(PSI_BASE);
  url.searchParams.set('url', params.url);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('strategy', params.strategy ?? 'mobile');

  return withRetry(async () => {
    const res = await fetch(url);
    if (!res.ok) {
      let detail = '';
      try {
        const errBody = (await res.json()) as { error?: { message?: string } };
        detail = errBody.error?.message ?? '';
      } catch {
        /* ignore */
      }
      throw new StrateRadarError(
        'HTTP_STATUS',
        `PageSpeed HTTP ${res.status}${detail ? ` — ${detail}` : ''}`,
        { status: res.status },
      );
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new StrateRadarError('PSI_JSON', 'Corps JSON invalide', { cause: e });
    }
    return parsePsiJson(json);
  });
}

export function createPageSpeedClient(config: AppConfig): PageSpeedClient {
  if (config.simulation) {
    return {
      async runPagespeed(_params: PageSpeedRunParams) {
        return parsePsiJson(structuredClone(MOCK_PAGESPEED_RESPONSE));
      },
    };
  }

  const apiKey = config.GOOGLE_PAGESPEED_API_KEY?.trim();
  if (!apiKey) {
    throw new StrateRadarError(
      'CONFIG',
      'GOOGLE_PAGESPEED_API_KEY manquant en mode réel',
    );
  }

  return {
    runPagespeed(params: PageSpeedRunParams) {
      return runPagespeedLive(apiKey, params);
    },
  };
}
