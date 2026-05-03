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
  };
}
