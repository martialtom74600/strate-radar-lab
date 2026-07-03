/**
 * Détection succursale / réseau national sans blocklist de marques :
 * chemins type locator, domaine parent partagé, sémantique Groq « franchise ».
 */

import {
  getRegistrableDomain,
  hostnameFromUrl,
  isDedicatedOwnerUrl,
} from '../host-presence.js';
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
  /\b(annuaire|listing|comparateur|r[ée]seau\s+social|pages?\s*jaunes|mappy|bonial|custplace|118712|petit\s*fute|fiche\s+(sur|dans))\b/i;

/** Groq FALSE parce que c'est un annuaire — ne pas classer corporate_parent. */
export function groqRejectionIsDirectoryOnly(reason: string): boolean {
  return DIRECTORY_ONLY_REJECTION.test(reason.trim());
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
