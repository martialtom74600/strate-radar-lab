import Groq from 'groq-sdk';

import type { AppConfig } from '../../config/index.js';
import { StrateRadarError } from '../../lib/errors.js';
import { withRetry } from '../../lib/retry.js';
import {
  type ConversionBrochureAnalysis,
  type ConversionBrochureInput,
} from './diamond-schemas.js';
import type { DiamondGrowthLeversInput, DiamondGrowthLeversResult } from './growth-lever-schemas.js';
import { MOCK_CONVERSION_BROCHURE } from './mock-data.js';

export type GroqClientOptions = {
  /** Compteur partagé radar : un slot consommé avant l’appel `generateDiamondGrowthLevers`. */
  readonly groqPipelineCallBudget?: { used: number; max: number };
};

export type GroqClient = {
  readonly analyzeConversionBrochure: (
    input: ConversionBrochureInput,
  ) => Promise<ConversionBrochureAnalysis>;
  /** ~50 libellés courts de métiers / segments à fort ROI pour prospection Maps (FR). */
  readonly generateCampaignTradeCategories: () => Promise<string[]>;
  /** 3 villes limitrophes ou cohérentes commercialement avec l’ancrage (noms complets, France). */
  readonly suggestNeighborCities: (anchorCity: string) => Promise<string[]>;
  readonly generateDiamondGrowthLevers: (
    input: DiamondGrowthLeversInput,
  ) => Promise<DiamondGrowthLeversResult>;
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

const MAX_WORDS_PER_LEVER_IDEA = 12;

function truncateIdeaToMaxWords(line: string, maxWords: number): string {
  const parts = line.trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, maxWords).join(' ');
}

function buildDiamondGrowthSystemPrompt(): string {
  return [
    'Tu es consultant web pour petits commerces locaux France (pas de jargon technique AWS, SEO jargon, CMS).',
    'Tu rédiges uniquement une réponse JSON stricte (aucun texte hors JSON).',
    '',
    'Protocole d’analyse (obligatoire) :',
    '1) Filtre anti-générique : lis les avis clients fournis. Ignore totalement les compliments génériques (ex. super déco, très bon accueil sans détail exploitable).',
    'Ne cherche que les frictions opérationnelles concrètes.',
    '2) Détection : traque les plaintes que le DIGITAL peut aider à résoudre (ex : attente / queue → mise en avant click & collect ; téléphone inaccessible → réservation ou prise de contact en ligne).',
    '3) Format de sortie : propose exactement 3 leviers de croissance DIGITAUX très concrets, actionnables via un site web (pas forcément “création site depuis zéro” si hors sujet ; focus actions web).',
    'Chaque levier doit rester lisible sans jargon technique, ≤ 12 mots (français).',
    '4) Fallback : si aucun avis n’est disponible OU aucun extrait exploitable après filtre, base les 3 leviers sur des standards digitaux pertinents pour le code NAF / métier communiqués (pas d’hallucinations sur données manquantes : reste prudent).',
    '',
    'Réponds avec EXACTEMENT un objet JSON : { "ideas": string[] } contenant précisément 3 chaînes.',
  ].join('\n');
}

function buildDiamondGrowthUserPayload(input: DiamondGrowthLeversInput): string {
  const frictionBlock =
    input.technicalFrictionLines.length > 0
      ? input.technicalFrictionLines.map((x, i) => `   ${i + 1}. ${x}`).join('\n')
      : '   (aucune dette résumée depuis la matrice — chemin création ou matrice vide.)';

  const avisLines =
    input.reviewTexts.length > 0
      ? input.reviewTexts.map((t, i) => `--- Avis ${i + 1} ---\n${t}`).join('\n\n')
      : '(aucun extrait d’avis disponible)';

  return [
    `# Contexte prospect`,
    `Nom commerce : ${input.businessName}`,
    `Type activité Maps / métier libellé : ${input.activityLabel ?? 'non renseigné'}`,
    `Adresse Maps : ${input.address ?? 'non renseignée'}`,
    `Note Google (nb avis agrégés) : ${input.googleRating !== null ? input.googleRating : '—'} (${input.googleReviewCount !== null ? input.googleReviewCount : '—'} avis agrégés)`,
    '',
    `# Registre (si disponible — confiance utilisateur uniquement ces champs)`,
    `Code NAF officiel match : ${input.nafCode ?? 'non communiqué'}`,
    `Libellé / résumé NAF officiel : ${input.nafResume ?? 'non communiqué'}`,
    '',
    `# Situation site actuel`,
    input.siteSituation,
    '',
    `# Signaux ou dettes depuis notre grille d’audit (matrice Strate, extraits lisibles)`,
    frictionBlock,
    '',
    `# Textes clients Google Places (≤10 derniers récupérés, bruts)`,
    avisLines,
    '',
    'Réponds par : {"ideas":["...","...","..."]}',
  ].join('\n');
}

