const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

describe('sources.json', () => {
  const sourcesPath = path.join(__dirname, '..', 'sources.json');
  const config = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));

  it('has metadata', () => {
    assert.ok(config.metadata);
    assert.ok(config.metadata.name);
    assert.ok(config.metadata.timezone);
  });

  it('has sources array', () => {
    assert.ok(Array.isArray(config.sources));
    assert.ok(config.sources.length > 0);
  });

  it('all sources have required fields', () => {
    const sources = config.sources.filter(s => !s._comment);
    for (const source of sources) {
      assert.ok(source.id, `Source missing id: ${JSON.stringify(source)}`);
      assert.ok(source.name, `Source ${source.id} missing name`);
      assert.ok(source.type, `Source ${source.id} missing type`);
      assert.ok(['rss', 'screenshot', 'twitter'].includes(source.type),
        `Source ${source.id} has invalid type: ${source.type}`);
      assert.ok(source.url, `Source ${source.id} missing url`);
      assert.ok(source.priority, `Source ${source.id} missing priority`);
      assert.ok(['primary', 'secondary', 'tertiary', 'reference'].includes(source.priority),
        `Source ${source.id} has invalid priority: ${source.priority}`);
    }
  });

  it('source IDs are unique', () => {
    const sources = config.sources.filter(s => !s._comment);
    const ids = sources.map(s => s.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepStrictEqual(dupes, [], `Duplicate source IDs: ${dupes.join(', ')}`);
  });

  it('covers all GCC states and Yemen', () => {
    const sources = config.sources.filter(s => !s._comment);
    const categories = new Set(sources.map(s => s.category));

    // Check for each country/entity
    const required = ['saudi', 'uae', 'qatar', 'bahrain', 'kuwait', 'oman',
                      'yemen_irg', 'yemen_houthi', 'yemen_stc'];
    for (const country of required) {
      const hasCountry = [...categories].some(c => c.startsWith(country));
      assert.ok(hasCountry, `Missing sources for: ${country}`);
    }
  });
});
