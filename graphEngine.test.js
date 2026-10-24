const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers');
const GraphEngine = require('./graphEngine');

const n = (id, type = 'function', extra = {}) => ({ id, label: id, type, file: id.split('::')[0], ...extra });
const e = (from, to, type = 'calls') => ({ from, to, type, label: `${type} ${to}` });

// a -> b -> c, d -> b, e -> e (self), c -> a (cycle)
function sample() {
  const nodes = ['a', 'b', 'c', 'd', 'x'].map(id => n(`f.js::${id}`));
  const edges = [
    e('f.js::a', 'f.js::b'), e('f.js::b', 'f.js::c'), e('f.js::d', 'f.js::b'),
    e('f.js::c', 'f.js::a')
  ];
  return new GraphEngine(nodes, edges);
}

test('impact walks dependents (reverse edges) with correct depth', () => {
  const g = new GraphEngine(
    ['a', 'b', 'c', 'd'].map(id => n(`f.js::${id}`)),
    [e('f.js::a', 'f.js::b'), e('f.js::b', 'f.js::c'), e('f.js::d', 'f.js::b')]
  );
  const r = g.impactAnalysis('f.js::c');
  assert.equal(r.resolved, true);
  assert.deepEqual(r.direct.map(x => x.id), ['f.js::b']);
  assert.deepEqual(r.indirect.map(x => x.id).sort(), ['f.js::a', 'f.js::d']);
  assert.equal(r.totalAffected, 3);
  assert.equal(r.indirect.every(x => x.depth === 2), true);
});

test('impact does NOT include things the target depends on', () => {
  const g = sample();
  const ids = g.impactAnalysis('f.js::a').affected.map(x => x.id);
  assert.ok(!ids.includes('f.js::x'));
  // d only calls b; nothing depends on d
  assert.equal(g.impactAnalysis('f.js::d').totalAffected, 0);
});

test('impact terminates on cycles and never lists the start node', () => {
  const r = sample().impactAnalysis('f.js::a', 10);
  assert.ok(!r.affected.some(x => x.id === 'f.js::a'));
  assert.equal(r.totalAffected, new Set(r.affected.map(x => x.id)).size);
});

test('impact respects the depth limit', () => {
  const g = new GraphEngine(
    ['a', 'b', 'c'].map(id => n(`f.js::${id}`)),
    [e('f.js::a', 'f.js::b'), e('f.js::b', 'f.js::c')]
  );
  assert.equal(g.impactAnalysis('f.js::c', 1).totalAffected, 1);
  assert.equal(g.impactAnalysis('f.js::c', 2).totalAffected, 2);
});

test('impact ignores structural "defines" edges', () => {
  const g = new GraphEngine(
    [n('f.js', 'file'), n('f.js::fn')],
    [e('f.js', 'f.js::fn', 'defines')]
  );
  assert.equal(g.impactAnalysis('f.js::fn').totalAffected, 0);
});

test('impact on unknown node reports an error instead of throwing', () => {
  const r = sample().impactAnalysis('nope');
  assert.equal(r.resolved, false);
  assert.match(r.error, /not found/i);
});

test('empty graph is handled', () => {
  const g = new GraphEngine([], []);
  assert.equal(g.getSummary().totalNodes, 0);
  assert.deepEqual(g.deadCode(), []);
  assert.deepEqual(g.search('x'), []);
});

test('deadCode: uncalled function is confirmed, called one is not', () => {
  const g = new GraphEngine(
    [n('lib.js::used', 'function'), n('lib.js::unused', 'function'), n('app.js::run', 'function')],
    [e('app.js::run', 'lib.js::used')]
  );
  const dead = g.deadCode().map(d => [d.id, d.confidence]);
  assert.deepEqual(dead.find(d => d[0] === 'lib.js::unused'), ['lib.js::unused', 'confirmed']);
  assert.ok(!dead.some(d => d[0] === 'lib.js::used'));
});

test('deadCode: self-recursion does not count as a caller', () => {
  const g = new GraphEngine([n('lib.js::rec')], [e('lib.js::rec', 'lib.js::rec')]);
  assert.equal(g.deadCode().length, 1);
});

test('deadCode: exported / entry / main / dunder / duplicate-name are only "possible"', () => {
  const g = new GraphEngine([
    n('lib.js::pub', 'function', { exported: true }),
    n('server.js::boot', 'function'),
    n('lib.py::main()', 'function', { language: 'python' }),
    n('lib.py::__init__()', 'function', { language: 'python' }),
    n('a.js::dup', 'function'), n('b.js::dup', 'function')
  ], []);
  const byId = Object.fromEntries(g.deadCode().map(d => [d.id, d]));
  for (const id of ['lib.js::pub', 'server.js::boot', 'lib.py::main()', 'lib.py::__init__()', 'a.js::dup', 'b.js::dup']) {
    assert.equal(byId[id].confidence, 'possible', id);
    assert.ok(byId[id].reasons.length > 0, id);
  }
});

test('deadCode: confirmed findings sort first', () => {
  const g = new GraphEngine([n('lib.js::pub', 'function', { exported: true }), n('lib.js::zzz')], []);
  assert.equal(g.deadCode()[0].confidence, 'confirmed');
});

test('search is case-insensitive and capped', () => {
  const nodes = Array.from({ length: 50 }, (_, i) => n(`f.js::Handler${i}`));
  const g = new GraphEngine(nodes, []);
  assert.equal(g.search('handler').length, 30);
});

test('getPathBetween finds a path and returns [] when none exists', () => {
  const g = new GraphEngine(['a', 'b', 'c', 'z'].map(id => n(`f.js::${id}`)), [e('f.js::a', 'f.js::b'), e('f.js::b', 'f.js::c')]);
  assert.equal(g.getPathBetween('f.js::a', 'f.js::c').length, 2);
  assert.deepEqual(g.getPathBetween('f.js::a', 'f.js::z'), []);
});
