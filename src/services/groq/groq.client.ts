import Groq from 'groq-sdk';

import type { AppConfig } from '../../config/index.js';
import { StrateRadarError } from '../../lib/errors.js';
import { withRetry } from '../../lib/retry.js';
import {
  conversionBrochureSchema,
  diamondHunterPitchSchema,
  type ConversionBrochureAnalysis,
  type ConversionBrochureInput,
  type DiamondHunterInput,
  type DiamondHunterPitch,
} from './diamond-schemas.js';
import {
  MOCK_CONVERSION_BROCHURE,
  MOCK_DIAMOND_HUNTER_PITCH,
  MOCK_ORGANIC_MAPS_CONVERSION_ANALYSIS,
  MOCK_SALES_ANALYSIS,
} from './mock-data.js';
import {
  prospectForAnalysisSchema,
  salesAnalysisSchema,
  type ProspectForAnalysis,
  type SalesAnalysis,
} from './schemas.js';

export type GroqClient = {
  readonly analyzeProspect: (input: ProspectForAnalysis) => Promise<SalesAnalysis>;
  readonly analyzeDiamondHunterPitch: (input: DiamondHunterInput) => Promise<DiamondHunterPitch>;
  readonly analyzeConversionBrochure: (
    input: ConversionBrochureInput,
  ) => Promise<ConversionBrochureAnalysis>;
  /** ~50 libellés courts de métiers / segments à fort ROI pour prospection Maps (FR). */
  readonly generateCampaignTradeCategories: () => Promise<string[]>;
  /** 3 villes limitrophes ou cohérentes commercialement avec l’ancrage (noms complets, France). */
  readonly suggestNeighborCities: (anchorCity: string) => Promise<string[]>;
};

function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(trimmed);
  if (fence?.[1]) return fence[1].trim();
  return trimmed;
}

function parseDiamondPitch(raw: string): DiamondHunterPitch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(raw));
  } catch (e) {
    throw new StrateRadarError('GROQ_JSON', 'Réponse Groq Diamond non JSON', { cause: e });
  }
  const safe = diamondHunterPitchSchema.safeParse(parsed);
  if (!safe.success) {
    throw new StrateRadarError(
      'GROQ_DIAMOND_PARSE',
      `JSON Diamond invalide : ${safe.error.message}`,
      { cause: safe.error },
    );
  }
  return safe.data;
}

function parseConversionBrochure(raw: string): ConversionBrochureAnalysis {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(raw));
  } catch (e) {
    throw new StrateRadarError('GROQ_JSON', 'Réponse Groq conversion non JSON', { cause: e });
  }
  const safe = conversionBrochureSchema.safeParse(parsed);
  if (!safe.success) {
    throw new StrateRadarError(
      'GROQ_CONVERSION_PARSE',
      `JSON conversion invalide : ${safe.error.message}`,
      { cause: safe.error },
    );
  }
  return safe.data;
}

function buildDiamondSystemPrompt(): string {
  return [
    'Tu agis comme DIRECTEUR·TRICE MARKETING et stratège e-commerce / marketing numérique pour l’agence Strate Studio.',
    'Le contact est un « Diamant » : preuve de flux Maps (avis, note), avec une douleur précisée dans le JSON (ancienne typologie ou matrice Strate).',
    'Si une trendingQuery est fournie, tu DOIS exploiter une technique FOMO (Fear Of Missing Out) : insister sur le fait que des dizaines de personnes tapent cette requête dans la zone en ce moment, tout en reliant la douleur du prospect (site lent, NAP, absence de CTA…) au risque de perdre ces contacts au profit de concurrents plus fluides sur mobile.',
    'Exemple de ton (à adapter) : « Des dizaines de personnes cherchent actuellement « [trendingQuery] » près de chez vous ; avec les lenteurs / ruptures de votre parcours mobile, ces demandes filent chez vos concurrents. »',
    'Si diamondPain vaut strate_matrix, un objet detaillant les piliers (strateScoreJson) est fourni : tu t’appuies dessus pour prioriser le pitch (NAP, mobile, perf, CTA).',
    'Tu dois estimer un MANQUE À GAGNER plutôt crédible (ordre de grandeur en perte de prospects ou de contacts qualifiés par mois), en croisant le métier, le volume d’avis, les signaux et l’urgence de la trendingQuery.',
    'La mention chiffrée est EXPLICATIVE et PÉDAGOGIQUE — pas une promesse juridique de CA.',
    'Réponds en français par UN objet JSON avec **exactement** les clés : headline, gainTempsEtAutomatisation, anglePrimeConversion, lost_revenue_pitch.',
    'headline : **maximum 10 mots**, une seule phrase, choc + chiffre ou contraste (douleur métier × trafic Maps / mobile). Pas de jargon creux.',
    'lost_revenue_pitch : une phrase percutante façon pitch téléphonique ; intégrer FOMO + douleur réelle si trendingQuery est présente.',
    'Ton : précis, orienté conversion locale, mobile-first, et ROI pour convaincre un dirigeant pressé.',
  ].join('\n');
}

