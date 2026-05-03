import type { PageSpeedInsightsV5 } from './schemas.js';

export const MOCK_PAGESPEED_RESPONSE: PageSpeedInsightsV5 = {
  kind: 'pagespeedonline#result',
  id: 'mock-pagespeed-id',
  lighthouseResult: {
    requestedUrl: 'https://example-bakery.test/',
    finalUrl: 'https://example-bakery.test/',
    fetchTime: '2026-05-02T10:05:00.000Z',
    lighthouseVersion: '11.0.0-mock',
    categories: {
      performance: {
        id: 'performance',
        title: 'Performance',
        score: 0.72,
      },
      accessibility: {
        id: 'accessibility',
        title: 'Accessibility',
        score: 0.91,
      },
      'best-practices': {
        id: 'best-practices',
        title: 'Best Practices',
        score: 0.85,
      },
      seo: {
        id: 'seo',
        title: 'SEO',
        score: 0.88,
      },
    },
    audits: {
      'first-contentful-paint': {
        id: 'first-contentful-paint',
        title: 'First Contentful Paint',
        score: 0.65,
        numericValue: 1850,
        displayValue: '1.9 s',
      },
      interactive: {
        id: 'interactive',
        title: 'Time to Interactive',
        score: 0.58,
        numericValue: 4200,
        displayValue: '4.2 s',
      },
    },
  },
};
