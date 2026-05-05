/**
 * Sortie historique `analysis_json` (table `prospect_scans` / cache PageSpeed).
 * Conservé uniquement pour la lecture des lignes SQLite existantes.
 */
export type SalesAnalysis = {
  readonly executiveSummary: string;
  readonly pitchAngles: readonly string[];
  readonly objectionHandling: readonly string[];
  readonly recommendedOpening: string;
  readonly priority: 'high' | 'medium' | 'low';
};

export function parseSalesAnalysisJson(raw: unknown): SalesAnalysis | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.executiveSummary !== 'string' || o.executiveSummary.trim().length < 1) {
    return null;
  }
  if (!Array.isArray(o.pitchAngles)) return null;
  const pitchAngles = o.pitchAngles.filter(
    (x): x is string => typeof x === 'string' && x.trim().length > 0,
  );
  if (pitchAngles.length < 1) return null;
  const objectionHandling = Array.isArray(o.objectionHandling)
    ? o.objectionHandling.filter((x): x is string => typeof x === 'string')
    : [];
  if (typeof o.recommendedOpening !== 'string' || o.recommendedOpening.trim().length < 1) {
    return null;
  }
  const priority = o.priority;
  if (priority !== 'high' && priority !== 'medium' && priority !== 'low') return null;

  return {
    executiveSummary: o.executiveSummary.trim(),
    pitchAngles,
    objectionHandling,
    recommendedOpening: o.recommendedOpening.trim(),
    priority,
  };
}
