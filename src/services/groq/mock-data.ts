import type {
  ConversionBrochureAnalysis,
  DiamondHunterPitch,
} from './diamond-schemas.js';
import type { SalesAnalysis } from './schemas.js';

export const MOCK_SALES_ANALYSIS: SalesAnalysis = {
  executiveSummary:
    'Prospect fictif (simulation) : présence locale correcte mais site perfectible sur la perf mobile — angle « vitrine digitale » pour Strate Studio.',
  pitchAngles: [
    'Mettre en avant un audit Core Web Vitals chiffré avant/après.',
    'Proposer une page offres claire liée à leur fiche Google Business Profile.',
    'Pack « mise en conformance » SEO technique + suivi mensuel léger.',
  ],
  objectionHandling: [
    'Budget serré → starter audit + quick wins sous 30 jours.',
    'Pas le temps → automatisation reporting + tableau de bord simple.',
  ],
  recommendedOpening:
    '« Je vois que vous captez bien l’avis local ; je peux vous montrer en 5 minutes où vous perdez des contacts mobile sur votre site. »',
  priority: 'medium',
};

/** Simulation — cas découverte organique (pas de site sur Maps). */
export const MOCK_ORGANIC_MAPS_CONVERSION_ANALYSIS: SalesAnalysis = {
  executiveSummary:
    '(simulation) La fiche Maps capte l’intérêt mais le site identifié hors Maps peut créouter des ruptures de parcours — levier principal : aligner promesse locale et conversion web.',
  pitchAngles: [
    'Harmoniser NAP, horaires et offres entre Maps et la page d’accueil pour éviter la confusion.',
    'Tracer les appels / formulaires par canal (Maps vs site) pour prouver les fuites de prospects.',
    'Landing « même promesse que Maps » + mobile-first pour les découvertes « près de moi ».',
    'Preuve sociale et itinéraire cliquable renforcés sur les deux surfaces.',
  ],
  objectionHandling: [
    '« On a déjà un site » → focus sur la cohérence du message et du parcours, pas sur refonte totale.',
    '« Les avis suffisent » → montrer les abandons entre clic Maps et prise de contact site.',
  ],
  recommendedOpening:
    '« Beaucoup de vos prospects vous trouvent sur Maps avant le site — je peux vous montrer où le message diverge et ce que ça vous coûte en rendez-vous. »',
  priority: 'high',
};

/** Pitch statique bypass « Diamant brut » (aucun appel Groq). */
export const DIAMANT_BRUT_STATIC_PITCH: DiamondHunterPitch = {
  headline:
    'Diamant brut : vous captez déjà la demande locale sur Maps, mais sans site vous ne convertissez pas le trafic qualifié.',
  gainTempsEtAutomatisation:
    'Une seule landing ou mini-site reliée à la fiche Maps permet de centraliser réservations, devis et suivi — sans doubler la saisie entre « avis Google » et votre agenda.',
  anglePrimeConversion:
    'Positionner la prise de contact comme prolongement naturel de la fiche (même nom, même promesse, tel et mail cliquables) pour ne plus perdre les recherches mobile « près de moi ».',
  lost_revenue_pitch:
    'Avec un volume d’avis qui prouve le flux, l’absence totale de site vous fait perdre une part importante des contacts qui veulent passer à l’action après Maps — au profit des concurrents déjà cliquables en un tap.',
};

/** Pitch « chasseur de primes » pour prospects Diamant sans site (simulation). */
export const MOCK_DIAMOND_HUNTER_PITCH: DiamondHunterPitch = {
  headline:
    '(simulation) Prime locale : forte liquidité d’avis sans canal web — premier à structurer le flux Map → RDV gagne la marge.',
  gainTempsEtAutomatisation:
    'Automatiser la réponse aux demandes « itinéraire / appelez » avec une landing unique et un tracking UTM Maps pour mesurer le ROI sans CRM lourd — dizaines d’heures gagnées sur le suivi manuel.',
  anglePrimeConversion:
    'Positionner Strate Studio comme « passerelle » entre la demande locale déjà acquise et une prise de contact mesurable (formulaire + rappel), avant que la concurrence ne verrouille le marché.',
  lost_revenue_pitch:
    '(simulation) Avec 120 avis et sans réservation mobile fluide, vous perdez une vingtaine de prospects « chauds » issus de Maps chaque mois au profit des concurrents avec parcours cliquable.',
};

export const MOCK_CONVERSION_BROCHURE: ConversionBrochureAnalysis = {
  deadBrochureSite: true,
  briefReason:
    '(simulation) Page d’accueil type plaquette : peu de CTA mesurables ni parcours clair vers la prise de contact.',
};
