import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assessStructuralWebsitePresence,
  findDedicatedOwnerSiteCandidates,
  getRegistrableDomain,
  isDedicatedOwnerHost,
  isMultiTenantPlatformHost,
  prioritizeUrlsForSerpClassification,
} from './host-presence.js';

describe('getRegistrableDomain', () => {
  it('extrait le domaine enregistrable FR', () => {
    assert.equal(getRegistrableDomain('www.annecy-mobilites.fr'), 'annecy-mobilites.fr');
    assert.equal(getRegistrableDomain('foo.site-solocal.com'), 'site-solocal.com');
  });
});

describe('isMultiTenantPlatformHost', () => {
  it('détecte les plateformes et leurs sous-domaines', () => {
    assert.equal(isMultiTenantPlatformHost('www.facebook.com'), true);
    assert.equal(isMultiTenantPlatformHost('annecyassistancedepannage.site-solocal.com'), true);
    assert.equal(isMultiTenantPlatformHost('www.pappers.fr'), true);
    assert.equal(isMultiTenantPlatformHost('lacarte.menu'), true);
  });

  it('laisse passer un domaine dédié', () => {
    assert.equal(isMultiTenantPlatformHost('annecy-mobilites.fr'), false);
    assert.equal(isMultiTenantPlatformHost('lamy-joaillerie.com'), false);
  });
});

describe('isDedicatedOwnerHost', () => {
  it('accepte un domaine propre y compris annuaire vertical', () => {
    assert.equal(isDedicatedOwnerHost('depanneur-du-coin.fr'), true);
    assert.equal(isDedicatedOwnerHost('annecy-ville.fr'), true);
  });
});

describe('assessStructuralWebsitePresence', () => {
  it('presence_only sans LLM si seulement plateformes (Funny dog)', () => {
    const result = assessStructuralWebsitePresence([
      'https://www.facebook.com/funny-dog/',
      'https://www.pagesjaunes.fr/pros/123',
    ]);
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') {
      assert.equal(result.status, 'presence_only');
      assert.ok(result.matchedUrl?.includes('facebook.com'));
    }
  });

  it('needs_llm si domaine dédié présent (Annecy Assistance)', () => {
    const result = assessStructuralWebsitePresence([
      'http://annecyassistancedepannage.site-solocal.com/',
      'https://www.annecy-mobilites.fr',
      'https://www.pappers.fr/entreprise/foo',
    ]);
    assert.equal(result.kind, 'needs_llm');
    if (result.kind === 'needs_llm') {
      assert.equal(result.dedicatedUrls[0], 'https://www.annecy-mobilites.fr');
    }
  });

  it('none si bucket vide', () => {
    const result = assessStructuralWebsitePresence([]);
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') assert.equal(result.status, 'none');
  });

  it('presence_only pour lacarte.menu sans LLM', () => {
    const result = assessStructuralWebsitePresence([
      'https://lacarte.menu/le-balcon',
      'https://www.tripadvisor.fr/foo',
    ]);
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') assert.equal(result.status, 'presence_only');
  });
});

describe('prioritizeUrlsForSerpClassification', () => {
  it('place les domaines dédiés avant les plateformes', () => {
    const ordered = prioritizeUrlsForSerpClassification([
      'http://foo.site-solocal.com/',
      'https://www.annecy-mobilites.fr',
      'https://www.pappers.fr/entreprise/foo',
    ]);
    assert.equal(ordered[0], 'https://www.annecy-mobilites.fr');
  });
});

describe('findDedicatedOwnerSiteCandidates', () => {
  it('dédoublonne par domaine enregistrable', () => {
    const urls = findDedicatedOwnerSiteCandidates([
      'https://www.lamy-joaillerie.com/',
      'https://lamy-joaillerie.com/contact',
    ]);
    assert.equal(urls.length, 1);
  });
});
