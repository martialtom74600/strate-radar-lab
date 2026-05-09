export {
  runRadarPipeline,
  type GatekeeperExclusion,
  type PipelineStrateScore,
  type RadarPipelineLine,
  type RadarPipelineResult,
  type RadarSearchParams,
  type RunRadarPipelineOptions,
  type ConversionBadge,
  type LeadQuotaState,
} from './radar-pipeline.js';
export type { RadarNearbyCompetitor } from '../lib/nearby-competitors.js';
export type { DiamondPainType } from '../lib/diamond.js';
export type { WebsiteSource } from '../storage/index.js';
export {
  renderRapportMatinal,
  writeRapportMatinalFile,
} from './rapport-matinal.js';
export type {
  AuditIngestPayload,
  StrateRadarAuditPayload,
  StrateRadarAuditNearbyCompetitor,
} from '../lib/strate-studio/audit-payload.js';
export type { StudioIngestSuccess } from '../lib/strate-studio/audit-ingest.js';
export {
  buildShadowSitesPayload,
  writeShadowSitesExportFile,
  DEFAULT_SHADOW_EXPORT_PATH,
  type ShadowSiteExportRecord,
} from './shadow-export.js';
export { generateShadowPagesFromExport } from './generate-shadow-pages.js';
