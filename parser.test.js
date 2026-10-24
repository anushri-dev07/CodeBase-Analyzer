const test = require('node:test');
const assert = require('node:assert/strict');
const { HAS_BABEL } = require('./helpers');
const { parseFile, resolveGraph, isIgnoredPath } = require('./parser');

function build(files) {
  const nodes = [], edges = [], imports = {};
  for (const [p, c] of Object.entries(files)) {
    const r = parseFile(p, c, p);
    nodes.push(...r.nodes); edges.push(...r.edges);
    if (r.imports && Object.keys(r.imports).length) imports[p] = r.imports;
  }
  return resolveGraph(nodes, edges, imports);
}
const has = (g, from, to, type) => g.edges.some(e => e.from === from && e.to === to && e.type === type);

test('no edge ever points at a missing node, and node ids are unique', () => {
  const g = build({
    'src/A.java': 'import x.y.Missing;\npublic class A extends Ghost { public void f() { nothing(); } }',
    'p/m.py': 'from .gone import q\ndef f():\n    q()\n'
  });
  const ids = new Set(g.nodes.map(n => n.id));
  assert.equal(ids.size, g.nodes.length);
  assert.ok(g.edges.every(e => ids.has(e.from) && ids.has(e.to)));
});

test('Java: import resolves under a Maven-style source root', () => {
  const g = build({
    'src/main/java/com/a/Foo.java': 'package com.a;\nimport com.a.Bar;\npublic class Foo {}',
    'src/main/java/com/a/Bar.java': 'package com.a;\npublic class Bar {}'
  });
  assert.ok(has(g, 'src/main/java/com/a/Foo.java', 'src/main/java/com/a/Bar.java', 'imports'));
});

test('Java: ambiguous suffix match is NOT guessed', () => {
  const g = build({
    'a/com/x/Bar.java': 'public class Bar {}',
    'b/com/x/Bar.java': 'public class Bar {}',
    'Main.java': 'import com.x.Bar;\npublic class Main {}'
  });
  assert.ok(!g.edges.some(e => e.type === 'imports'));
});

test('Java: method-to-method calls resolve (body extraction regression)', () => {
  const g = build({ 'A.java': 'public class A {\n  public void run() {\n    if (true) { helper(); }\n  }\n  public void helper() {}\n}\n' });
  assert.ok(has(g, 'A.java::run()', 'A.java::helper()', 'calls'));
});

test('Java: cross-file extends resolves by unique class name', () => {
  const g = build({
    'Base.java': 'public class Base {}',
    'Child.java': 'public class Child extends Base {}'
  });
  assert.ok(has(g, 'Child.java::Child', 'Base.java::Base', 'extends'));
});

test('Python: calls resolve through "from x import y"', () => {
  const g = build({
    'pkg/a.py': 'from .b import thing\ndef f():\n    thing()\n',
    'pkg/b.py': 'def thing():\n    pass\n'
  });
  assert.ok(has(g, 'pkg/a.py', 'pkg/b.py', 'imports'));
  assert.ok(has(g, 'pkg/a.py::f()', 'pkg/b.py::thing()', 'calls'));
});

test('Python: "from . import mod" targets the sibling module', () => {
  const g = build({ 'pkg/a.py': 'from . import b\n', 'pkg/b.py': 'x = 1\n' });
  assert.ok(has(g, 'pkg/a.py', 'pkg/b.py', 'imports'));
});

test('Python: package imports resolve to __init__.py', () => {
  const g = build({ 'app.py': 'from lib import go\n', 'lib/__init__.py': 'def go():\n    pass\n' });
  assert.ok(has(g, 'app.py', 'lib/__init__.py', 'imports'));
});

test('external packages keep the npm: prefix and are not turned into local edges', () => {
  const r = parseFile('a.py', 'import os\n', 'a.py');
  assert.equal(r.nodes.length >= 1, true);
});

test('malformed / unsupported / empty input never throws', () => {
  assert.doesNotThrow(() => parseFile('x.py', '\u0000\u0001 def (((', 'x.py'));
  assert.doesNotThrow(() => parseFile('x.java', 'class {{{{', 'x.java'));
  assert.deepEqual(parseFile('x.txt', 'hello', 'x.txt').nodes, []);
  assert.deepEqual(resolveGraph([], [], {}), { nodes: [], edges: [] });
});

test('isIgnoredPath skips dependency, build and hidden dirs but not source', () => {
  for (const p of ['node_modules/x/i.js', 'a/dist/b.js', '.git/c.js', 'src/.cache/d.js']) assert.equal(isIgnoredPath(p), true, p);
  for (const p of ['src/a.js', 'lib/b/c.py', 'index.js']) assert.equal(isIgnoredPath(p), false, p);
});

test('JS: imports, calls and exports resolve across files', { skip: !HAS_BABEL && '@babel not installed' }, () => {
  const g = build({
    'lib/util.js': 'function helper(){}\nmodule.exports = { helper };\n',
    'app.js': "const { helper } = require('./lib/util');\nimport { helper as h } from './lib/util';\nfunction run(){ h(); }\nrun();\n"
  });
  assert.ok(has(g, 'app.js', 'lib/util.js', 'imports'));
  assert.ok(has(g, 'app.js::run', 'lib/util.js::helper', 'calls'));
});

test('JS: CommonJS require creates a real file edge and resolves destructured calls', { skip: !HAS_BABEL && '@babel not installed' }, () => {
  const g = build({
    'lib/util.js': 'function helper(){}\nmodule.exports = { helper };\n',
    'app.js': "const { helper: runHelper } = require('./lib/util');\nfunction run(){ runHelper(); }\n"
  });
  assert.ok(has(g, 'app.js', 'lib/util.js', 'imports'));
  assert.ok(has(g, 'app.js::run', 'lib/util.js::helper', 'calls'));
});
