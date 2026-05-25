import type { AppConfig } from '../../config/index.js';
import { buildSeedSearchQueryVariants } from '../../config/categories.js';
import type { GroqClient } from '../../services/groq/index.js';
import { CreationHuntRepository } from './repository.js';
import { CREATION_HUNT_SECTORS } from './sectors.js';

export type CreationHuntQuery = {
  readonly q: string;
  readonly zone: string;
  readonly sector: string;
  /** Taux de conversion historique du secteur dans cette zone (créations / fiches scannées). */
  readonly convRate: number;
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
  readonly anchorZones: readonly string[];
  readonly sectorsPerZone: number;
  readonly expansionRing: number;
  /** Région / département passé à Groq pour contraindre l'expansion géo (optionnel). */
  readonly geoRegion?: string;
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

/** Anneau 0 = ancres seules ; chaque anneau suivant ajoute ~3 communes par ancre via Groq. */
function targetZoneCountForRing(expansionRing: number, anchorCount: number): number {
  return anchorCount + Math.max(0, expansionRing) * 3;
}

async function ensureZonesForRing(args: PlanCreationHuntArgs): Promise<string[]> {
  const { repo, groq, anchorZones, expansionRing } = args;

  for (const anchor of anchorZones) {
    await repo.ensureAnchorZone(anchor.trim());
  }

  const targetCount = targetZoneCountForRing(expansionRing, anchorZones.length);
  let active = await repo.getActiveZonesOrdered();
  let guard = 0;

  while (active.length < targetCount && guard < 6) {
    guard += 1;
    const expandFrom =
      active[active.length - 1]?.trim() ||
      (await repo.getLastExpansionAnchor())?.trim() ||
      anchorZones[0]!.trim();

    let suggested: string[] = [];
    try {
      suggested = await groq.suggestNeighborCities(expandFrom, args.geoRegion);
    } catch {
      /* Groq indisponible — on travaille avec les zones déjà connues */
      break;
    }

    if (suggested.length === 0) break;

    await repo.upsertExpansionZones(suggested, expansionRing + 1, 'groq');
    const next = await repo.getActiveZonesOrdered();
    if (next.length <= active.length) break;
    active = next;
  }

  if (active.length === 0) return anchorZones.map((a) => a.trim());
  return active.slice(0, targetCount);
}

/** Planifie une vague de requêtes grain × zone pour maximiser les créations. */
export async function planCreationHuntWave(args: PlanCreationHuntArgs): Promise<CreationHuntPlan> {
  const { repo, sectorsPerZone, expansionRing, config } = args;
  const zones = await ensureZonesForRing(args);

  /* Secteurs globalement stagnants (toutes zones) → exclus du pool ce run */
  const stagnantSectors = new Set(
    await repo.getGloballyStagnantSectors(
      config.RADAR_CREATION_HUNT_STAGNANT_SECTOR_NIGHTS,
      config.RADAR_CREATION_SATURATION_RUNS,
      config.RADAR_CREATION_LOW_THRESHOLD,
    ),
  );
  const activePool = CREATION_HUNT_SECTORS.filter((s) => !stagnantSectors.has(s));
  const pool = activePool.length > 0 ? activePool : CREATION_HUNT_SECTORS;

  const waves: CreationHuntWave[] = [];
  const sectorsUsed: string[] = [];

  for (const zone of zones) {
    const picked = await repo.pickRotatingSectors(
      zone,
      sectorsPerZone,
      pool,
      config.RADAR_CREATION_LOW_THRESHOLD,
      config.RADAR_CREATION_SATURATION_RUNS,
    );

    /* 2 variantes de requête par secteur → double les chances de trouver des fiches Maps */
    const queries: CreationHuntQuery[] = picked.flatMap(({ sector, convRate }) => {
      const [q1, q2] = buildSeedSearchQueryVariants(sector, zone);
      return [
        { sector, zone, q: q1, convRate },
        { sector, zone, q: q2, convRate },
      ];
    });

    sectorsUsed.push(...picked.map((p) => p.sector));
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

/** Passe à l'anneau géographique suivant quand le quota création n'est pas atteint. */
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

/**
 * Dérive la liste des zones ancres depuis TARGET_CITIES (séparateur `|`)
 * puis RADAR_SEARCH_LOCATION comme fallback.
 */
export function resolveAnchorZones(config: AppConfig): string[] {
  const raw = config.TARGET_CITIES?.trim();
  if (raw) {
    const cities = raw
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (cities.length > 0) return uniqueStrings(cities);
  }
  return [config.RADAR_SEARCH_LOCATION];
}
