/**
 * Filtre sémantique « prospect commercial » vs entité publique / institutionnelle (Groq).
 */

import Groq, { RateLimitError } from 'groq-sdk';

import type { AppConfig } from '../config/index.js';
import type { SerpLocalResult } from '../services/serp/schemas.js';
import { StrateRadarError } from './errors.js';
import { withRetry } from './retry.js';

export type CommercialGateAssessment = {
  readonly isCommercial: boolean;
  readonly reason: string;
  /** True si la validation vient du price_level Google (sans appel IA). */
  readonly priceBypass: boolean;
};

export type PreflightGateAssessment = {
  readonly isCommercialTarget: boolean;
  readonly reason: string;
  /** True si Groq indisponible — fiche laissée passer par défaut. */
  readonly fallbackUsed: boolean;
};

function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(trimmed);
  if (fence?.[1]) return fence[1].trim();
  return trimmed;
}

function parseGatekeeperJson(raw: string): { readonly is_commercial: boolean; readonly reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(raw));
  } catch (e) {
    throw new StrateRadarError('GROQ_JSON', 'Réponse Gatekeeper non JSON', { cause: e });
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new StrateRadarError('GROQ_GATEKEEPER_PARSE', 'JSON Gatekeeper invalide : objet attendu.');
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.is_commercial !== 'boolean') {
    throw new StrateRadarError(
      'GROQ_GATEKEEPER_PARSE',
      'JSON Gatekeeper invalide : is_commercial boolean attendu.',
    );
  }
  if (typeof o.reason !== 'string') {
    throw new StrateRadarError('GROQ_GATEKEEPER_PARSE', 'JSON Gatekeeper invalide : reason string attendu.');
  }
  return { is_commercial: o.is_commercial, reason: o.reason };
}

function parsePreflightGateJson(raw: string): {
  readonly isCommercialTarget: boolean;
  readonly reason: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(raw));
  } catch (e) {
    throw new StrateRadarError('GROQ_JSON', 'Réponse pre-flight Gatekeeper non JSON', { cause: e });
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new StrateRadarError('GROQ_PREFLIGHT_PARSE', 'JSON pre-flight invalide : objet attendu.');
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.isCommercialTarget !== 'boolean') {
    throw new StrateRadarError(
      'GROQ_PREFLIGHT_PARSE',
      'JSON pre-flight invalide : isCommercialTarget boolean attendu.',
    );
  }
  if (typeof o.reason !== 'string') {
    throw new StrateRadarError(
      'GROQ_PREFLIGHT_PARSE',
      'JSON pre-flight invalide : reason string attendu.',
    );
  }
  return {
    isCommercialTarget: o.isCommercialTarget,
    reason: o.reason.trim() || '(aucune raison fournie)',
  };
}

function normalizeGatekeeperText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

/**
 * Parkings / stationnements : jamais des prospects création/refonte site pour une agence.
 * Filtre dur avant bypass prix et avant Groq.
 */
export function isParkingInfrastructureSerp(serp: SerpLocalResult): boolean {
  const titleHay = normalizeGatekeeperText(serp.title);
  if (titleHay.includes('parking') || titleHay.includes('stationnement')) {
    return true;
  }
  const primary = (serp.type ?? '').trim().toLowerCase();
  return primary === 'parking' || primary === 'parking_lot';
}

/** Raison standard pre-flight / préfiltre — entités collectives ou événementielles. */
export const PREFLIGHT_COLLECTIVE_EXCLUSION_REASON =
  'Entité collective ou marché public — hors cible pour un site vitrine unitaire.';

const MAPS_TITLE_INSTITUTIONAL_MARKERS = [
  'mairie',
  'hotel de ville',
  'commissariat',
  'la poste',
  'gare',
  'finances publiques',
  'france services',
  'espace france services',
  'pole emploi',
  'impots ',
  'impots.',
  'impots,',
] as const;

/** Marchés, foires, halles collaboratives, regroupements multi-artisans. */
const MAPS_TITLE_COLLECTIVE_MARKERS = [
  'marche couvert',
  'marche hebdomadaire',
  'marche hebdo',
  'marche public',
  'marche municipal',
  'marche de noel',
  'halles de',
  'halle de',
  'foire de',
  'foire du',
  'foire aux',
  'brocante de',
  'brocante du',
  'regroupement des artisans',
  'regroupement d artisans',
  'groupement d artisans',
  'collectif d artisans',
  'pôle artisans',
  'pole artisans',
  'atelier partage',
  'atelier partagé',
] as const;

