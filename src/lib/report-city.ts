/** Extrait un libellé ville pour titrage (ex. « Annecy, France » → « ANNECY »). */
export function extractCityLabelForReport(location: string | undefined): string {
  if (!location?.trim()) return 'TA VILLE';
  const first = location.split(',')[0]?.trim() ?? location.trim();
  return first.toUpperCase();
}

/**
 * Article pour titre type « Pépites d'Annecy » (élision devant voyelle / H muet).
 */
export function frenchDefiniteArticleDe(cityUpper: string): string {
  const c = cityUpper.trim();
  if (c.length === 0) return 'DE TA VILLE';
  const head = c.charAt(0);
  if ('AEIOUHÀÂÄÉÈÊËÎÏÔÖÙÛÜŸ'.includes(head)) {
    return `D'${c}`;
  }
  return `DE ${c}`;
}
