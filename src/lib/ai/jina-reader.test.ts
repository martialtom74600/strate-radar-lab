import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cleanJinaMarkdownForClassifier } from './jina-reader.js';

describe('cleanJinaMarkdownForClassifier', () => {
  it('retire les métadonnées Jina et garde le contenu', () => {
    const raw = `Title: Annecy Assistance Dépannage

URL Source: https://www.annecy-mobilites.fr/

Published Time: Tue, 16 Jun 2026 05:08:36 GMT

Markdown Content:
# Annecy Assistance Dépannage
Dépannage remorquage à Annecy`;

    const cleaned = cleanJinaMarkdownForClassifier(raw);
    assert.doesNotMatch(cleaned, /URL Source/i);
    assert.match(cleaned, /# Annecy Assistance Dépannage/);
    assert.match(cleaned, /Dépannage remorquage/);
  });
});
