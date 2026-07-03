/**
 * Détection succursale / réseau national sans blocklist de marques :
 * chemins type locator, domaine parent partagé, sémantique Groq « franchise ».
 */

import {
  getRegistrableDomain,
  hostnameFromUrl,
  isDedicatedOwnerUrl,
} from '../host-presence.js';
import { isWebsiteBuilderUrl } from '../website-builder-hosts.js';
import {
  contentConfirmsBusinessName,
  domainMatchesBusinessName,
  isDirectoryStylePath,
  isHomepageUrl,
  scoreOwnerCandidateUrl,
} from './top5-owner-signals.js';

export type CorporateParentAssessment = {
  readonly match: boolean;
  readonly confidence: number;
  readonly reason: string;
};

const FRANCHISE_REJECTION =
  /\b(franchise|succursale|filiale|r[ée]seau\s+national|enseigne\s+nationale|grande\s+surface|hypermarch[ée]|supermarch[ée]|magasin\s+(du|de la|sur)|page\s+(succursale|magasin)|site\s+(du|de la)\s+(groupe|enseigne|marque)|r[ée]seau\s+(de\s+)?magasins|point\s+de\s+vente\s+(du|de la)|pas\s+(le\s+)?site\s+(officiel\s+)?ind[ée]pendant|domaine\s+(du|de la)\s+(groupe|enseigne|marque))\b/i;

/** Groq a répondu FALSE pour motif franchise / réseau (pas annuaire pur). */
export function groqRejectionIndicatesCorporateParent(reason: string): boolean {
  const hay = reason.trim();
  if (!hay) return false;
  if (FRANCHISE_REJECTION.test(hay)) return true;
  if (/\b(r[ée]seau|groupe|enseigne)\b/i.test(hay) && /\b(national|franchise|succursale|magasin)\b/i.test(hay)) {
    return true;
  }
  return false;
}

const DIRECTORY_ONLY_REJECTION =
  /\b(annuaire|listing|comparateur|r[ée]seau\s+social|pages?\s*jaunes|mappy|bonial|custplace|118712|petit\s*fute|fiche\s+(sur|dans)|article\s+de\s+presse|presse\s+locale|journal(?:iste)?|r[ée]daction)\b/i;

/** Groq FALSE parce que c'est un annuaire / presse — ne pas classer corporate_parent. */
export function groqRejectionIsDirectoryOnly(reason: string): boolean {
  return DIRECTORY_ONLY_REJECTION.test(reason.trim());
}

const PRESS_OR_DIRECTORY_MARKDOWN =
  /\b(publi[ée]\s+le|mis\s+[àa]\s+jour\s+le|r[ée]daction|cat[ée]gorie\s+des\s+pros|article\s+de\s+presse|tous\s+les\s+[ée]tablissements|liste\s+des\s+(commerces|professionnels|praticiens)|annuaire\s+(des|de\s+la)|comparateur\s+de)\b/i;

/** Contenu Jina typique presse / annuaire — ne pas mapper en franchise/réseau. */
export function markdownIndicatesPressOrDirectoryListing(markdown: string): boolean {
  const sample = markdown.trim().slice(0, 12_000);
  if (!sample) return false;
  return PRESS_OR_DIRECTORY_MARKDOWN.test(sample);
}

/** Groq doute sur le contenu sans signal annuaire/franchise — rescue domaine aligné possible. */
export function groqRejectionIsContentUncertaintyOnly(reason: string): boolean {
  const hay = reason.trim();
  if (!hay) return false;
  if (groqRejectionIsDirectoryOnly(hay)) return false;
  if (groqRejectionIndicatesCorporateParent(hay)) return false;
  return /\b(contenu|correspond\s+pas|pas\s+confirm|pas\s+clairement|ne\s+mentionne\s+pas)\b/i.test(hay);
}

function shouldSuppressCorporateParent(args: {
  readonly url: string;
  readonly markdown: string;
  readonly groqReason?: string;
}): boolean {
  if (isWebsiteBuilderUrl(args.url)) return true;
  if (markdownIndicatesPressOrDirectoryListing(args.markdown)) return true;
  const groqReason = args.groqReason?.trim() ?? '';
  if (groqReason && groqRejectionIsDirectoryOnly(groqReason)) return true;
  return false;
}

function formatCorporateReason(detail: string): string {
  const t = detail.trim();
  if (t.startsWith('[top5-scanner]')) return t;
  return `[top5-scanner] ${t}`;
}

