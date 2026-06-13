import {
  DIAMOND_MIN_RATING_EXCLUSIVE,
  DIAMOND_MIN_REVIEWS_EXCLUSIVE,
  hasCreationReputation,
  type ResolvedWebsite,
} from './diamond.js';
import type { WebsitePresenceStatus } from './website-presence-types.js';
import type { SerpLocalResult } from '../services/serp/schemas.js';
import type { PageSpeedInsightsV5 } from '../services/pagespeed/schemas.js';

/** Seuil Diamant sur la matrice Strate (hors bypass « Diamant brut »). */
export const STRATE_DIAMOND_THRESHOLD = 50;

/** Score symbolique sur le chemin « Diamant création » (pas de matrice). */
export const STRATE_DIAMANT_CREATION_SCORE = 100;

/** @deprecated Alias historique */
export const STRATE_DIAMANT_BRUT_SCORE = STRATE_DIAMANT_CREATION_SCORE;

/** Pilier 4 (PageSpeed) si pilier2 + pilier3 ≥ cette somme (inclus). */
export const STRATE_PILIER4_SUM_TRIGGER_EXCLUSIVE = 30;

export type StratePilierBreakdown = {
  readonly earned: number;
  readonly max: number;
  readonly items: readonly string[];
};

export type StrateScoreResult = {
  readonly total: number;
  readonly pilier1: StratePilierBreakdown;
  readonly pilier2: StratePilierBreakdown;
  readonly pilier3: StratePilierBreakdown;
  readonly pilier4?: StratePilierBreakdown;
  readonly pageSpeedRun: boolean;
  readonly pageSpeedSkippedReason?: string;
};

export type HtmlFetchResult = {
  readonly ok: boolean;
  readonly html: string;
  readonly finalUrl: string;
  readonly error?: string;
};

const USER_AGENT =
  'StrateRadar/1.0 (+https://strate-studio.fr; acquisition locale; contact@strate-studio.fr)';

