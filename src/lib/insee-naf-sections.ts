/**
 * Intitulés des sections NAF rév. 2 (niveau le plus agrégé — source : nomenclature INSEE publique).
 * Utilisés pour qualifier l’activité officielle lorsque la réponse API renvoie le code-section (une lettre).
 */
const NAF_REV2_SECTION_LABELS: Readonly<Record<string, string>> = {
  A: 'Agriculture, sylviculture et pêche',
  B: 'Industries extractives, énergie, eau, assainissement, gestion des déchets et dépollution',
  C: 'Industrie manufacturière',
  D: "Production et distribution d'électricité, de gaz, de vapeur et d'air conditionné",
  E: 'Distribution d’eau ; assainissement, gestion des déchets et dépollution',
  F: 'Construction',
  G: 'Commerce ; réparation d’automobiles et de motocycles',
  H: 'Transports et entreposage',
  I: 'Hébergement-restauration',
  J: 'Information et communication',
  K: 'Activités financières et d’assurance',
  L: 'Activités immobilières',
  M: 'Activités spécialisées, scientifiques et techniques',
  N: 'Activités de services administratifs et de soutien',
  O: 'Administration publique',
  P: 'Enseignement',
  Q: 'Santé humaine et action sociale',
  R: 'Arts, spectacles et activités récréatives',
  S: 'Autres activités de services',
  T:
    'Activités des ménages en tant qu’employeurs ; activités indifférenciées des ménages en tant que producteurs de biens et services pour usage propre',
  U: 'Activités extra-territoriales',
};

export function inseeNafRev2SectionLibelle(sectionCode: string | null | undefined): string | null {
  const c = sectionCode?.trim().toUpperCase();
  if (!c || c.length !== 1) return null;
  return NAF_REV2_SECTION_LABELS[c] ?? null;
}