function buildDiamondUserPayload(input: DiamondHunterInput): string {
  const painLabels: Record<DiamondHunterInput['diamondPain'], string> = {
    no_website: 'Ancienne règle : aucun site web exploitable (trafic Maps sans passerelle web).',
    site_not_linked_to_maps:
      'Site identifié via recherche organique mais PAS relié au champ site de la fiche Maps (décalage promesse / parcours).',
    mobile_performance_critical:
      'Site présent sur Maps mais performance mobile Lighthouse très faible — fuite d’usage mobile.',
    diamant_brut:
      'Bypass « Diamant brut » : forte preuve sur Maps mais aucun site (ce cas ne devrait normalement pas passer par ce prompt).',
    strate_matrix:
      'Qualifié par la matrice Strate (points de douleur technique + conversion + perf) — voir strateScoreJson.',
  };

  return [
    'Prospect « Diamant » (contexte acquisition) :',
    JSON.stringify(
      {
        ...input,
        douleur_libelle: painLabels[input.diamondPain],
      },
      null,
      2,
    ),
    '',
    'Schéma JSON strict attendu :',
    '{',
    '  "headline": string,',
    '  "gainTempsEtAutomatisation": string,',
    '  "anglePrimeConversion": string,',
    '  "lost_revenue_pitch": string',
    '}',
  ].join('\n');
}

async function analyzeDiamondLive(
  config: AppConfig,
  input: DiamondHunterInput,
): Promise<DiamondHunterPitch> {
  const apiKey = config.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new StrateRadarError('CONFIG', 'GROQ_API_KEY manquant en mode réel');
  }

  const groq = new Groq({ apiKey });
  const model = config.GROQ_MODEL;

  return withRetry(async () => {
    const completion = await groq.chat.completions.create({
      model,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildDiamondSystemPrompt() },
        { role: 'user', content: buildDiamondUserPayload(input) },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new StrateRadarError('GROQ_EMPTY', 'Réponse Groq Diamond vide');
    }
    return parseDiamondPitch(content);
  });
}

function buildConversionBrochureSystemPrompt(): string {
  return [
    'Tu es expert CRO et acquisition locale pour Strate Studio.',
    'Tu reçois un extrait HTML (balises et texte) d’une page d’entreprise.',
    'Indique si le site ressemble à une simple vitrine / plaquette sans intention de conversion nette (ex. pas de CTA clairs : appeler, réserver, devis, formulaire, RDV).',
    'Réponds en français par UN objet JSON : deadBrochureSite (boolean), briefReason (string, une phrase courte, factuelle).',
  ].join('\n');
}

function buildConversionBrochureUserPayload(input: ConversionBrochureInput): string {
  return [
    `Entreprise : ${input.businessName}`,
    input.mapsCategory !== undefined && input.mapsCategory !== ''
      ? `Catégorie Maps : ${input.mapsCategory}`
      : '',
    '',
    'Extrait HTML :',
    input.htmlExcerpt.slice(0, 24_000),
    '',
    '{"deadBrochureSite": boolean, "briefReason": string}',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

async function analyzeConversionBrochureLive(
  config: AppConfig,
  input: ConversionBrochureInput,
): Promise<ConversionBrochureAnalysis> {
  const apiKey = config.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new StrateRadarError('CONFIG', 'GROQ_API_KEY manquant en mode réel');
  }

  const groq = new Groq({ apiKey });
  const model = config.GROQ_MODEL;

  return withRetry(async () => {
    const completion = await groq.chat.completions.create({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildConversionBrochureSystemPrompt() },
        { role: 'user', content: buildConversionBrochureUserPayload(input) },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new StrateRadarError('GROQ_EMPTY', 'Réponse Groq conversion vide');
    }
    return parseConversionBrochure(content);
  });
}

function parseLabeledStringArray(raw: string, objectKey: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(raw));
  } catch (e) {
    throw new StrateRadarError('GROQ_JSON', 'Réponse Groq (tableau libellé) non JSON', { cause: e });
  }
  if (!parsed || typeof parsed !== 'object' || !(objectKey in (parsed as object))) {
    throw new StrateRadarError('GROQ_CAMPAIGN', `JSON : clé « ${objectKey} » manquante`);
  }
  const arr = (parsed as Record<string, unknown>)[objectKey];
  if (!Array.isArray(arr)) {
    throw new StrateRadarError('GROQ_CAMPAIGN', `« ${objectKey} » doit être un tableau`);
  }
  return arr
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function buildCampaignCategoriesPrompt(): string {
  return [
    'Tu es stratège acquisition locale pour une agence web en France.',
    'Produis exactement 50 libellés TRÈS COURTS (2 à 5 mots max chacun) de types d’entreprises / métiers à fort ROI pour la prospection Google Maps.',
    'Couvre artisans, santé (hors urgences), restauration, services B2B et autres niches rentables ; pas de doublons sémantiques.',
    'Réponds en français par UN objet JSON : { "categories": string[] } avec exactement 50 chaînes.',
  ].join('\n');
}

