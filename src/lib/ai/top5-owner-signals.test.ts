import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assessStructuralOwnerSiteSignal,
  contentConfirmsBusinessName,
  domainMatchesBusinessName,
  domainSlugFromRegistrable,
  formatStructuralHintsForGroq,
  isDirectoryStylePath,
  isHomepageUrl,
  normalizeAlphanumeric,
} from './top5-owner-signals.js';

describe('normalizeAlphanumeric', () => {
  it('retire accents, espaces et ponctuation', () => {
    assert.equal(normalizeAlphanumeric("L'Arbre à Fées"), 'larbreafees');
    assert.equal(normalizeAlphanumeric('Annecy Assistance Depannage SARL'), 'annecyassistancedepannagesarl');
    assert.equal(domainSlugFromRegistrable('annecy-mobilites.fr'), 'annecymobilites');
    assert.ok(normalizeAlphanumeric("L'Arbre à Fées - Artisan Fleuriste").includes('arbreafees'));
  });
});

describe('domainMatchesBusinessName — inclusion stricte', () => {
  it('TRUE quand le slug domaine est inclus dans le nom normalisé (ou inverse)', () => {
    assert.equal(domainMatchesBusinessName('laboheme-fleuriste.fr', 'La Bohème'), true);
    assert.equal(domainMatchesBusinessName('arbreafees.fr', "L'Arbre à Fées"), true);
  });

  it('FALSE pour Annecy Assistance vs annecy-mobilites (cas sémantique → Groq)', () => {
    assert.equal(
      domainMatchesBusinessName('annecy-mobilites.fr', 'Annecy Assistance Depannage SARL'),
      false,
    );
  });

  it('FALSE pour annuaire bestfleuriste vs Comptoir des Fleurs', () => {
    assert.equal(
      domainMatchesBusinessName('bestfleuriste.fr', 'Le Comptoir des Fleurs'),
      false,
    );
  });
});

describe('isHomepageUrl', () => {
  it('accepte uniquement la racine', () => {
    assert.equal(isHomepageUrl('https://www.annecy-mobilites.fr/'), true);
    assert.equal(isHomepageUrl('https://www.annecy-mobilites.fr/contact'), false);
  });
});

describe('isDirectoryStylePath', () => {
  it('détecte les chemins profonds sans liste de mots', () => {
    assert.equal(
      isDirectoryStylePath('https://www.bestfleuriste.fr/74/annecy/le-comptoir-des-fleurs-155451'),
      true,
    );
    assert.equal(isDirectoryStylePath('https://allezlesfleurs.com/annecy/5pm-lab-borgona/'), true);
    assert.equal(isDirectoryStylePath('https://www.arbreafees.fr/'), false);
    assert.equal(isDirectoryStylePath('https://laboheme-fleuriste.fr/contact'), false);
  });
});

describe('contentConfirmsBusinessName', () => {
  it('confirme via slug domaine ou commerce dans le markdown', () => {
    assert.equal(
      contentConfirmsBusinessName({
        companyName: 'La Bohème',
        registrable: 'laboheme-fleuriste.fr',
        markdown: '# Bienvenue\nFleuriste à Epagny — laboheme-fleuriste',
      }),
      true,
    );
  });
});

describe('formatStructuralHintsForGroq', () => {
  it('formate les indices sans décider', () => {
    const text = formatStructuralHintsForGroq({
      registrable: 'annecy-mobilites.fr',
      domainAligned: false,
      homepage: true,
      contentClean: true,
      strongNamePresence: true,
      directoryStylePath: false,
    });
    assert.ok(text?.includes('inclusion normalisée'));
    assert.ok(text?.includes('ne constituent pas une décision'));
  });
});

describe('assessStructuralOwnerSiteSignal — Palier 2 + inclusion', () => {
  it('voie rapide La Bohème sur homepage laboheme-fleuriste.fr', () => {
    const signal = assessStructuralOwnerSiteSignal({
      companyName: 'La Bohème',
      city: 'Epagny',
      url: 'https://laboheme-fleuriste.fr/',
      markdown: `# La Bohème
Artisan fleuriste — laboheme-fleuriste.fr`,
    });
    assert.equal(signal.strong, true);
  });

  it('pas de voie rapide Annecy Assistance sur annecy-mobilites (→ Groq)', () => {
    const signal = assessStructuralOwnerSiteSignal({
      companyName: 'Annecy Assistance Depannage SARL',
      city: 'Annecy',
      url: 'https://www.annecy-mobilites.fr/',
      markdown: `# Annecy Assistance Dépannage
Dépannage remorquage à Annecy.`,
    });
    assert.equal(signal.strong, false);
    assert.equal(signal.hints.domainAligned, false);
    assert.equal(signal.hints.homepage, true);
  });

  it('pas de voie rapide sur bestfleuriste', () => {
    const signal = assessStructuralOwnerSiteSignal({
      companyName: 'Le Comptoir des Fleurs',
      city: 'Seynod',
      url: 'https://www.bestfleuriste.fr/74/annecy/le-comptoir-des-fleurs-155451',
      markdown: `# Le Comptoir des Fleurs
Le Comptoir des Fleurs à Seynod`,
    });
    assert.equal(signal.strong, false);
  });

  it('pas de voie rapide sur page interne même si domaine aligné', () => {
    const signal = assessStructuralOwnerSiteSignal({
      companyName: 'La Bohème',
      city: 'Epagny',
      url: 'https://laboheme-fleuriste.fr/contact',
      markdown: `# Contact\nLa Bohème fleuriste`,
    });
    assert.equal(signal.strong, false);
    assert.equal(signal.hints.homepage, false);
  });

  it('voie rapide L\'Arbre à Fées sur arbreafees.fr (inclusion via nom long)', () => {
    const signal = assessStructuralOwnerSiteSignal({
      companyName: "L'Arbre à Fées - Artisan Fleuriste Salon De Thé Naturel",
      city: 'Sevrier',
      url: 'https://www.arbreafees.fr/',
      markdown: `# L'Arbre à Fées
Salon de thé et fleuriste à Sevrier`,
    });
    assert.equal(signal.hints.domainAligned, true);
    assert.equal(signal.strong, true);
  });
});
