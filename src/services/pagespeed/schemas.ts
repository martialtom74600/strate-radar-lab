/** Catégorie Lighthouse (score typiquement entre 0 et 1, ou null si N/A). */
export type LighthouseCategory = {
  readonly id?: string;
  readonly title?: string;
  readonly score?: number | null;
};

export type LighthouseAuditRef = {
  readonly id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly score?: number | null;
  readonly scoreDisplayMode?: string;
  readonly numericValue?: number;
  readonly displayValue?: string;
  readonly [key: string]: unknown;
};

export type LighthouseResult = {
  readonly requestedUrl?: string;
  readonly finalUrl?: string;
  readonly fetchTime?: string;
  readonly lighthouseVersion?: string;
  readonly userAgent?: string;
  readonly categories?: Readonly<Record<string, LighthouseCategory>>;
  readonly audits?: Readonly<Record<string, LighthouseAuditRef>>;
  readonly [key: string]: unknown;
};

/** Réponse PageSpeed Insights v5 (sous-ensemble utile au radar + champs additionnels). */
export type PageSpeedInsightsV5 = {
  readonly captchaResult?: unknown;
  readonly kind?: string;
  readonly id?: string;
  readonly loadingExperience?: unknown;
  readonly lighthouseResult?: LighthouseResult;
  readonly analysisUTCTiming?: unknown;
  readonly version?: Readonly<
    Record<string, unknown> & { readonly major?: number; readonly minor?: number }
  >;
  readonly [key: string]: unknown;
};