/** Sites institutionnels, lieux-dits touristiques, réseaux nationaux (sans appel Groq). */
const MAPS_TITLE_NON_COMMERCIAL_MARKERS = [
  'ville.fr',
  '-ville.fr',
  'office de tourisme',
  'city tour',
  'visite guid',
  'parc animalier',
  'jardins de l',
  'jardin public',
  'station service',
  'station-service',
  'boutique sfr',
  ' sfr ',
  ' sixt',
  'sixt ',
  'tui store',
  ' tui ',
  'mobilboard',
  'union financiere de france',
  ' uff ',
  'uff -',
  'centre services',
  'lockin',
  'consigne bagages',
  'water taxi',
  'lounge boat',
  'residence services',
  'ehpad',
  'maison de retraite',
  'service radiologie',
  'radiologie de la clinique',
] as const;

/** Catégories Google Maps — hors cible commerciale unitaire (primary type ou types secondaires). */
const MAPS_NON_COMMERCIAL_PRIMARY_TYPES = new Set([
  'local_government_office',
  'city_hall',
  'government_office',
  'courthouse',
  'embassy',
  'police',
  'fire_station',
  'post_office',
  'school',
  'primary_school',
  'secondary_school',
  'university',
  'library',
  'hospital',
  'park',
  'national_park',
  'tourist_information_center',
  'transit_station',
  'bus_station',
  'train_station',
  'subway_station',
  'light_rail_station',
  'airport',
  'zoo',
  'amusement_park',
  'aquarium',
  'museum',
  'cemetery',
  'church',
  'hindu_temple',
  'mosque',
  'synagogue',
  'place_of_worship',
  'gas_station',
  'parking',
  'parking_lot',
  'stadium',
  'convention_center',
]);

const MAPS_NON_COMMERCIAL_SECONDARY_TYPES = new Set(['tourist_attraction']);

function collectNormalizedMapsTypes(serp: SerpLocalResult): string[] {
  const out = new Set<string>();
  const primary = serp.type?.trim().toLowerCase();
  if (primary) out.add(primary);
  for (const t of serp.types ?? []) {
    const s = t.trim().toLowerCase();
    if (s) out.add(s);
  }
  return [...out];
}

function isMapsCityInstitutionalWebsiteTitle(hay: string): boolean {
  return hay.includes('ville.fr') || /-ville\.fr\b/.test(hay);
}

function isMapsLandmarkTitle(hay: string, types: readonly string[]): boolean {
  if (types.includes('tourist_attraction') || types.includes('park')) {
    if (/^pont\b/.test(hay) || hay.includes(' pont des ') || hay.startsWith('pont des ')) {
      return true;
    }
    if (hay.includes('belvedere') || hay.includes('promenade du') || hay.includes('esplanade')) {
      return true;
    }
  }
  return false;
}

/**
 * Préfiltre gratuit sur le nom Maps — avant Place Details / Groq / cascade web.
 */
export function isMapsListingTitlePrefilterExcluded(serp: SerpLocalResult): string | null {
  if (isParkingInfrastructureSerp(serp)) {
    return 'Parking / stationnement (nom ou catégorie Maps) — hors cible commerciale.';
  }
  const hay = normalizeGatekeeperText(serp.title);
  const types = collectNormalizedMapsTypes(serp);

  if (isMapsCityInstitutionalWebsiteTitle(hay)) {
    return 'Site institutionnel municipal (nom Maps) — hors cible commerciale.';
  }
  if (isMapsLandmarkTitle(hay, types)) {
    return 'Lieu touristique / monument (nom + catégorie Maps) — hors cible commerciale.';
  }

  for (const marker of MAPS_TITLE_COLLECTIVE_MARKERS) {
    if (hay.includes(marker)) {
      return PREFLIGHT_COLLECTIVE_EXCLUSION_REASON;
    }
  }
  for (const marker of MAPS_TITLE_INSTITUTIONAL_MARKERS) {
    if (hay.includes(marker)) {
      const label =
        marker === 'la poste'
          ? 'La Poste'
          : marker === 'hotel de ville'
            ? 'Hôtel de ville'
            : marker.charAt(0).toUpperCase() + marker.slice(1);
      return `${label} (nom Maps) — hors cible commerciale.`;
    }
  }
  for (const marker of MAPS_TITLE_NON_COMMERCIAL_MARKERS) {
    if (hay.includes(marker)) {
      return 'Entité publique, réseau ou infrastructure (nom Maps) — hors cible commerciale.';
    }
  }
  return null;
}

