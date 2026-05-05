export type SerpOrganicResult = {
  readonly position?: number;
  readonly title: string;
  readonly link: string;
  readonly snippet?: string;
};

export type SerpGoogleOrganicResponse = {
  readonly search_metadata: { readonly id: string; readonly status: string };
  readonly search_parameters: {
    readonly engine: string;
    readonly q: string;
    readonly [key: string]: unknown;
  };
  readonly organic_results?: readonly SerpOrganicResult[];
  readonly error?: string;
};