function buildNeighborCitiesPrompt(anchorCity: string): string {
  return [
    `Ville d’ancrage : « ${anchorCity} » (France).`,
    'Propose exactement 3 autres villes françaises LIMITROPHES ou dans le même bassin économique immédiat, pertinentes pour prospection commerciale locale.',
    'Format : noms explicites avec pays si utile (ex. « Annecy, France »).',
    'Réponds par UN objet JSON : { "cities": string[] } avec exactement 3 chaînes, sans la ville d’ancrage elle-même.',
  ].join('\n');
}

async function generateCampaignTradeCategoriesLive(config: AppConfig): Promise<string[]> {
  const apiKey = config.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new StrateRadarError('CONFIG', 'GROQ_API_KEY manquant en mode réel');
  }

  const groq = new Groq({ apiKey });
  const model = config.GROQ_MODEL;

  return withRetry(async () => {
    const completion = await groq.chat.completions.create({
      model,
      temperature: 0.35,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildCampaignCategoriesPrompt() },
        { role: 'user', content: 'Génère les 50 catégories au format JSON demandé.' },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new StrateRadarError('GROQ_EMPTY', 'Réponse Groq (catégories campagne) vide');
    }
    const list = parseLabeledStringArray(content, 'categories');
    const unique = [...new Set(list)];
    if (unique.length < 45 || unique.length > 55) {
      throw new StrateRadarError(
        'GROQ_CAMPAIGN',
        `Groq doit renvoyer entre 45 et 55 catégories uniques (reçu ${unique.length})`,
      );
    }
    return unique.slice(0, 50);
  });
}

async function suggestNeighborCitiesLive(config: AppConfig, anchorCity: string): Promise<string[]> {
  const apiKey = config.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new StrateRadarError('CONFIG', 'GROQ_API_KEY manquant en mode réel');
  }

  const groq = new Groq({ apiKey });
  const model = config.GROQ_MODEL;

  return withRetry(async () => {
    const completion = await groq.chat.completions.create({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Tu réponds uniquement par JSON valide selon les instructions utilisateur.' },
        { role: 'user', content: buildNeighborCitiesPrompt(anchorCity) },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new StrateRadarError('GROQ_EMPTY', 'Réponse Groq (villes limitrophes) vide');
    }
    const list = parseLabeledStringArray(content, 'cities');
    const normalizedAnchor = anchorCity.trim().toLowerCase();
    const uniq = [...new Set(list.map((c) => c.trim()).filter((c) => c.length > 0))].filter(
      (c) => c.toLowerCase() !== normalizedAnchor,
    );
    if (uniq.length < 3) {
      throw new StrateRadarError(
        'GROQ_CAMPAIGN',
        'Groq doit proposer au moins 3 villes distinctes de l’ancrage',
      );
    }
    return uniq.slice(0, 3);
  });
}

function parseSalesAnalysis(raw: string): SalesAnalysis {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(raw));
  } catch (e) {
    throw new StrateRadarError('GROQ_JSON', 'Réponse Groq non JSON', { cause: e });
  }
  const safe = salesAnalysisSchema.safeParse(parsed);
  if (!safe.success) {
    throw new StrateRadarError(
      'GROQ_PARSE',
      `JSON Groq invalide : ${safe.error.message}`,
      { cause: safe.error },
    );
  }
  return safe.data;
}

