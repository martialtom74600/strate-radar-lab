import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assessCorporateParentCandidate,
  groqRejectionIndicatesCorporateParent,
  groqRejectionIsDirectoryOnly,
  resolveSharedParentDomainLocator,
} from './top5-corporate-signals.js';

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
