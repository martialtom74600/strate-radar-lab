/** Métadonnées semaine ISO (lundi = début de semaine). */
export function getIsoWeekParts(input: Date): { readonly year: number; readonly week: number } {
  const target = new Date(input.valueOf());
  const dayNr = (target.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay() + 7) % 7));
  }
  const week1 = target.valueOf();
  const weekNum = 1 + Math.ceil((firstThursday - week1) / 604800000);
  const year = new Date(firstThursday).getFullYear();
  return { year, week: weekNum };
}

/** Clé stable pour une fenêtre « même semaine » : `2026-W18`. */
export function formatIsoWeekBucket(input: Date): string {
  const { year, week } = getIsoWeekParts(input);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