/** Préfiltre sur catégories Google Maps (primary + types). */
export function isMapsListingCategoryPrefilterExcluded(serp: SerpLocalResult): string | null {
  if (hasPriceLevelCommercialSignal(serp)) {
    return null;
  }
  const types = collectNormalizedMapsTypes(serp);
  if (types.length === 0) {
    return null;
  }
  const primary = serp.type?.trim().toLowerCase();
  if (primary && MAPS_NON_COMMERCIAL_PRIMARY_TYPES.has(primary)) {
    return `Catégorie Maps « ${serp.type!.trim()} » — hors cible commerciale.`;
  }
  for (const t of types) {
    if (MAPS_NON_COMMERCIAL_SECONDARY_TYPES.has(t)) {
      return `Catégorie Maps « ${t} » — hors cible commerciale.`;
    }
  }
  return null;
}

/** Préfiltre titre + catégorie Maps — avant Place Details / Groq / cascade web. */
export function isMapsListingPrefilterExcluded(serp: SerpLocalResult): string | null {
  return isMapsListingTitlePrefilterExcluded(serp) ?? isMapsListingCategoryPrefilterExcluded(serp);
}

/** Niveau de prix Maps renseigné (€, €€…) → signal fort de commerce (pas d’appel Groq). */
export function hasPriceLevelCommercialSignal(serp: SerpLocalResult): boolean {
  return Boolean(serp.price?.trim());
}

function buildGatekeeperSystemPrompt(): string {
  return [
    'Tu es un filtre commercial pour une agence web B2B.',
    'Tu distingues une entreprise privée qui cherche des clients d’une entité publique, associative pure, ou infrastructure sans modèle de vente directe.',
    'Réponds uniquement par un objet JSON avec les clés exactes is_commercial (boolean) et reason (string, une courte phrase en français).',
  ].join('\n');
}

function buildGatekeeperUserContent(name: string, typesLabel: string): string {
  return [
    `Analyse cette entité : ${name} (Types Google: ${typesLabel}).`,
    'Est-ce une entreprise privée unitaire cherchant activement des clients (Artisan, Garage, Cabinet, Restaurant, etc.)',
    'ou une entité à exclure : publique/institutionnelle (Hôpital, Mairie, École…), marché public, foire, regroupement d\'artisans collectif, événement temporaire, parking, multinationale ?',
    'Réponds par un JSON : { "is_commercial": boolean, "reason": string }.',
  ].join(' ');
}

async function assessWithGroq(
  config: AppConfig,
  name: string,
  typesList: string[],
): Promise<Omit<CommercialGateAssessment, 'priceBypass'>> {
  const apiKey = config.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new StrateRadarError('CONFIG', 'GROQ_API_KEY manquant en mode réel');
  }
  const typesLabel = typesList.length > 0 ? typesList.join(', ') : '(aucun type Google listé)';
  const groq = new Groq({ apiKey });
  const model = config.GROQ_MODEL;

  return withRetry(async () => {
    const completion = await groq.chat.completions.create({
      model,
      temperature: 0.15,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildGatekeeperSystemPrompt() },
        { role: 'user', content: buildGatekeeperUserContent(name, typesLabel) },
      ],
    });
    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new StrateRadarError('GROQ_EMPTY', 'Réponse Gatekeeper vide');
    }
    const parsed = parseGatekeeperJson(content);
    return {
      isCommercial: parsed.is_commercial,
      reason: parsed.reason.trim() || '(aucune raison fournie)',
    };
  });
}

function primaryLocalityLabel(locationHint: string): string {
  const first = locationHint.split(',')[0]?.trim() ?? locationHint.trim();
  return first.length > 0 ? first : 'la zone cible';
}

const PREFLIGHT_GROQ_RATE_LIMIT_COOLDOWN_MS = 3_000;
const PREFLIGHT_GROQ_MIN_INTERVAL_MS = 350;
const PREFLIGHT_GROQ_TIMEOUT_RETRY_DELAY_MS = 400;

