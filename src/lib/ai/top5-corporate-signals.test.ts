import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assessAlignedHomepageOwnerRescue,
  assessCorporateParentCandidate,
  assessWebsiteBuilderOwnerSite,
  groqRejectionIndicatesCorporateParent,
  groqRejectionIsContentUncertaintyOnly,
  groqRejectionIsDirectoryOnly,
  markdownIndicatesPressOrDirectoryListing,
  resolveSharedParentDomainLocator,
} from './top5-corporate-signals.js';
import { isWebsiteBuilderUrl } from '../website-builder-hosts.js';

describe('groqRejectionIndicatesCorporateParent', () => {
  it('détecte franchise / réseau national', () => {
    assert.equal(
      groqRejectionIndicatesCorporateParent(
        'Page magasin sur le réseau national — pas un site indépendant.',
      ),
      true,
    );
    assert.equal(groqRejectionIndicatesCorporateParent('Fiche annuaire Mappy.'), false);
  });
});

describe('groqRejectionIsDirectoryOnly', () => {
  it('distingue annuaire pur de franchise', () => {
    assert.equal(groqRejectionIsDirectoryOnly('Fiche sur Mappy, annuaire tiers.'), true);
    assert.equal(groqRejectionIsDirectoryOnly('Succursale du réseau national.'), false);
    assert.equal(
      groqRejectionIsDirectoryOnly(
        "Cette page est un article de presse sur un événement lié au commerce.",
      ),
      true,
    );
  });
});

describe('markdownIndicatesPressOrDirectoryListing', () => {
  it('détecte une page presse', () => {
    assert.equal(
      markdownIndicatesPressOrDirectoryListing('Publié le 1 mai 2025 · Rédaction Dauphiné'),
      true,
    );
    assert.equal(markdownIndicatesPressOrDirectoryListing('# MJ Tattoo · Portfolio'), false);
  });
});

describe('groqRejectionIsContentUncertaintyOnly', () => {
  it('accepte le doute contenu sans annuaire/franchise', () => {
    assert.equal(
      groqRejectionIsContentUncertaintyOnly(
        'Le contenu de la page ne correspond pas clairement à ce commerce.',
      ),
      true,
    );
    assert.equal(groqRejectionIsContentUncertaintyOnly('Fiche annuaire Mappy.'), false);
  });
});

describe('isWebsiteBuilderUrl', () => {
  it('reconnaît Webnode et Wix', () => {
    assert.equal(isWebsiteBuilderUrl('https://mj-tattoo.webnode.fr/portfolio/'), true);
    assert.equal(isWebsiteBuilderUrl('https://example.fr/'), false);
  });
});

describe('assessWebsiteBuilderOwnerSite', () => {
  it('Webnode + contenu confirmé → owner (pas corporate)', () => {
    const assessment = assessWebsiteBuilderOwnerSite({
      companyName: 'MJ ink',
      url: 'https://mj-tattoo.webnode.fr/portfolio/portrait/',
      markdown: '# MJ ink\nTatoueur à Argonay',
      groqOfficial: false,
    });
    assert.equal(assessment.match, true);
  });
});

describe('assessAlignedHomepageOwnerRescue', () => {
  it('homepage alignée + doute Groq contenu → owner', () => {
    const assessment = assessAlignedHomepageOwnerRescue({
      companyName: 'Rhône-Alpes Nettoyage',
      url: 'https://rhonealpesnettoyage.fr/',
      markdown: '# Nettoyage professionnel',
      groqReason: 'Le contenu de la page ne correspond pas clairement à ce commerce.',
    });
    assert.equal(assessment.match, true);
  });

  it('pas de rescue sur chemin magasin franchise', () => {
    const assessment = assessAlignedHomepageOwnerRescue({
      companyName: 'Carrefour City',
      url: 'https://www.carrefour.fr/magasin/annecy',
      markdown: '# Carrefour City',
      groqReason: 'Le contenu ne correspond pas clairement.',
    });
    assert.equal(assessment.match, false);
  });
});

describe('assessCorporateParentCandidate', () => {
  it('Groq FALSE + motif franchise → corporate', () => {
    const assessment = assessCorporateParentCandidate({
      companyName: 'Carrefour City',
      url: 'https://www.carrefour.fr/magasin/annecy',
      markdown: '# Carrefour City',
      groqOfficial: false,
      groqReason: 'Franchise / grande surface — pas le site indépendant du magasin.',
    });
    assert.equal(assessment.match, true);
    assert.ok(assessment.confidence >= 0.85);
  });

  it('Groq TRUE + chemin locator → corporate (pas owner_site)', () => {
    const assessment = assessCorporateParentCandidate({
      companyName: 'Hase Chauffage',
      url: 'https://www.hase.fr/installateurs/delegues/annecy',
      markdown: '# Installateur Hase Annecy',
      groqOfficial: true,
      groqReason: 'Page installateur sur le site Hase.',
    });
    assert.equal(assessment.match, true);
  });

  it('Groq FALSE annuaire → pas corporate', () => {
    const assessment = assessCorporateParentCandidate({
      companyName: 'Test',
      url: 'https://annuaire.example.fr/commerce/test',
      markdown: '# Annuaire',
      groqOfficial: false,
      groqReason: 'Fiche annuaire, pas un site propriétaire.',
    });
    assert.equal(assessment.match, false);
  });

  it('Webnode → pas corporate_parent', () => {
    const assessment = assessCorporateParentCandidate({
      companyName: 'MJ ink',
      url: 'https://mj-tattoo.webnode.fr/portfolio/portrait/',
      markdown: '# MJ ink tattoo',
      groqOfficial: false,
      groqReason: 'Chemin profond sur webnode.',
    });
    assert.equal(assessment.match, false);
  });

  it('markdown presse → pas corporate_parent', () => {
    const assessment = assessCorporateParentCandidate({
      companyName: 'Toilettes royale',
      url: 'https://www.ledauphine.com/societe/2025/05/01/article',
      markdown: 'Publié le 1 mai 2025 · Rédaction',
      groqOfficial: false,
      groqReason: 'Article de presse, pas le site officiel.',
    });
    assert.equal(assessment.match, false);
  });
});

describe('resolveSharedParentDomainLocator', () => {
  it('≥2 URLs locator même domaine parent', () => {
    const pick = resolveSharedParentDomainLocator(
      [
        'https://www.carrefour.fr/magasin/annecy-centre',
        'https://www.carrefour.fr/magasin/annecy-nord',
        'https://www.mappy.com/poi/foo',
      ],
      'Carrefour City',
    );
    assert.ok(pick?.includes('carrefour.fr'));
  });

  it('une seule URL locator → null', () => {
    const pick = resolveSharedParentDomainLocator(
      ['https://www.carrefour.fr/magasin/annecy-centre'],
      'Carrefour City',
    );
    assert.equal(pick, null);
  });
});
