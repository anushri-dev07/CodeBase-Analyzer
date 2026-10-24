// Babel is only needed for JS/TS parsing. When it is not installed (e.g. offline sandbox),
// stub it so Java/Python/graph tests still run; JS-specific tests check `HAS_BABEL` and skip.
let HAS_BABEL = true;
try { require.resolve('@babel/parser'); require('@babel/parser'); require('@babel/traverse'); }
catch { HAS_BABEL = false; }
if (!HAS_BABEL) {
  const Module = require('module'); const orig = Module._load;
  Module._load = function (req, ...a) {
    if (req === '@babel/parser') return { parse() { throw new Error('babel unavailable'); } };
    if (req === '@babel/traverse') return { default() {} };
    return orig.call(this, req, ...a);
  };
}
module.exports = { HAS_BABEL };