function buildSystemPrompt(input: ProspectForAnalysis): string {
  const lines = [
    'Tu es un stratège commercial senior pour Strate Studio (accompagnement web, SEO local, performance).',
    'Tu rédiges une analyse de vente concise en français, orientée rendez-vous qualifié.',
    'Tu dois répondre UNIQUEMENT par un objet JSON valide respectant exactement les clés demandées.',
    'Les scores performance/SEO/accessibilité sont sur une échelle 0–100 (plus bas = plus d’opportunité technique).',
    'priority : high si score perf < 50 ou absence criante de crédibilité digitale, medium sinon, low si déjà très solide.',
  ];

  if (input.siteLinkage === 'organic_discovery') {
    lines.push(
      '',
      'CAS SPÉCIAL (prioritaire) : l’URL du site n’était PAS renseignée sur la fiche Google Business / Maps ; elle a été identifiée via résultats organiques Google.',
      'Le prospect risque une DÉCONNEXION entre la promesse Maps et le site (perte de confiance, parcours brisé, appels / réservations qui partent ailleurs).',
      'Ton pitch doit mettre l’accent sur l’OPTIMISATION DE LA CONVERSION LOCALE : aligner Maps et site (message, offre, preuve, mobile), réduire la fuite de prospects entre découverte locale et action sur le site.',
      'Les pitchAngles doivent majoritairement porter sur cet alignement Maps ↔ site et la mesure des conversions (appels, itinéraires, formulaires), pas seulement sur la vitesse technique.',
    );
  }

  return lines.join('\n');
}

function buildUserPayload(input: ProspectForAnalysis): string {
  const validated = prospectForAnalysisSchema.parse(input);
  return [
    'Prospect à analyser (JSON) :',
    JSON.stringify(validated, null, 2),
    '',
    'Réponds avec ce schéma JSON strict :',
    '{',
    '  "executiveSummary": string,',
    '  "pitchAngles": string[],',
    '  "objectionHandling": string[],',
    '  "recommendedOpening": string,',
    '  "priority": "high" | "medium" | "low"',
    '}',
  ].join('\n');
}

async function analyzeLive(config: AppConfig, input: ProspectForAnalysis): Promise<SalesAnalysis> {
  const apiKey = config.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new StrateRadarError('CONFIG', 'GROQ_API_KEY manquant en mode réel');
  }

  const groq = new Groq({ apiKey });
  const model = config.GROQ_MODEL;

  return withRetry(async () => {
    const completion = await groq.chat.completions.create({
      model,
      temperature: 0.35,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildSystemPrompt(input) },
        { role: 'user', content: buildUserPayload(input) },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new StrateRadarError('GROQ_EMPTY', 'Réponse Groq vide');
    }
    return parseSalesAnalysis(content);
  });
}

export function createGroqClient(config: AppConfig): GroqClient {
  if (config.simulation) {
    return {
      async analyzeProspect(input: ProspectForAnalysis) {
        const v = prospectForAnalysisSchema.parse(input);
        const mock =
          v.siteLinkage === 'organic_discovery'
            ? MOCK_ORGANIC_MAPS_CONVERSION_ANALYSIS
            : MOCK_SALES_ANALYSIS;
        return salesAnalysisSchema.parse(structuredClone(mock));
      },
      async analyzeDiamondHunterPitch(_input: DiamondHunterInput) {
        return diamondHunterPitchSchema.parse(structuredClone(MOCK_DIAMOND_HUNTER_PITCH));
      },
      async analyzeConversionBrochure(_input: ConversionBrochureInput) {
        return conversionBrochureSchema.parse(structuredClone(MOCK_CONVERSION_BROCHURE));
      },
      async generateCampaignTradeCategories() {
        return Array.from({ length: 50 }, (_, i) => `sim_segment_prospect_${String(i + 1).padStart(2, '0')}`);
      },
      async suggestNeighborCities(anchorCity: string) {
        const a = anchorCity.trim().toLowerCase();
        const mock = [
          `Sim — couronne A de ${anchorCity}`,
          `Sim — couronne B de ${anchorCity}`,
          `Sim — couronne C de ${anchorCity}`,
        ];
        return mock.filter((c) => c.trim().toLowerCase() !== a).slice(0, 3);
      },
    };
  }

  return {
    analyzeProspect(input: ProspectForAnalysis) {
      return analyzeLive(config, input);
    },
    analyzeDiamondHunterPitch(input: DiamondHunterInput) {
      return analyzeDiamondLive(config, input);
    },
    analyzeConversionBrochure(input: ConversionBrochureInput) {
      return analyzeConversionBrochureLive(config, input);
    },
    generateCampaignTradeCategories() {
      return generateCampaignTradeCategoriesLive(config);
    },
    suggestNeighborCities(anchorCity: string) {
      return suggestNeighborCitiesLive(config, anchorCity);
    },
  };
}
