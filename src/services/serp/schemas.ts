/** Une ligne « local » (pack Maps / ancien google_local SerpApi / Places Text Search mappée). */
export type SerpLocalResult = {
  readonly position?: number;
  readonly title: string;
  readonly place_id?: string;
  readonly data_id?: string;
  readonly data_cid?: string;
  readonly reviews_link?: string;
  readonly photos_link?: string;
  readonly gps_coordinates?: {
    readonly latitude: number;
    readonly longitude: number;
  };
  readonly place_id_search?: string;
  readonly type?: string;
  readonly types?: readonly string[];
  readonly address?: string;
  readonly phone?: string;
  readonly website?: string;
  readonly description?: string;
  readonly rating?: number;
  readonly reviews?: number;
  readonly hours?: string;
  readonly open_state?: string;
  readonly thumbnail?: string;
  readonly price?: string;
};

export type SerpSearchMetadata = {
  readonly id: string;
  readonly status: string;
  readonly json_endpoint?: string;
  readonly created_at?: string;
  readonly processed_at?: string;
  readonly google_local_url?: string;
  readonly raw_html_file?: string;
  readonly total_time_taken?: number;
};

/** Réponse locale (forme historique compat SerpApi). */
export type SerpGoogleLocalResponse = {
  readonly search_metadata: SerpSearchMetadata;
  readonly search_parameters: {
    readonly engine: string;
    readonly q: string;
    readonly location?: string;
    readonly google_domain?: string;
    readonly hl?: string;
    readonly gl?: string;
    readonly [key: string]: unknown;
  };
  readonly local_results?: readonly SerpLocalResult[];
  readonly next_page_token?: string;
  readonly error?: string;
};
