/** Analyse « plaquette morte » — pilier 3 conversion. */
export type ConversionBrochureAnalysis = {
  readonly deadBrochureSite: boolean;
  readonly briefReason: string;
};

export type ConversionBrochureInput = {
  readonly htmlExcerpt: string;
  readonly businessName: string;
  readonly mapsCategory?: string;
};
