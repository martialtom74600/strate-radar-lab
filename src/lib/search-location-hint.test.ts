import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOwnerDiscoveryQuery,
  cityHintFromSearchLocation,
  extractCityFromMapsAddress,
} from './search-location-hint.js';

test('cityHintFromSearchLocation extrait la ville depuis une adresse postale', () => {
  assert.equal(
    cityHintFromSearchLocation('15 rue somewhere, 74000 Annecy', 'Annecy, France'),
    'Annecy, France',
  );
});

test('buildOwnerDiscoveryQuery utilise la ville et non l’adresse complète', () => {
  assert.equal(
    buildOwnerDiscoveryQuery(
      'Bijouterie LAMY',
      '15 rue de la République, 74000 Annecy',
      'Annecy, France',
    ),
    'Bijouterie LAMY Annecy',
  );
});

test('extractCityFromMapsAddress extrait la ville depuis le code postal', () => {
  assert.equal(
    extractCityFromMapsAddress('23 Rue du Pâquier, 74000 Annecy, France'),
    'Annecy',
  );
  assert.equal(extractCityFromMapsAddress('Centre-ville, 01000 Bourg-en-Bresse'), 'Bourg-en-Bresse');
});
