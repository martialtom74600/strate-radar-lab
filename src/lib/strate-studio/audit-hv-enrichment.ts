import type { RadarPipelineLine, RadarPipelineResult } from '../../pipeline/radar-pipeline.js';
import type { StrateRadarAuditPayload } from './audit-payload.js';

/** Pas d’enrichissement modélisé : le site mère reçoit uniquement le payload de base (dont `googleMapsRaw`). */
export function extendAuditPayloadWithHighValue(
  _line: RadarPipelineLine,
  _result: RadarPipelineResult,
  base: StrateRadarAuditPayload,
): StrateRadarAuditPayload {
  return base;
}
