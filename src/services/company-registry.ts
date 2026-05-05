import { inseeNafRev2SectionLibelle } from '../lib/insee-naf-sections.js';

const RECHERCHE_ENTREPRISES_SEARCH =
  'https://recherche-entreprises.api.gouv.fr/search' as const;

/** User-Agent explicite (recommandation api.gouv). */
const REGISTRY_USER_AGENT = 'strate-radar/0.1 (radar-commercial; recherche entreprises données publiques)';

/** Seuil minimal sur le champ `score` renvoyé par l’API (plus le score est haut, plus le rattachement textuel est net). */
const MIN_MATCH_SCORE = 110;

const FETCH_TIMEOUT_MS = 12_000;

export type CompanyRegistryLegalData = {
  readonly source: 'recherche_entreprises_api_gouv';
  readonly siren: string;
  readonly siretSiege: string;
  readonly nomRaisonSociale: string;
  readonly codeNaf: string | null;
  readonly codeNafRevision25: string | null;
  readonly codeRegistreMetiers: string | null;
  readonly sectionNafCode: string | null;
  readonly sectionNafLibelleInsee: string | null;
  /** Phrase hors invention : codes issus du registre + section INSEE officielle (intitulé agrégé NAF rév. 2). */
  readonly activiteOfficielleResume: string;
  readonly anneeCreation: number | null;
  readonly matchScore: number;
  readonly siegeCodePostal: string | null;
  readonly siegeLibelleCommune: string | null;
};

function extractFrenchPostalCode(address: string | undefined): string | null {
  if (!address?.trim()) return null;
  const m = address.match(/\b(\d{5})\b/);
  return m?.[1] ?? null;
}

/** Ville souvent en fin d’adresse française après le code postal. */
function extractCityAfterPostal(address: string | undefined): string | null {
  if (!address?.trim()) return null;
  const m = address.match(/\b\d{5}\s+(.+)$/);
  if (!m?.[1]) return null;
  return m[1].replace(/,?\s*France\s*$/i, '').trim() || null;
}

function cityFromSearchLocation(searchLocationHint: string | null | undefined): string | null {
  const raw = searchLocationHint?.trim();
  if (!raw) return null;
  const first = raw.split(',')[0]?.trim();
  return first || null;
}

function buildSearchQuery(establishmentTitle: string, cityLabel: string | null): string {
  return [establishmentTitle.trim(), cityLabel?.trim() ?? ''].filter((s) => s.length > 0).join(' ');
}

