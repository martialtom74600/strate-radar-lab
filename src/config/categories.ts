/**
 * Liste de grainage — termes larges pour maximiser la diversité métier tout en ciblant
 * des entreprises à fort potentiel de trésorerie (volume d’avis Maps).
 */
export const DIAMOND_SEED_CATEGORIES: readonly string[] = [
  'Artisan', 'Cabinet', 'Service', 'Location', 'Expert', 'Clinique', 'Agence', 'Restaurant', 'Garage', 'Immobilier', 'Coiffure', 'Pharmacie', 'Hôtel', 'Électricien', 'Plombier', 'Paysagiste', 'Pisciniste', 'Menuisier', 'Cuisiniste', 'Couvreur', 'Charpentier', 'Chauffagiste', 'Maçon', 'Peintre', 'Carreleur', 'Serrurier', 'Vétérinaire', 'Dentiste', 'Orthodontiste', 'Ostéopathe', 'Chiropracteur', 'Spa', 'Esthétique', 'Kiné', 'Opticien', 'Notaire', 'Avocat', 'Géomètre', 'Architecte', 'Ingénieur', 'Comptable', 'Sécurité', 'Nettoyage', 'Déménageur', 'Traiteur', 'Conciergerie', 'Bateau', 'Parapente', 'Camping', 'Gîte', 'Funèbres', 'Carrosserie', 'Événementiel', 'Formation', 'Transport', 'Taxi', 'Laboratoire', 'Radiologie', 'Élagage', 'Forage', 'Ascenseurs', 'Isolation', 'Piscine', 'Nautisme', 'Blanchisserie', 'Audioprothésiste', 'Orthophoniste', 'Podologue', 'Carrossier', 'Décorateur', 'Ferronnier', 'Vitrier', 'Ramoneur', 'Ébéniste', 'Antiquaire', 'Bijoutier', 'Tatoueur', 'Toilettage', 'Audit', 'Conseil', 'Gardiennage', 'Pressing', 'Lavage', 'Dépannage', 'Remorquage', 'Assainissement', 'Jardinier', 'Pépinière', 'Fleuriste', 'Prothésiste', 'Chauffage', 'Climatisation', 'Solaire', 'Toiture', 'Façade', 'Charpente',
];

/** Construit le texte de recherche : grain + zone (Places Text Search). */
export function buildSeedSearchQuery(seedKeyword: string, locationLabel: string): string {
  const seed = seedKeyword.trim();
  const loc = locationLabel.trim();
  return [seed, loc].filter(Boolean).join(' ');
}
