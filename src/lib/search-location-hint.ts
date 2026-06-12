/** Extrait une zone « ville, France » depuis une adresse complète ou un hint pipeline. */
export function cityHintFromSearchLocation(
  searchLocation: string | null | undefined,
  fallback: string,
): string {
  const raw = searchLocation?.trim();
  if (!raw) return fallback.trim() || 'France';

  if (/,\s*france\s*$/i.test(raw)) {
    const city = raw.split(',')[0]?.trim();
    return city ? `${city}, France` : fallback;
  }

  const cpCity = raw.match(/\b(\d{5})\s+([A-Za-zÀ-ÿ\s'-]+)\s*$/u);
  if (cpCity?.[2]) {
    return `${cpCity[2].trim()}, France`;
  }

  if (!/\d/.test(raw) && raw.length <= 48) {
    return raw.includes(',') ? raw : `${raw}, France`;
  }

  return fallback.trim() || raw;
}

/**
 * Extrait la ville depuis une adresse Maps (formats internationaux courants).
 * Ex. « 23 Rue du Pâquier, 74000 Annecy » → « Annecy » · « Bourg-en-Bresse, France » → « Bourg-en-Bresse »
 */
export function extractCityFromMapsAddress(address: string | null | undefined): string | null {
  const raw = address?.trim();
  if (!raw) return null;

  const cpCity = raw.match(/\b(\d{4,6})\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s'-]*?)\s*(?:,|$)/u);
  if (cpCity?.[2]) {
    const city = cpCity[2].trim();
    if (city.length >= 2) return city;
  }

  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1]!;
    if (/^[a-z]{2,3}$/i.test(last) || /^(france|fr)$/i.test(last)) {
      const candidate = parts[parts.length - 2];
      if (candidate && !/\d{4,}/.test(candidate)) return candidate;
    }
  }

  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i]!;
    if (/\d{4,}/.test(part)) continue;
    if (part.length >= 2) return part;
  }

  return null;
}

/** Ville prospect pour filtre géo — priorité adresse Maps, repli hint pipeline. */
export function resolveProspectCity(
  serp: { readonly address?: string | null },
  searchLocation?: string | null,
): string | null {
  const fromAddress = extractCityFromMapsAddress(serp.address);
  if (fromAddress) return fromAddress;

  const hint = searchLocation?.trim();
  if (!hint) return null;

  const cpCity = hint.match(/\b(\d{5})\s+([A-Za-zÀ-ÿ\s'-]+)\s*$/u);
  if (cpCity?.[2]) return cpCity[2].trim();

  const cityPart = hint.split(',')[0]?.trim();
  return cityPart && cityPart.length >= 2 ? cityPart : null;
}

/** Requête découverte site (nom + ville) — alignée website-resolver / Brave. */
export function buildOwnerDiscoveryQuery(
  businessName: string,
  searchLocation: string | null | undefined,
  fallback: string,
): string {
  const name = businessName.trim();
  if (!name) return '';
  const cityHint = cityHintFromSearchLocation(searchLocation, fallback);
  const city = cityHint.split(',')[0]?.trim() ?? cityHint;
  return [name, city].filter((part) => part.length > 0).join(' ').trim();
}
