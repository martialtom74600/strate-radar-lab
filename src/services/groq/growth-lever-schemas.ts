/** Leviers digitaux Diamond — entrée analyse Groq (`response_format: json_object`). */

export type DiamondGrowthLeversInput = {
  readonly businessName: string;
  readonly activityLabel: string | null;
  /** Code NAF (activité officielle registre si match). */
  readonly nafCode: string | null;
  readonly nafResume: string | null;
  readonly address: string | null;
  readonly googleRating: number | null;
  readonly googleReviewCount: number | null;
  readonly siteSituation: string;
  /** Signaux / dettes issus matrice Strate (piliers). */
  readonly technicalFrictionLines: readonly string[];
  /** Textes d’avis Maps (≤10). */
  readonly reviewTexts: readonly string[];
};

export type DiamondGrowthLeversResult = {
  /** Exactement 3 idées, chacune ≤ 12 mots (langage simple). */
  readonly ideas: readonly string[];
};