function parseYear(isoDate: string | null | undefined): number | null {
  if (!isoDate?.trim()) return null;
  const y = Number.parseInt(isoDate.trim().slice(0, 4), 10);
  return Number.isFinite(y) && y >= 1000 && y <= 3000 ? y : null;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function readString(x: unknown): string | null {
  return typeof x === 'string' && x.trim() !== '' ? x.trim() : null;
}

function readNumber(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

function normalizeCitySlug(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** Si on dispose d’un indice commune (Maps ou requête), évite d’attribuer un SIREN hors zone. */
function cityHintMatchesSiege(hint: string | null | undefined, libelleCommune: string | null): boolean {
  if (!hint?.trim()) return true;
  if (!libelleCommune?.trim()) return true;
  const a = normalizeCitySlug(hint);
  const b = normalizeCitySlug(libelleCommune);
  if (!a || !b) return true;
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}

function buildActiviteResume(parts: {
  readonly sectionLibelle: string | null;
  readonly codeNaf: string | null;
  readonly codeRm: string | null;
}): string | null {
  const chunks: string[] = [];
  if (parts.sectionLibelle) {
    chunks.push(parts.sectionLibelle);
  }
  if (parts.codeNaf) {
    chunks.push(`Code APE / NAF ${parts.codeNaf}`);
  }
  if (parts.codeRm) {
    chunks.push(`Code registre des métiers ${parts.codeRm}`);
  }
  const s = chunks.join(' — ');
  return s.trim() !== '' ? s : null;
}

export type FetchCompanyLegalDataArgs = {
  readonly establishmentTitle: string;
  /** Ex. `RADAR_SEARCH_LOCATION` / intention « Ville, France ». */
  readonly searchLocationHint: string | null | undefined;
  /** Adresse affichée par Maps / Serp (CP + commune). */
  readonly mapsAddress: string | undefined;
};

/**
 * Interroge l’API publique État `recherche-entreprises.api.gouv.fr` (sans clé).
 * Retourne `null` si aucun résultat fiable : **aucune donnée inventée**.
 */
export async function fetchCompanyLegalDataForProspect(
  args: FetchCompanyLegalDataArgs,
): Promise<CompanyRegistryLegalData | null> {
  const title = args.establishmentTitle?.trim();
  if (!title) return null;

  const cityFromMaps = extractCityAfterPostal(args.mapsAddress);
  const cityFromSearch = cityFromSearchLocation(args.searchLocationHint);
  const cityLabel = cityFromMaps ?? cityFromSearch;

  const q = buildSearchQuery(title, cityLabel);
  if (!q) return null;

  const postal = extractFrenchPostalCode(args.mapsAddress);

  const params = new URLSearchParams();
  params.set('q', q);
  params.set('per_page', '1');
  params.set('page', '1');
  params.set('minimal', 'true');
  params.set('include', 'siege,score');
  if (postal !== null) {
    params.set('code_postal', postal);
  }

  const url = `${RECHERCHE_ENTREPRISES_SEARCH}?${params.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': REGISTRY_USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }

  if (!res.ok) {
    return null;
  }

  let body: unknown;
  try {
    body = (await res.json()) as unknown;
  } catch {
    return null;
  }

  if (!isRecord(body)) return null;
  const results = body.results;
  if (!Array.isArray(results) || results.length === 0) return null;

  const hit = results[0];
  if (!isRecord(hit)) return null;

  const score = readNumber(hit.score);
  if (score === null || score < MIN_MATCH_SCORE) return null;

  const siren = readString(hit.siren);
  const nomRs = readString(hit.nom_raison_sociale) ?? readString(hit.nom_complet);
  if (!siren || !nomRs) return null;

  const sectionCode = readString(hit.section_activite_principale);

  let codeNaf = readString(hit.activite_principale);
  let codeNaf25 = readString(hit.activite_principale_naf25);
  let codeRm: string | null = null;
  let siretSiege: string | null = null;
  let cp: string | null = null;
  let commune: string | null = null;
  let dateCreation: string | null = readString(hit.date_creation);

  const siege = hit.siege;
  if (isRecord(siege)) {
    codeNaf = readString(siege.activite_principale) ?? codeNaf;
    codeNaf25 = readString(siege.activite_principale_naf25) ?? codeNaf25;
    codeRm = readString(siege.activite_principale_registre_metier) ?? codeRm;
    siretSiege = readString(siege.siret) ?? siretSiege;
    cp = readString(siege.code_postal) ?? cp;
    commune = readString(siege.libelle_commune) ?? commune;
    dateCreation = readString(siege.date_creation) ?? dateCreation;
  }

  if (!siretSiege) return null;
  if (!cityHintMatchesSiege(cityLabel, commune)) {
    return null;
  }

  const sectionLibelle = inseeNafRev2SectionLibelle(sectionCode);
  const resume = buildActiviteResume({
    sectionLibelle,
    codeNaf,
    codeRm,
  });
  if (resume === null) return null;

  return {
    source: 'recherche_entreprises_api_gouv',
    siren,
    siretSiege,
    nomRaisonSociale: nomRs,
    codeNaf,
    codeNafRevision25: codeNaf25,
    codeRegistreMetiers: codeRm,
    sectionNafCode: sectionCode,
    sectionNafLibelleInsee: sectionLibelle,
    activiteOfficielleResume: resume,
    anneeCreation: parseYear(dateCreation),
    matchScore: score,
    siegeCodePostal: cp,
    siegeLibelleCommune: commune,
  };
}
