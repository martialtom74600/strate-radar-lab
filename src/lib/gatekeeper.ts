/**
 * Filtre sémantique « prospect commercial » vs entité publique / institutionnelle (Groq).
 */

import Groq from 'groq-sdk';
import { z } from 'zod';

import type { AppConfig } from '../config/index.js';
import type { SerpLocalResult } from '../services/serp/schemas.js';
import { StrateRadarError } from './errors.js';
import { withRetry } from './retry.js';

const gatekeeperJsonSchema = z.object({
  is_commercial: z.boolean(),
  reason: z.string(),
});

export type CommercialGateAssessment = {
  readonly isCommercial: boolean;
  readonly reason: string;
  /** True si la validation vient du price_level Google (sans appel IA). */
  readonly priceBypass: boolean;
};

function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(trimmed);
  if (fence?.[1]) return fence[1].trim();
  return trimmed;
}

function parseGatekeeperJson(raw: string): z.infer<typeof gatekeeperJsonSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(raw));
  } catch (e) {
    throw new StrateRadarError('GROQ_JSON', 'Réponse Gatekeeper non JSON', { cause: e });
  }
  const safe = gatekeeperJsonSchema.safeParse(parsed);
  if (!safe.success) {
    throw new StrateRadarError('GROQ_GATEKEEPER_PARSE', `JSON Gatekeeper invalide : ${safe.error.message}`, {
      cause: safe.error,
    });
  }
  return safe.data;
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

async function assessWithGroq(config: AppConfig, name: string, typesList: string[]): Promise<Omit<CommercialGateAssessment, 'priceBypass'>> {
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
