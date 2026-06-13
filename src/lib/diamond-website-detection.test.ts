import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  shouldDisqualifyWebsitePresenceForScrub,
  shouldRejectCorporateParentForCreationHunt,
  shouldRejectOwnerSiteForCreationHunt,
} from './diamond-website-detection.js';

describe('shouldRejectOwnerSiteForCreationHunt', () => {
  it('rejette owner_site en chasse création', () => {
    assert.equal(
      shouldRejectOwnerSiteForCreationHunt({
        resolution: { status: 'owner_site' },
        needCreation: true,
        needRefonte: false,
      }),
      true,
    );
  });

  it('conserve owner_site si quota refonte', () => {
    assert.equal(
      shouldRejectOwnerSiteForCreationHunt({
        resolution: { status: 'owner_site' },
        needCreation: true,
        needRefonte: true,
      }),
      false,
    );
  });
});

describe('shouldRejectCorporateParentForCreationHunt', () => {
  it('rejette corporate_parent en chasse création/présence', () => {
    assert.equal(
      shouldRejectCorporateParentForCreationHunt({
        resolution: { status: 'corporate_parent' },
        needCreation: true,
        needRefonte: false,
      }),
      true,
    );
  });

  it('conserve corporate_parent si quota refonte', () => {
    assert.equal(
      shouldRejectCorporateParentForCreationHunt({
        resolution: { status: 'corporate_parent' },
        needCreation: true,
        needRefonte: true,
      }),
      false,
    );
  });

  it('ne rejette pas presence_only', () => {
    assert.equal(
      shouldRejectCorporateParentForCreationHunt({
        resolution: { status: 'presence_only' },
        needCreation: true,
        needRefonte: false,
      }),
      false,
    );
  });
});

describe('shouldDisqualifyWebsitePresenceForScrub', () => {
  it('disqualifie owner_site et corporate_parent', () => {
    assert.equal(shouldDisqualifyWebsitePresenceForScrub({ status: 'owner_site' }), true);
    assert.equal(shouldDisqualifyWebsitePresenceForScrub({ status: 'corporate_parent' }), true);
    assert.equal(shouldDisqualifyWebsitePresenceForScrub({ status: 'presence_only' }), false);
    assert.equal(shouldDisqualifyWebsitePresenceForScrub({ status: 'none' }), false);
  });
});