/** Fetch HTML avec timeout — ne bloque pas indéfiniment la boucle radar. */
export async function fetchHtmlWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<HtmlFetchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    const html = await res.text();
    return {
      ok: res.ok,
      html,
      finalUrl: res.url || url,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      html: '',
      finalUrl: url,
      error: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Chemin « Diamant création » : aucune présence web résolue + réputation Maps (seuils création). */
export function qualifiesDiamantCreation(
  serp: SerpLocalResult,
  websiteStatus: WebsitePresenceStatus,
): boolean {
  if (websiteStatus !== 'none') return false;
  return hasCreationReputation(serp);
}

/** Diamant présence tierce : annuaire ou réseau social — pas de site propriétaire (hors plateformes RDV). */
export function qualifiesDiamantPresence(
  serp: SerpLocalResult,
  websiteStatus: WebsitePresenceStatus,
): boolean {
  if (websiteStatus !== 'presence_only') return false;
  return hasCreationReputation(serp);
}

function isPremiumPriceTier(price: string | undefined): boolean {
  if (!price?.trim()) return false;
  const p = price.trim();
  if (/€{3,}/.test(p) || /\${3,}/.test(p)) return true;
  return p.includes('€€€') || p.includes('$$$');
}

function pilierEmpty(max: number): StratePilierBreakdown {
  return { earned: 0, max, items: [] };
}

/** Pilier 1 — potentiel financier (données Serp), max 20. */
export function scorePilier1Potential(serp: SerpLocalResult): StratePilierBreakdown {
  const max = 20;
  const items: string[] = [];
  let earned = 0;

  const reviews = serp.reviews ?? 0;
  const rating = serp.rating ?? 0;

  if (reviews > DIAMOND_MIN_REVIEWS_EXCLUSIVE && rating > DIAMOND_MIN_RATING_EXCLUSIVE) {
    earned += 10;
    items.push(`Trésorerie Maps : avis > ${DIAMOND_MIN_REVIEWS_EXCLUSIVE} et note > ${DIAMOND_MIN_RATING_EXCLUSIVE} (+10)`);
  }

  if (reviews > 150 || isPremiumPriceTier(serp.price)) {
    earned += 10;
    if (reviews > 150) items.push(`Dynamique : avis > 150 (+10)`);
    else if (isPremiumPriceTier(serp.price))
      items.push(`Dynamique : palier prix premium (type €€€/$$$) (+10)`);
  }

  if (earned === 0 && hasCreationReputation(serp)) {
    const add = Math.min(5, max - earned);
    earned += add;
    items.push(`Potentiel local modeste (avis/note au-dessus seuil création) (+${add})`);
  }

  return { earned: Math.min(earned, max), max, items };
}

const VIEWPORT_RE = /<meta[^>]+name=["']viewport["'][^>]*>/i;

function isEffectivelyHttps(urlToCheck: string): boolean {
  try {
    const u = new URL(urlToCheck);
    return u.protocol === 'https:';
  } catch {
    return urlToCheck.trim().toLowerCase().startsWith('https://');
  }
}

/** Pilier 2 — dette technique (HTML + URL), max 20. */
export function scorePilier2Technical(
  html: string | null,
  displayUrl: string,
  finalUrl: string | null,
): StratePilierBreakdown {
  const max = 20;
  const items: string[] = [];
  let earned = 0;

  const urlForScheme = (finalUrl && finalUrl.length > 0 ? finalUrl : displayUrl).trim();
  if (!isEffectivelyHttps(urlForScheme)) {
    earned += 10;
    items.push('Faille : URL en HTTP ou non-HTTPS (+10)');
  }

  if (!html || html.trim().length === 0) {
    const room = max - earned;
    if (room > 0) {
      earned += room;
      items.push(
        'HTML indisponible, HTTP non-OK ou corps vide — analyse technique impossible (pilier 2 au plafond)',
      );
    }
    return { earned: Math.min(earned, max), max, items };
  }

  if (!VIEWPORT_RE.test(html)) {
    earned += 10;
    items.push('Non-responsive probable : absence de meta viewport (+10)');
  }

  const tableCount = (html.match(/<table\b/gi) ?? []).length;
  const wix =
    /\bwix\.com\b/i.test(html) ||
    /\b_wix_browser_sess\b/i.test(html) ||
    /static\.parastorage\.com/i.test(html);
  const scriptTags = html.match(/<script\b[^>]*>/gi) ?? [];
  let heavySyncScripts = 0;
  for (const tag of scriptTags) {
    const lower = tag.toLowerCase();
    if (lower.includes('src=') && !lower.includes('defer') && !lower.includes('async')) {
      heavySyncScripts += 1;
    }
  }
  const legacyPattern =
    tableCount >= 2 ||
    wix ||
    heavySyncScripts >= 8 ||
    (scriptTags.length >= 20 && heavySyncScripts >= 5);

  if (legacyPattern) {
    const legacyCap = 5;
    const legacyAdd = Math.min(legacyCap, Math.max(0, max - earned));
    if (legacyAdd > 0) {
      earned += legacyAdd;
      const bits: string[] = [];
      if (tableCount >= 2) bits.push(`layout <table>×${tableCount}`);
      if (wix) bits.push('empreinte constructeur type Wix');
      if (heavySyncScripts >= 8) bits.push(`${heavySyncScripts} scripts src sans defer/async`);
      items.push(`Vétusté / lourdeur : ${bits.join(' · ')} (+${legacyAdd}, plafonné)`);
    }
  }

  return { earned: Math.min(earned, max), max, items };
}

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Phrases / mots-clés métiers de proximité (entrée normalisée sans accents). Ordre : plus long d'abord. */
const SERVICE_HINT_TERMS: readonly string[] = [
  'aide a domicile',
  'aide au domicile',
  'auxiliaire de vie',
  'assistante maternelle',
  'conseil en gestion',
  'conseiller en voyages',
  'cabinet comptable',
  'expert comptable',
  'controle technique',
  'diagnostic immobilier',
  'gestion locative',
  'agence immobiliere',
  'agent commercial',
  'agent immobilier',
  'home staging',
  'promoteur immobilier',
  'syndic de copropriete',
  'traiteur evenementiel',
  'nettoyage industriel',
  'nettoyage de locaux',
  'entreprise de nettoyage',
  'desinsectisation',
  'desinfection',
  'deratisation',
  '3d desinfection',
  'pompes funebres',
  'poissonnerie',
  'charcuterie',
  'fromagerie',
  'patisserie',
  'chocolaterie',
  'cordonnerie',
  'reparation express',
  'reparation telephone',
  'reparation mobile',
  'depannage informatique',
  'maintenance industrielle',
  'installation electrique',
  'installation sanitaire',
  'climatisation reversible',
  'videosurveillance',
  'couverture zinguerie',
  'carrosserie peinture',
  'location voiture',
  'location utilitaire',
  'demenagement',
  'auto ecole',
  'ecole de conduite',
  'formation continue',
  'formation professionnelle',
  'centre de formation',
  'organisme de formation',
  'salle de sport',
  'club de sport',
  'libre service',
  'pressing cleaning',
  'pressing blanchisserie',
  'service a la personne',
  'remise en forme',
  'soins esthetiques',
  'soin du visage',
  'extension de cils',
  'prothese ongulaire',
  'onglerie',
  'barbier',
  'tatoueur',
  'tatouage',
  'piercing',
  'osteopathie',
  'psychologue',
  'psychotherapeute',
  'orthophoniste',
  'orthoptiste',
  'ophtalmologue',
  'radiologie',
  'laboratoire analyse',
  'analyses medicales',
  'veterinaire',
  'toilettage',
  'animalerie',
  'jardin paysagiste',
  'elagage abattage',
  'espaces verts',
  'paysagiste',
  'ebenisterie',
  'menuiserie',
  'charpente',
  'maconnerie',
  'facadier',
  'isolation thermique',
  'etancheite',
  'couvreur',
  'zinguer',
  'vitrier',
  'serrurier',
  'plombier',
  'electricien',
  'chauffagiste',
  'climatisation',
  'couverture',
  'carreleur',
  'platrier',
  'staffeur',
  'nettoyage',
  'conciergerie',
  'gardien',
  'securite privee',
  'securite incendie',
  'surveillance',
  'gardiennage',
  'import export',
  'import',
  'export',
  'negociant',
  'grossiste',
  'fournisseur',
  'distribution',
  'logistique',
  'messagerie',
  'coursier',
  'livraison',
  'livreur',
  'drive',
  'supermarche',
  'hypermarche',
  'superette',
  'epicerie',
  'primeur',
  'primeurs',
  'boulangerie',
  'boucherie',
  'rotisserie',
  'traiteur',
  'restaurant',
  'brasserie',
  'pizzeria',
  'kebab',
  'sushi',
  'snack',
  'food',
  'cuisine',
  'cafe',
  'bar',
  'hotel',
  'motel',
  'chambre',
  'hebergement',
  'gite',
  'camping',
  'auberge',
  'residence',
  'spa',
  'hammam',
  'sauna',
  'massage',
  'institut',
  'esthetique',
  'estheticien',
  'cosmetique',
  'parfumerie',
  'coiffure',
  'coiffeur',
  'coiffeuse',
  'salon',
  'beauty',
  'beaute',
  'pharmacie',
  'parapharmacie',
  'dentaire',
  'dentiste',
  'orthodontiste',
  'cabinet',
  'clinique',
  'medecin',
  'docteur',
  'pediatre',
  'dermatologue',
  'cardiologue',
  'gynecologue',
  'sage femme',
  'infirmier',
  'aide soignant',
  'kinesitherapeute',
  'kine',
  'podologue',
  'diabetologue',
  'dieteticien',
  'nutrition',
  'opticien',
  'audioprothesiste',
  'prothese',
  'orthopedie',
  'fleuriste',
  'papeterie',
  'librairie',
  'photographe',
  'video',
  'audiovisuel',
  'ingenieur du son',
  'imprimerie',
  'copiste',
  'relieur',
  'papier',
  'pressing',
  'blanchisserie',
  'laverie',
  'mercerie',
  'couture',
  'retouches',
  'lingerie',
  'pret a porter',
  'vetement',
  'chaussure',
  'maroquinerie',
  'bijouterie',
  'horlogerie',
  'orfevre',
  'antiquaire',
  'brocante',
  'depot vente',
  'occasion',
  'cash converter',
  'garage',
  'mecanique',
  'automobile',
  'auto',
  'pneu',
  'recharge',
  'station',
  'lavage',
  'carwash',
  'taxi',
  'vtc',
  'ambulance',
  'transport',
  'travel',
  'tourisme',
  'agence',
  'agences',
  'immobilier',
  'immobiliere',
  'promoteur',
  'lotisseur',
  'constructeur',
  'maison',
  'batiment',
  'btp',
  'travaux',
  'renovation',
  'amenagement',
  'extension',
  'surelevation',
  'architecte',
  'ingenieur',
  'geometre',
  'topographe',
  'urbanisme',
  'designer',
  'decorateur',
  'deco',
  'agencement',
  'cuisiniste',
  'soldes',
  'equipement',
  'magasin',
  'boutique',
  'shop',
  'store',
  'commerce',
  'commercant',
  'retail',
  'showroom',
  'concept store',
  'cash',
  'discount',
  'destockage',
  'soldeur',
  'point de vente',
  'pdv',
  'boutiqu',
  'cooperative',
  'artisan',
  'artisans',
  'atelier',
  'serigraphie',
  'trophee',
  'gravure',
  'serrurerie',
  'metallerie',
  'chaudronnerie',
  'soudure',
  'location',
  'locatif',
  'loueur',
  'prestataire',
  'prestation',
  'sous traitant',
  'facilities',
  'facility management',
  'nettoyeur',
  'second oeuvre',
  'notaire',
  'avocat',
  'huissier',
  'bailiff',
  'conseil juridique',
  'conseil fiscal',
  'conseil rh',
  'conseil',
  'consulting',
  'consultant',
  'coach',
  'coaching',
  'formation',
  'cours',
  'enseignement',
  'tutorat',
  'soutien scolaire',
  'ecole',
  'lycee',
  'college',
  'universite',
  'cfa',
  'organisme',
  'centre',
  'etude',
  'etudes',
  'bureau',
  'comptable',
  'audit',
  'expertise',
  'juridique',
  'fiscal',
  'social',
  'interim',
  'interimaire',
  'emploi',
  'cabinet recrutement',
  'rh',
  'ressources humaines',
  'headhunting',
  'courtier',
  'assurance',
  'assureur',
  'mutuelle',
  'pret',
  'credit',
  'financement',
  'syndic',
  'gestionnaire',
  'administrateur',
  'fiduciaire',
  'fiduciary',
  'domiciliation',
  'courtage',
  'transaction',
  'negociation',
  'vente',
  'achat',
  'commerce de gros',
  'b2b',
  'b to b',
  'pro',
  'professionnel',
  'professionnels',
  'entreprise',
  'entrepreneur',
  'societe',
  'company',
  'sarl',
  'sas',
  'eurl',
  'sci',
  'scop',
  'scic',
  'holding',
  'groupe',
  'franchise',
  'franchisee',
  'reseau',
  'boutique franchise',
  'services',
  'service',
  'urgence',
  'urgences',
  'depannage',
  'sos',
  '24h',
  'astreinte',
  'plomb',
  'reparation',
  'reparer',
  'maintenance',
  'entretien',
  'remplacement',
  'installation',
  'fourniture',
  'electric',
  'sanitaire',
  'chauffage',
  'ventilation',
  'vmc',
  'pompe',
  'chaleur',
  'panneaux',
  'solaire',
  'photovoltaique',
  'alarme',
  'incendie',
  'sante',
  'medical',
  'biomedical',
  'optique',
  'denta',
  'laboratoire',
  'labo',
  'hygiene',
  'proprete',
  'aide',
  'domicile',
  'menage',
  'femme',
  'garde',
  'baby',
  'nounou',
  'creche',
  'micro creche',
  'halte garderie',
  'animatrice',
  'animateur',
  'animation',
  'evenementiel',
  'wedding',
  'mariage',
  'traiteur mariage',
  'reception',
  'restauration',
  'catering',
  'cantine',
  'collectivite',
  'collectivites',
  'mairie',
  'association',
  'ong',
  'culturel',
  'assoc',
  'local',
  'proximite',
  'quartier',
  'ville',
  'village',
  'atelier boutique',
  'show room',
  'point chaud',
  'corner',
  'corner shop',
  'market',
  'place',
  'passage',
  'galerie',
  'bricolage',
  'droguerie',
  'quincaillerie',
  'peinture',
  'peintre',
  'revetement de sol',
  'revetement',
  'moquette',
  'parquet',
  'carrelage',
  'carrel',
  'materiaux',
  'materiel',
  'negos',
  'trade',
  'depositaire',
  'concession',
  'concessionnaire',
  'dealership',
  'motor',
  'motos',
  'scooter',
  'bike',
  'cycle',
  'velo',
  'nautic',
  'marine',
  'bateau',
  'garage mecanique',
  'garde meuble',
  'self stockage',
  'stockage',
  'archivage',
  'numerisation',
  'city',
  'handicap',
  'pmr',
  'accessibilite',
  'translation',
  'traduction',
  'interprete',
  'langue',
  'co working',
  'coworking',
  'espace coworking',
  'incubateur',
  'accelerateur',
  'startup',
  'tech',
  'cowor',
  'ateliers',
  'fablab',
];

function escapeRegExpChunk(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SERVICE_HINTS = new RegExp(
  SERVICE_HINT_TERMS.map(escapeRegExpChunk).sort((a, b) => b.length - a.length).join('|'),
  'i',
);

export function isLikelyServiceBusiness(serp: SerpLocalResult): boolean {
  const t = normalizeText(`${serp.type ?? ''} ${serp.title}`);
  return SERVICE_HINTS.test(t);
}

/** +10 si incohérence NAP / identité locale vs HTML. */
export function scoreNapMismatch(html: string | null, serp: SerpLocalResult): StratePilierBreakdown {
  const max = 10;
  if (!html || html.trim().length < 50) {
    return { earned: 0, max, items: [] };
  }

  const hay = normalizeText(html).slice(0, 200_000);
  const titleWords = normalizeText(serp.title)
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 8);

  let nameHits = 0;
  for (const w of titleWords) {
    if (hay.includes(w)) nameHits += 1;
  }
  const nameCoverage =
    titleWords.length > 0 ? nameHits / Math.min(titleWords.length, 4) : 1;

  let addressSignal = false;
  const addr = serp.address?.trim();
  if (addr) {
    const normAddr = normalizeText(addr);
    const cp = /\b(\d{5})\b/.exec(normAddr);
    if (cp?.[1] && hay.includes(cp[1])) addressSignal = true;
    const tokens = normAddr.split(/\s+/).filter((t) => t.length > 3);
    let aHits = 0;
    for (const t of tokens.slice(0, 4)) {
      if (hay.includes(t)) aHits += 1;
    }
    if (tokens.length > 0 && aHits / tokens.length >= 0.5) addressSignal = true;
  }

  const cat = serp.type?.trim();
  let catOk = true;
  if (cat) {
    const ck = normalizeText(cat).split(/\s+/).filter((w) => w.length > 3);
    catOk = ck.length === 0 || ck.some((w) => hay.includes(w));
  }

  const mismatch =
    (titleWords.length >= 2 && nameCoverage < 0.35) ||
    (addr && !addressSignal) ||
    !catOk;

  if (!mismatch) {
    return { earned: 0, max, items: [] };
  }

  return {
    earned: max,
    max,
    items: ['Incohérence NAP / identité : nom, adresse ou catégorie Maps peu absents du site (+10)'],
  };
}

/** +15 friction mobile : métier de service mais pas de tel:/mailto: dans le HTML. */
export function scoreContactFriction(
  html: string | null,
  serp: SerpLocalResult,
): StratePilierBreakdown {
  const max = 15;
  if (!isLikelyServiceBusiness(serp)) {
    return { earned: 0, max, items: [] };
  }
  if (!html || html.trim().length < 30) {
    return { earned: 0, max, items: [] };
  }

  const hasTel = /href\s*=\s*["']tel:/i.test(html);
  const hasMail = /href\s*=\s*["']mailto:/i.test(html);
  if (hasTel || hasMail) {
    return { earned: 0, max, items: [] };
  }

  return {
    earned: max,
    max,
    items: ['Friction mobile : métier de service sans liens cliquables tel: / mailto: (+15)'],
  };
}

export type CtaHeuristicResult = {
  readonly hasClearCta: boolean;
  readonly reason: string;
};

/** Détection locale de CTA — stabilise le pilier 3 si Groq varie entre deux runs. */
export function assessCtaHeuristic(html: string): CtaHeuristicResult {
  if (!html || html.trim().length < 40) {
    return { hasClearCta: false, reason: 'HTML trop court pour détecter un CTA' };
  }

  if (/href\s*=\s*["']tel:/i.test(html) || /href\s*=\s*["']mailto:/i.test(html)) {
    return { hasClearCta: true, reason: 'Liens tel:/mailto: détectés' };
  }

  const ctaPatterns: readonly RegExp[] = [
    /demander\s+un\s+devis/i,
    /devis\s+gratuit/i,
    /nous\s+contacter/i,
    /contactez[-\s]nous/i,
    /prendre\s+rendez[-\s]?vous/i,
    /r[ée]server\s+(en\s+ligne|maintenant|votre)/i,
    /appelez[-\s]nous/i,
    /request\s+a\s+quote/i,
    /contact\s+us/i,
    /get\s+in\s+touch/i,
    /obtenir\s+un\s+devis/i,
  ];
  for (const re of ctaPatterns) {
    if (re.test(html)) {
      return { hasClearCta: true, reason: 'Motif texte CTA détecté dans le HTML' };
    }
  }

  if (/<form[\s\S]*?(type\s*=\s*["']submit["']|<button)/i.test(html)) {
    return { hasClearCta: true, reason: 'Formulaire ou bouton submit détecté' };
  }

  if (
    /<a[^>]+class\s*=\s*["'][^"']*btn[^"']*["'][^>]+href\s*=\s*["'](?!#|javascript:)[^"']+["']/i.test(
      html,
    )
  ) {
    return { hasClearCta: true, reason: 'Lien bouton (btn) avec href' };
  }

  return { hasClearCta: false, reason: 'Aucun CTA clair détecté (heuristique HTML)' };
}

export type DeadBrochureSignal = {
  readonly deadBrochure: boolean;
  readonly briefReason: string;
  readonly source: 'groq' | 'heuristic' | 'both';
};

/** Groq + heuristique : points plaquette si Groq ou HTML concordent sur l'absence de CTA. */
export async function resolveDeadBrochureSignal(args: {
  readonly html: string;
  readonly businessName: string;
  readonly analyzeDeadBrochure: (
    htmlExcerpt: string,
    businessName: string,
  ) => Promise<{ readonly deadBrochureSite: boolean; readonly briefReason: string }>;
}): Promise<DeadBrochureSignal> {
  const { html, businessName, analyzeDeadBrochure } = args;
  const heuristic = assessCtaHeuristic(html);

  let groq: { readonly deadBrochureSite: boolean; readonly briefReason: string } | null = null;
  try {
    groq = await analyzeDeadBrochure(excerptForAi(html), businessName);
  } catch {
    groq = null;
  }

  if (groq?.deadBrochureSite) {
    return {
      deadBrochure: true,
      briefReason: groq.briefReason || 'Plaquette / conversion floue (Groq)',
      source: heuristic.hasClearCta ? 'groq' : 'both',
    };
  }

  if (!heuristic.hasClearCta) {
    const reason = groq?.briefReason?.trim()
      ? `Heuristique : ${heuristic.reason} — Groq : ${groq.briefReason}`
      : heuristic.reason;
    return {
      deadBrochure: true,
      briefReason: reason,
      source: groq ? 'heuristic' : 'heuristic',
    };
  }

  return {
    deadBrochure: false,
    briefReason: groq?.briefReason?.trim() || heuristic.reason,
    source: 'groq',
  };
}

export function summarizeStrateNearMiss(strate: StrateScoreResult): string {
  const parts: string[] = [];
  if (strate.pageSpeedSkippedReason) parts.push(strate.pageSpeedSkippedReason);
  if (strate.pilier3.earned < 30) parts.push(`Pilier 3 conversion : ${strate.pilier3.earned}/40`);
  if ((strate.pilier4?.earned ?? 0) === 0 && strate.pageSpeedRun) {
    parts.push('PageSpeed mobile faible ou indisponible');
  }
  return parts.join(' · ').slice(0, 220) || 'Score matrice sous le seuil diamant refonte';
}

export type StrateMatrixContext = {
  readonly serp: SerpLocalResult;
  readonly resolved: ResolvedWebsite;
  readonly fetchResult: HtmlFetchResult;
  readonly analyzeDeadBrochure: (
    htmlExcerpt: string,
    businessName: string,
  ) => Promise<{ readonly deadBrochureSite: boolean; readonly briefReason: string }>;
  readonly loadOrRunPageSpeed: () => Promise<{
    readonly psi: PageSpeedInsightsV5 | null;
    readonly mobilePercent: number | null;
  }>;
};

function excerptForAi(html: string, maxLen = 14_000): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  return stripped.slice(0, maxLen);
}

/**
 * Matrice Strate complète (prospect avec site). Pilier 4 si p2+p3 ≥ 30.
 */
export type StrateMatrixRunOutput = {
  readonly strate: StrateScoreResult;
  readonly pageSpeed: PageSpeedInsightsV5 | null;
  readonly mobilePerfPercent: number | null;
};

export async function runStrateMatrixScore(
  ctx: StrateMatrixContext,
): Promise<StrateMatrixRunOutput> {
  const { serp, resolved, fetchResult } = ctx;
  const htmlBody = fetchResult.html ?? '';
  const htmlUsable = fetchResult.ok && htmlBody.trim().length > 0;
  const html = htmlUsable ? htmlBody : null;
  const finalUrl = fetchResult.finalUrl || null;

  const p1 = scorePilier1Potential(serp);
  const p2 = scorePilier2Technical(html, resolved.displayUrl, finalUrl);

  const nap = scoreNapMismatch(html, serp);
  const friction = scoreContactFriction(html, serp);

  let p3EarnedSub = nap.earned + friction.earned;
  const p3Items = [...nap.items, ...friction.items];

  let brochureLabel = '';
  if (html && html.trim().length > 80) {
    const brochure = await resolveDeadBrochureSignal({
      html,
      businessName: serp.title,
      analyzeDeadBrochure: ctx.analyzeDeadBrochure,
    });
    if (brochure.deadBrochure) {
      p3EarnedSub += 15;
      const sourceTag =
        brochure.source === 'groq'
          ? 'Groq'
          : brochure.source === 'both'
            ? 'Groq + heuristique'
            : 'heuristique HTML';
      brochureLabel = `Plaquette / zéro CTA (${sourceTag}) : ${brochure.briefReason} (+15)`;
      p3Items.push(brochureLabel);
    }
  }

  const p3: StratePilierBreakdown = {
    earned: Math.min(p3EarnedSub, 40),
    max: 40,
    items: p3Items,
  };

  const techConvSum = p2.earned + p3.earned;
  let p4: StratePilierBreakdown | undefined;
  let pageSpeedRun = false;
  let pageSpeedSkippedReason: string | undefined;
  let pageSpeedPsi: PageSpeedInsightsV5 | null = null;
  let pageSpeedMobilePercent: number | null = null;

  if (techConvSum < STRATE_PILIER4_SUM_TRIGGER_EXCLUSIVE) {
    pageSpeedSkippedReason = `Pilier 2+3 = ${techConvSum} < ${STRATE_PILIER4_SUM_TRIGGER_EXCLUSIVE} — PageSpeed non sollicité`;
  } else {
    pageSpeedRun = true;
    const { psi, mobilePercent } = await ctx.loadOrRunPageSpeed();
    pageSpeedPsi = psi;
    pageSpeedMobilePercent = mobilePercent;
    const items: string[] = [];
    let earned = 0;
    if (mobilePercent === null || Number.isNaN(mobilePercent)) {
      items.push('PageSpeed : score mobile indisponible (0 pt)');
    } else if (mobilePercent < 35) {
      earned = 20;
      items.push(`Performance mobile < 35 (${mobilePercent}) (+20)`);
    } else if (mobilePercent <= 50) {
      earned = 10;
      items.push(`Performance mobile 35–50 (${mobilePercent}) (+10)`);
    }
    p4 = { earned, max: 20, items };
  }

  const total = p1.earned + p2.earned + p3.earned + (p4?.earned ?? 0);

  const strate: StrateScoreResult = {
    total,
    pilier1: p1,
    pilier2: p2,
    pilier3: p3,
    ...(p4 !== undefined ? { pilier4: p4 } : {}),
    pageSpeedRun,
    ...(pageSpeedSkippedReason !== undefined ? { pageSpeedSkippedReason } : {}),
  };

  return {
    strate,
    pageSpeed: pageSpeedPsi,
    mobilePerfPercent: pageSpeedMobilePercent,
  };
}