/**
 * Une page sur domaine parent (chemin locator) ≠ site indépendant,
 * même si Groq répond official:true (ex. Hase sur hase.fr).
 */
export function assessCorporateParentCandidate(args: {
  readonly companyName: string;
  readonly url: string;
  readonly markdown: string;
  readonly groqOfficial?: boolean;
  readonly groqReason?: string;
}): CorporateParentAssessment {
  const none: CorporateParentAssessment = { match: false, confidence: 0, reason: '' };

  if (!isDedicatedOwnerUrl(args.url)) return none;

  const host = hostnameFromUrl(args.url);
  const registrable = host ? getRegistrableDomain(host) : null;
  if (!registrable) return none;

  const directoryPath = isDirectoryStylePath(args.url);
  const domainAligned = domainMatchesBusinessName(registrable, args.companyName);
  const homepage = isHomepageUrl(args.url);
  const contentConfirms = contentConfirmsBusinessName({
    markdown: args.markdown,
    companyName: args.companyName,
    registrable,
  });

  const groqReason = args.groqReason?.trim() ?? '';

  if (
    shouldSuppressCorporateParent({
      url: args.url,
      markdown: args.markdown,
      ...(groqReason ? { groqReason } : {}),
    })
  ) {
    return none;
  }

  if (args.groqOfficial === false && groqReason) {
    if (groqRejectionIndicatesCorporateParent(groqReason)) {
      return {
        match: true,
        confidence: 0.9,
        reason: formatCorporateReason(groqReason),
      };
    }
    if (
      !groqRejectionIsDirectoryOnly(groqReason) &&
      directoryPath &&
      !homepage &&
      (contentConfirms || !domainAligned)
    ) {
      return {
        match: true,
        confidence: 0.88,
        reason: formatCorporateReason(
          `Fiche sur ${registrable} (chemin type succursale) — pas un domaine propre au commerce.`,
        ),
      };
    }
  }

  if (args.groqOfficial === true && directoryPath && !homepage) {
    return {
      match: true,
      confidence: domainAligned ? 0.9 : 0.88,
      reason: formatCorporateReason(
        `Page succursale / locator sur ${registrable} — le domaine n'est pas celui d'un artisan indépendant.`,
      ),
    };
  }

  if (
    directoryPath &&
    !homepage &&
    !domainAligned &&
    contentConfirms
  ) {
    return {
      match: true,
      confidence: 0.87,
      reason: formatCorporateReason(
        `Établissement référencé sur ${registrable} (domaine parent) — pas un site vitrine indépendant.`,
      ),
    };
  }

  return none;
}

/** Plusieurs URLs « magasin » sur le même domaine parent (ex. carrefour.fr/magasin/…). */
export function resolveSharedParentDomainLocator(
  candidates: readonly string[],
  companyName: string,
): string | null {
  const buckets = new Map<string, string[]>();

  for (const url of candidates) {
    if (isWebsiteBuilderUrl(url)) continue;
    const host = hostnameFromUrl(url);
    const registrable = host ? getRegistrableDomain(host) : null;
    if (!registrable || !isDedicatedOwnerUrl(url)) continue;
    const list = buckets.get(registrable) ?? [];
    list.push(url);
    buckets.set(registrable, list);
  }

  let best: { url: string; score: number } | null = null;

  for (const [registrable, urls] of buckets) {
    if (urls.length < 2) continue;
    const locatorUrls = urls.filter((u) => isDirectoryStylePath(u) && !isHomepageUrl(u));
    if (locatorUrls.length < 2) continue;

    const pick = [...locatorUrls].sort(
      (a, b) => scoreOwnerCandidateUrl(b, companyName) - scoreOwnerCandidateUrl(a, companyName),
    )[0];
    if (!pick) continue;

    const score = scoreOwnerCandidateUrl(pick, companyName) + locatorUrls.length;
    if (!best || score > best.score) {
      best = { url: pick, score };
    }

    void registrable;
  }

  return best?.url ?? null;
}

export type SerpClassifierCorporateResult = {
  readonly status: 'corporate_parent';
  readonly confidence: number;
  readonly reason: string;
  readonly matchedUrl: string;
};