let preflightGroqQueue: Promise<void> = Promise.resolve();
let preflightGroqLastStartedAt = 0;

function schedulePreflightGroqCall<T>(fn: () => Promise<T>): Promise<T> {
  const run = preflightGroqQueue.then(async () => {
    const waitMs = Math.max(
      0,
      PREFLIGHT_GROQ_MIN_INTERVAL_MS - (Date.now() - preflightGroqLastStartedAt),
    );
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    preflightGroqLastStartedAt = Date.now();
  }).then(fn);
  preflightGroqQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function isGroqPreflightRateLimitError(err: unknown): boolean {
  if (err instanceof RateLimitError) return true;
  if (err instanceof StrateRadarError && err.status === 429) return true;
  const status = (err as { status?: number }).status;
  if (status === 429) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b|rate.?limit|too many requests/i.test(msg);
}

function preflightGroqRateLimitCooldown(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, PREFLIGHT_GROQ_RATE_LIMIT_COOLDOWN_MS));
}

function buildPreflightSystemPrompt(): string {
  const collectiveReason = PREFLIGHT_COLLECTIVE_EXCLUSION_REASON;
  return [
    'Filtre pre-flight agence web B2B (France). JSON strict : { "isCommercialTarget": boolean, "reason": string }.',
    'TRUE = une seule enseigne/entreprise unitaire (artisan, commerçant, PME, pro libérale) — site vitrine pertinent.',
    'FALSE = collectif/multi-vendeurs/événementiel, public, monument, parc, réseau national (SFR, Sixt, TUI, Eni…), parking.',
    `Si collectif/marché/foire : reason exacte « ${collectiveReason} ».`,
    'reason : français, max 120 caractères.',
  ].join('\n');
}

function buildPreflightUserContent(
  title: string,
  primaryCategory: string,
  localityLabel: string,
): string {
  const collectiveReason = PREFLIGHT_COLLECTIVE_EXCLUSION_REASON;
  return [
    `« ${title} » · catégorie : ${primaryCategory} · ${localityLabel}, France`,
    'Entité unitaire pour un site vitrine ?',
    `Ex. FALSE marché : { "isCommercialTarget": false, "reason": "${collectiveReason}" }`,
    'Ex. TRUE plombier local : { "isCommercialTarget": true, "reason": "Artisan local unitaire." }',
  ].join('\n');
}