function parseDiamondGrowthLeversResult(rawContent: string): DiamondGrowthLeversResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(rawContent));
  } catch (e) {
    throw new StrateRadarError('GROQ_GROWTH_JSON', 'Réponse Groq levier croissance non JSON', { cause: e });
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new StrateRadarError('GROQ_GROWTH_PARSE', 'Leviers : objet racine JSON attendu');
  }
  const ideasUnknown = (parsed as Record<string, unknown>).ideas;
  if (!Array.isArray(ideasUnknown)) {
    throw new StrateRadarError('GROQ_GROWTH_PARSE', 'Leviers JSON : tableau « ideas » requis.');
  }
  const ideas = ideasUnknown
    .filter((x): x is string => typeof x === 'string')
    .map((s) => truncateIdeaToMaxWords(s, MAX_WORDS_PER_LEVER_IDEA))
    .filter((s) => s.length > 2);
  if (ideas.length < 3) {
    throw new StrateRadarError('GROQ_GROWTH_PARSE', 'Leviers : attends exactement 3 idées');
  }
  return { ideas: ideas.slice(0, 3) };
}

async function generateDiamondGrowthLeversLive(
  config: AppConfig,
  budgetSlot: GroqClientOptions['groqPipelineCallBudget'],
  input: DiamondGrowthLeversInput,
): Promise<DiamondGrowthLeversResult> {
  if (budgetSlot !== undefined && budgetSlot.used >= budgetSlot.max) {
    return { ideas: [] };
  }
  const apiKey = config.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new StrateRadarError('CONFIG', 'GROQ_API_KEY manquant en mode réel');
  }

  const groq = new Groq({ apiKey });
  const model = config.GROQ_MODEL;

  if (budgetSlot !== undefined) budgetSlot.used += 1;

  return withRetry(
    async () => {
      const completion = await groq.chat.completions.create({
        model,
        temperature: 0.35,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: buildDiamondGrowthSystemPrompt() },
          { role: 'user', content: buildDiamondGrowthUserPayload(input) },
        ],
      });
      const content = completion.choices[0]?.message?.content;
      if (!content) {
        throw new StrateRadarError('GROQ_EMPTY', 'Réponse Groq leviers croissance vide');
      }
      return parseDiamondGrowthLeversResult(content);
    },
    { maxAttempts: 1 },
  );
}

export function createGroqClient(config: AppConfig, options?: GroqClientOptions): GroqClient {
  if (config.simulation) {
    const groqBudget = options?.groqPipelineCallBudget;
    return {
      async analyzeConversionBrochure(_input: ConversionBrochureInput) {
        return structuredClone(MOCK_CONVERSION_BROCHURE);
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
      async generateDiamondGrowthLevers(input: DiamondGrowthLeversInput): Promise<DiamondGrowthLeversResult> {
        if (groqBudget !== undefined && groqBudget.used >= groqBudget.max) {
          return { ideas: [] };
        }
        if (groqBudget !== undefined) groqBudget.used += 1;
        const biz = truncateIdeaToMaxWords(`Sim ligne ${input.businessName} : téléphone évident en ligne`, MAX_WORDS_PER_LEVER_IDEA);
        const avis = truncateIdeaToMaxWords(`Sim éviter files : click & collect quand (${input.reviewTexts.length}) avis lus Maps`, MAX_WORDS_PER_LEVER_IDEA);
        const naf = truncateIdeaToMaxWords(
          input.nafCode
            ? `Sim métier (${input.nafCode}) lisible avec horaires fermés téléphone évité`
            : 'Sim prendre RDV web si réception saturée cite avis.',
          MAX_WORDS_PER_LEVER_IDEA,
        );
        return { ideas: [biz, avis, naf] };
      },
    };
  }

  const slot = options?.groqPipelineCallBudget;
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
    generateDiamondGrowthLevers(input: DiamondGrowthLeversInput) {
      return generateDiamondGrowthLeversLive(config, slot, input);
    },
  };
}
