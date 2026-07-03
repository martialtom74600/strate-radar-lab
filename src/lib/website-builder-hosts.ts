/**
 * Hébergeurs site vitrine (sous-domaines) — pas des réseaux nationaux / franchises.
 * corporate_parent interdit ; traiter comme site propre si le contenu confirme le commerce.
 */

import { getRegistrableDomain, hostnameFromUrl } from './host-presence.js';

/** Domaines enregistrables d'hébergeurs grand public (sous-domaines inclus). */
export const WEBSITE_BUILDER_REGISTRABLE_DOMAINS = [
  'webnode.fr',
  'webnode.com',
  'wixsite.com',
  'wix.com',
  'jimdosite.com',
  'jimdofree.com',
  'wordpress.com',
  'blogspot.com',
  'squarespace.com',
  'canva.site',
  'strikingly.com',
  'site123.me',
  'carrd.co',
] as const;

const BUILDER_SET = new Set<string>(WEBSITE_BUILDER_REGISTRABLE_DOMAINS);

export function isWebsiteBuilderRegistrable(registrable: string): boolean {
  const host = registrable.toLowerCase().replace(/^www\./, '');
  return BUILDER_SET.has(host);
}

export function isWebsiteBuilderUrl(raw: string): boolean {
  const host = hostnameFromUrl(raw);
  if (!host) return false;
  const registrable = getRegistrableDomain(host);
  return registrable !== null && isWebsiteBuilderRegistrable(registrable);
}
