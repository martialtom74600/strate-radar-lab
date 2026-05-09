import Groq from 'groq-sdk';

import type { AppConfig } from '../../config/index.js';
import { StrateRadarError } from '../../lib/errors.js';
import { withRetry } from '../../lib/retry.js';
import {
  type ConversionBrochureAnalysis,
  type ConversionBrochureInput,
} from './diamond-schemas.js';
import { MOCK_CONVERSION_BROCHURE } from './mock-data.js';

export type GroqClient = {
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

function parseConversionBrochure(parsed: unknown): ConversionBrochureAnalysis {
  if (!parsed || typeof parsed !== 'object') {
    throw new StrateRadarError('GROQ_CONVERSION_PARSE', 'JSON conversion : objet attendu.');
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.deadBrochureSite !== 'boolean') {
    throw new StrateRadarError('GROQ_CONVERSION_PARSE', 'deadBrochureSite boolean attendu.');
  }
  if (typeof o.briefReason !== 'string' || o.briefReason.trim().length < 1) {
    throw new StrateRadarError('GROQ_CONVERSION_PARSE', 'briefReason non vide attendu.');
  }
  return { deadBrochureSite: o.deadBrochureSite, briefReason: o.briefReason.trim() };
}

function parseConversionBrochureFromContent(raw: string): ConversionBrochureAnalysis {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(raw));
  } catch (e) {
    throw new StrateRadarError('GROQ_JSON', 'Réponse Groq conversion non JSON', { cause: e });
  }
  return parseConversionBrochure(parsed);
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
    return parseConversionBrochureFromContent(content);
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
        {
          role: 'system',
          content: 'Tu réponds uniquement par JSON valide selon les instructions utilisateur.',
        },
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

export function createGroqClient(config: AppConfig): GroqClient {
  if (config.simulation) {
    return {
      async analyzeConversionBrochure(_input: ConversionBrochureInput) {
        return structuredClone(MOCK_CONVERSION_BROCHURE);
      },
      async generateCampaignTradeCategories() {
        return Array.from({ length: 50 }, (_, i) =>
          `sim_segment_prospect_${String(i + 1).padStart(2, '0')}`,
        );
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
