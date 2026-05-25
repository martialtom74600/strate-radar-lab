import type { AppConfig } from '../../config/index.js';
import { buildSeedSearchQuery } from '../../config/categories.js';
import type { GroqClient } from '../../services/groq/index.js';
import { StrateRadarError } from '../errors.js';
import { CreationHuntRepository } from './repository.js';
import { CREATION_HUNT_SECTORS } from './sectors.js';

export type CreationHuntQuery = {
  readonly q: string;
  readonly zone: string;
  readonly sector: string;
};

export type CreationHuntWave = {
  readonly zone: string;
  readonly queries: readonly CreationHuntQuery[];
};

export type CreationHuntPlan = {
  readonly waves: readonly CreationHuntWave[];
  readonly zonesUsed: readonly string[];
  readonly sectorsUsed: readonly string[];
  readonly expansionRing: number;
};

export type PlanCreationHuntArgs = {
  readonly config: AppConfig;
  readonly repo: CreationHuntRepository;
  readonly groq: GroqClient;
  readonly anchorZone: string;
  readonly sectorsPerZone: number;
  readonly expansionRing: number;
};

function uniqueStrings(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const k = item.trim();
    if (!k || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out.push(k);
  }
  return out;
}

/** Anneau 0 = ancre seule ; chaque anneau suivant ajoute ~3 communes via Groq. */
function targetZoneCountForRing(expansionRing: number): number {
  return 1 + Math.max(0, expansionRing) * 3;
}

async function ensureZonesForRing(args: PlanCreationHuntArgs): Promise<string[]> {
  const { repo, groq, anchorZone, expansionRing } = args;
  const anchor = anchorZone.trim();
  await repo.ensureAnchorZone(anchor);

  const targetCount = targetZoneCountForRing(expansionRing);
  let active = await repo.getActiveZonesOrdered();
  let guard = 0;

  while (active.length < targetCount && guard < 5) {
    guard += 1;
    const expandFrom =
      active[active.length - 1]?.trim() ||
      (await repo.getLastExpansionAnchor())?.trim() ||
      anchor;
    const suggested = await groq.suggestNeighborCities(expandFrom);
    if (suggested.length === 0) {
      if (active.length === 0) {
        throw new StrateRadarError(
          'CREATION_HUNT_EXPAND',
          `Creation Hunt : Groq n’a proposé aucune ville limitrophe depuis « ${expandFrom} ».`,
        );
      }
      break;
    }
    await repo.upsertExpansionZones(suggested, expansionRing + 1, 'groq');
    const next = await repo.getActiveZonesOrdered();
    if (next.length <= active.length) break;
    active = next;
  }

  if (active.length === 0) return [anchor];
  return active.slice(0, targetCount);
}

/** Planifie une vague de requêtes grain × zone pour maximiser les créations. */
export async function planCreationHuntWave(args: PlanCreationHuntArgs): Promise<CreationHuntPlan> {
  const { repo, sectorsPerZone, expansionRing } = args;
  const zones = await ensureZonesForRing(args);
  const waves: CreationHuntWave[] = [];
  const sectorsUsed: string[] = [];

  for (const zone of zones) {
    const sectors = await repo.pickRotatingSectors(zone, sectorsPerZone, CREATION_HUNT_SECTORS);
    const queries: CreationHuntQuery[] = sectors.map((sector) => ({
      sector,
      zone,
      q: buildSeedSearchQuery(sector, zone),
    }));
    sectorsUsed.push(...sectors);
    if (queries.length > 0) {
      waves.push({ zone, queries });
    }
  }

  return {
    waves,
    zonesUsed: uniqueStrings(zones),
    sectorsUsed: uniqueStrings(sectorsUsed),
    expansionRing,
  };
}

export type ExpandCreationHuntArgs = PlanCreationHuntArgs & {
  readonly currentRing: number;
  readonly maxExpansions: number;
};

/** Passe à l’anneau géographique suivant quand le quota création n’est pas atteint. */
export async function planNextCreationHuntExpansion(
  args: ExpandCreationHuntArgs,
): Promise<CreationHuntPlan | null> {
  const nextRing = args.currentRing + 1;
  if (nextRing > args.maxExpansions) return null;

  await args.repo.reactivateAllZones();

  return planCreationHuntWave({
    ...args,
    expansionRing: nextRing,
  });
}

/** Libellé court pour rapports / Telegram. */
export function describeCreationHuntPlan(plan: CreationHuntPlan): string {
  return `Creation Hunt · ${plan.zonesUsed.length} zone(s) · anneau ${plan.expansionRing} · ${plan.sectorsUsed.length} métier(s)`;
}
