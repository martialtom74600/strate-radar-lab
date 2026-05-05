export type {
  LighthouseCategory,
  LighthouseResult,
  PageSpeedInsightsV5,
} from './schemas.js';
export type { LighthouseAuditRef } from './schemas.js';
export { MOCK_PAGESPEED_RESPONSE } from './mock-data.js';
export {
  createPageSpeedClient,
  type PageSpeedClient,
  type PageSpeedRunParams,
  type PageSpeedStrategy,
} from './pagespeed.client.js';
