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

const MAPS_TITLE_PREFILTER_MARKERS = [
  'mairie',
  'commissariat',
  'la poste',
  'gare',
] as const;

/**
 * Préfiltre gratuit sur le nom Maps — avant Place Details / Groq / cascade web.
 */
export function isMapsListingTitlePrefilterExcluded(serp: SerpLocalResult): string | null {
  if (isParkingInfrastructureSerp(serp)) {
    return 'Parking / stationnement (nom ou catégorie Maps) — hors cible commerciale.';
  }
  const hay = normalizeGatekeeperText(serp.title);
  for (const marker of MAPS_TITLE_PREFILTER_MARKERS) {
    if (hay.includes(marker)) {
      const label =
        marker === 'la poste'
          ? 'La Poste'
          : marker.charAt(0).toUpperCase() + marker.slice(1);
      return `${label} (nom Maps) — hors cible commerciale.`;
    }
  }
  return null;
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
    'Est-ce une entreprise privée cherchant activement des clients (Artisan, Garage, Cabinet, Agence, Restaurant, etc.)',
    'ou une entité publique/institutionnelle (Hôpital public, Parking municipal, Mairie, Église, École, Commissariat) ?',
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

const PREFLIGHT_GROQ_RATE_LIMIT_COOLDOWN_MS = 1500;

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
  return [
    'Tu es un filtre ultra-rapide pour une agence web B2B en France.',
    'Réponds UNIQUEMENT par un JSON strict : { "isCommercialTarget": boolean, "reason": string }.',
    'reason : une courte phrase en français (max 120 caractères).',
  ].join('\n');
}

function buildPreflightUserContent(
  title: string,
  primaryCategory: string,
  localityLabel: string,
): string {
  return [
    `Établissement : « ${title} »`,
    `Catégorie Google Maps principale : ${primaryCategory}`,
    `Zone : ${localityLabel}, France`,
    '',
    `Analyse si cet établissement de ${localityLabel} est une entreprise privée commerciale (PME, artisan, commerçant, profession libérale) pertinente pour lui vendre la création ou la refonte d'un site web.`,
    'Réponds isCommercialTarget FALSE s\'il s\'agit d\'une entité publique, administration, école, hôpital, grande multinationale (FNAC, Orange, SFR, Carrefour…), parking, ou association non lucrative.',
    'Réponds isCommercialTarget TRUE pour un commerce ou service privé local typique.',
  ].join('\n');
}

async function assessPreflightWithGroq(
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