async function assessPreflightWithGroqOnce(
  config: AppConfig,
  title: string,
  primaryCategory: string,
  localityLabel: string,
): Promise<Omit<PreflightGateAssessment, 'fallbackUsed'>> {
  const apiKey = config.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new StrateRadarError('CONFIG', 'GROQ_API_KEY manquant en mode réel');
  }

  const groq = new Groq({ apiKey });
  const timeoutMs = config.GROQ_PREFLIGHT_TIMEOUT_MS;

  const completion = await Promise.race([
    groq.chat.completions.create({
      model: config.GROQ_PREFLIGHT_MODEL,
      temperature: 0,
      max_tokens: 96,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildPreflightSystemPrompt() },
        {
          role: 'user',
          content: buildPreflightUserContent(title, primaryCategory, localityLabel),
        },
      ],
    }),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new StrateRadarError('GROQ_PREFLIGHT_TIMEOUT', `Pre-flight Groq > ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]);

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new StrateRadarError('GROQ_EMPTY', 'Réponse pre-flight Gatekeeper vide');
  }
  const parsed = parsePreflightGateJson(content);
  return {
    isCommercialTarget: parsed.isCommercialTarget,
    reason: parsed.reason,
  };
}

async function assessPreflightWithGroq(
  config: AppConfig,
  title: string,
  primaryCategory: string,
  localityLabel: string,
): Promise<Omit<PreflightGateAssessment, 'fallbackUsed'>> {
  return schedulePreflightGroqCall(async () => {
    try {
      return await assessPreflightWithGroqOnce(config, title, primaryCategory, localityLabel);
    } catch (e) {
      if (e instanceof StrateRadarError && e.code === 'GROQ_PREFLIGHT_TIMEOUT') {
        await new Promise((resolve) => setTimeout(resolve, PREFLIGHT_GROQ_TIMEOUT_RETRY_DELAY_MS));
        return assessPreflightWithGroqOnce(config, title, primaryCategory, localityLabel);
      }
      throw e;
    }
  });
}

/**
 * Pre-flight IA (Groq 8B) — après préfiltre textuel, avant Place Details / cascade web.
 * En cas d'erreur Groq : pass-through (isCommercialTarget true, fallbackUsed true).
 */
export async function assessPreflightCommercialTarget(
  config: AppConfig,
  serp: SerpLocalResult,
  locationHint: string,
): Promise<PreflightGateAssessment> {
  if (config.simulation) {
    return {
      isCommercialTarget: true,
      reason: 'Mode simulation — pre-flight Groq non exécuté.',
      fallbackUsed: false,
    };
  }

  if (hasPriceLevelCommercialSignal(serp)) {
    return {
      isCommercialTarget: true,
      reason: 'Signal Google price_level (€ / gamme) — pre-flight IA ignoré.',
      fallbackUsed: false,
    };
  }

  const title = serp.title.trim() || 'Établissement';
  const types = collectGatekeeperTypes(serp);
  const primaryCategory =
    serp.type?.trim() || types[0]?.trim() || '(catégorie Maps non renseignée)';
  const localityLabel = primaryLocalityLabel(locationHint);

  const categoryPrefilter = isMapsListingCategoryPrefilterExcluded(serp);
  if (categoryPrefilter !== null) {
    return {
      isCommercialTarget: false,
      reason: categoryPrefilter,
      fallbackUsed: false,
    };
  }

  try {
    const r = await assessPreflightWithGroq(config, title, primaryCategory, localityLabel);
    return { ...r, fallbackUsed: false };
  } catch (e) {
    if (isGroqPreflightRateLimitError(e)) {
      await preflightGroqRateLimitCooldown();
    }
    const msg = e instanceof Error ? e.message : String(e);
    const rateNote = isGroqPreflightRateLimitError(e)
      ? ` · pause ${PREFLIGHT_GROQ_RATE_LIMIT_COOLDOWN_MS}ms`
      : '';
    return {
      isCommercialTarget: true,
      reason: `Pre-flight Groq indisponible (${msg.slice(0, 100)}) — fiche conservée${rateNote}.`,
      fallbackUsed: true,
    };
  }
}

/**
 * Évalue si l’entité est un prospect commercial (avec bypass `price` Maps si présent).
 * En simulation : pas d’appel Groq, toujours commercial.
 */
export async function assessCommercialProspect(
  config: AppConfig,
  serp: SerpLocalResult,
  types: readonly string[],
  nameForPrompt?: string,
): Promise<CommercialGateAssessment> {
  if (isParkingInfrastructureSerp(serp)) {
    return {
      isCommercial: false,
      reason: 'Parking / stationnement (nom ou catégorie Maps) — hors cible commerciale.',
      priceBypass: false,
    };
  }

  if (hasPriceLevelCommercialSignal(serp)) {
    return {
      isCommercial: true,
      reason: 'Signal Google price_level (€ / gamme) — prospect traité comme commercial sans IA.',
      priceBypass: true,
    };
  }

  if (config.simulation) {
    return {
      isCommercial: true,
      reason: 'Mode simulation — Gatekeeper Groq non exécuté.',
      priceBypass: false,
    };
  }

  const name =
    (nameForPrompt !== undefined && nameForPrompt.trim() !== ''
      ? nameForPrompt.trim()
      : serp.title.trim()) || 'Établissement';
  const list = [...types].map((t) => t.trim()).filter((t) => t.length > 0);

  try {
    const r = await assessWithGroq(config, name, list);
    return { ...r, priceBypass: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      isCommercial: true,
      reason: `Erreur Gatekeeper (${msg.slice(0, 120)}) — inclus par prudence.`,
      priceBypass: false,
    };
  }
}

/** Types Google secondaires + primaryType pour le prompt Gatekeeper. */
export function collectGatekeeperTypes(serp: SerpLocalResult): string[] {
  const out = new Set<string>();
  for (const t of serp.types ?? []) {
    const s = t.trim();
    if (s) out.add(s);
  }
  if (serp.type?.trim()) out.add(serp.type.trim());
  return [...out];
}

/** Variante API explicite (nom + types) — le bypass prix lit toujours `serp.price`. */
export async function isCommercialProspect(
  name: string,
  types: string[],
  config: AppConfig,
  serp: SerpLocalResult,
): Promise<boolean> {
  const assessment = await assessCommercialProspect(config, serp, types, name);
  return assessment.isCommercial;
}
