import { createHash } from 'node:crypto';

import type { SerpLocalResult } from '../services/serp/schemas.js';

/** Clé stable pour cache anti-rescan (place_id Google ou empreinte titre+adresse). */
export function stablePlaceKey(serp: SerpLocalResult): string {
  const pid = serp.place_id?.trim();
  if (pid) return `pid:${pid}`;
  const basis = `${serp.title}|${serp.address ?? ''}`;
  const h = createHash('sha256').update(basis, 'utf8').digest('hex').slice(0, 24);
  return `hid:${h}`;
}
