/** Hit organique Google / Brave (titre + lien + extrait optionnel). */
export type OrganicSerpHit = {
  readonly title: string;
  readonly link: string;
  readonly snippet?: string;
  readonly place_id?: string;
};