export function corporateParentFromLocator(args: {
  readonly url: string;
  readonly companyName: string;
  readonly detail?: string;
}): SerpClassifierCorporateResult {
  const host = hostnameFromUrl(args.url);
  const registrable = host ? getRegistrableDomain(host) : null;
  const detail =
    args.detail ??
    (registrable
      ? `Plusieurs fiches magasin sur ${registrable} — réseau / succursale.`
      : 'Plusieurs fiches sur le même domaine parent — réseau / succursale.');

  return {
    status: 'corporate_parent',
    confidence: 0.92,
    reason: formatCorporateReason(detail),
    matchedUrl: args.url,
  };
}

export function corporateParentFromAssessment(args: {
  readonly url: string;
  readonly assessment: CorporateParentAssessment;
}): SerpClassifierCorporateResult {
  return {
    status: 'corporate_parent',
    confidence: args.assessment.confidence,
    reason: args.assessment.reason,
    matchedUrl: args.url,
  };
}

export function pickStrongerCorporateCandidate(
  current: { readonly url: string; readonly confidence: number; readonly reason: string } | null,
  next: { readonly url: string; readonly assessment: CorporateParentAssessment },
): { readonly url: string; readonly confidence: number; readonly reason: string } | null {
  if (!next.assessment.match) return current;
  if (!current || next.assessment.confidence >= current.confidence) {
    return {
      url: next.url,
      confidence: next.assessment.confidence,
      reason: next.assessment.reason,
    };
  }
  return current;
}

export type OwnerSiteRescueAssessment = {
  readonly match: boolean;
  readonly confidence: number;
  readonly reason: string;
};

function formatOwnerRescueReason(detail: string): string {
  const t = detail.trim();
  if (t.startsWith('[top5-scanner]')) return t;
  return `[top5-scanner] ${t}`;
}

/** Site hébergé Webnode/Wix/etc. — site propre au commerce, pas un réseau national. */
export function assessWebsiteBuilderOwnerSite(args: {
  readonly companyName: string;
  readonly url: string;
  readonly markdown: string;
  readonly groqOfficial?: boolean;
}): OwnerSiteRescueAssessment {
  const none: OwnerSiteRescueAssessment = { match: false, confidence: 0, reason: '' };
  if (!isWebsiteBuilderUrl(args.url) || !isDedicatedOwnerUrl(args.url)) return none;

  const host = hostnameFromUrl(args.url);
  const registrable = host ? getRegistrableDomain(host) : null;
  if (!registrable) return none;

  const contentConfirms = contentConfirmsBusinessName({
    markdown: args.markdown,
    companyName: args.companyName,
    registrable,
  });

  if (args.groqOfficial === true || contentConfirms) {
    return {
      match: true,
      confidence: args.groqOfficial === true ? 0.9 : 0.87,
      reason: formatOwnerRescueReason(
        `Site sur hébergeur ${registrable} — vitrine propre au commerce (pas franchise).`,
      ),
    };
  }

  return none;
}

/**
 * Domaine aligné + homepage : Groq hésite sur le contenu mais ce n'est ni annuaire ni franchise.
 * Ex. rhonealpesnettoyage.fr alors que Groq dit « contenu pas clairement confirmé ».
 */
export function assessAlignedHomepageOwnerRescue(args: {
  readonly companyName: string;
  readonly url: string;
  readonly markdown: string;
  readonly groqReason: string;
}): OwnerSiteRescueAssessment {
  const none: OwnerSiteRescueAssessment = { match: false, confidence: 0, reason: '' };

  if (!isDedicatedOwnerUrl(args.url) || isWebsiteBuilderUrl(args.url)) return none;

  const host = hostnameFromUrl(args.url);
  const registrable = host ? getRegistrableDomain(host) : null;
  if (!registrable) return none;

  if (
    shouldSuppressCorporateParent({
      url: args.url,
      markdown: args.markdown,
      groqReason: args.groqReason,
    })
  ) {
    return none;
  }

  if (!domainMatchesBusinessName(registrable, args.companyName)) return none;
  if (!isHomepageUrl(args.url) || isDirectoryStylePath(args.url)) return none;

  const groqReason = args.groqReason.trim();
  if (!groqReason || !groqRejectionIsContentUncertaintyOnly(groqReason)) return none;

  return {
    match: true,
    confidence: 0.88,
    reason: formatOwnerRescueReason(
      `Page d'accueil de ${registrable} alignée au commerce — site propre (doute contenu Groq ignoré).`,
    ),
  };
}
