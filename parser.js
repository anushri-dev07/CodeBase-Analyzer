const fs = require('fs');
const path = require('path');
const babelParser = require('@babel/parser');
const { default: traverse } = require('@babel/traverse');

const IGNORED_DIRS = new Set([
  'node_modules', 'bower_components', '.git', '.hg', '.svn',
  '.venv', 'venv', 'virtualenv', 'env', 'site-packages', '__pycache__',
  '.tox', '.eggs', '.cache', '.parcel-cache',
  'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.turbo', '.angular',
  'coverage', 'htmlcov', '.pytest_cache', '.ruff_cache', '.mypy_cache',
  'target', 'vendor', 'Pods', '.idea', '.vscode', '.gradle', '.mvn', '.terraform'
]);

// A path is ignored if any directory segment is a known dependency/cache/build
// folder (or a hidden directory). Mirrors the client-side filter in index.html.
function isIgnoredPath(relPath) {
  const parts = norm(relPath).split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    const s = parts[i];
    if (IGNORED_DIRS.has(s)) return true;
    if (s.startsWith('.') && s !== '.' && s !== '..') return true;
  }
  return false;
}
const CODE_EXT = ['.js', '.jsx', '.ts', '.tsx', '.java', '.py'];
const FILE_EXT_CANDIDATES = ['.js', '.jsx', '.ts', '.tsx', '.py'];
const INDEX_CANDIDATES = ['index.js', 'index.jsx', 'index.ts', 'index.tsx', 'index.py', '__init__.py'];

function norm(p) {
  return (p || '').replace(/\\/g, '/');
}

function baseName(p) {
  return p.split(/[\\/]/).pop();
}

function lineAt(content, index) {
  if (index == null || index < 0) return null;
  return content.slice(0, index).split('\n').length;
}

// Resolve an import specifier into the SAME id-space as file nodes (posix, relative
// to the scan root). External packages keep the "npm:" prefix.
function resolveModuleSource(currentFile, importPath) {
  if (!importPath) return '';
  if (importPath.startsWith('.')) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(currentFile), importPath));
  }
  return 'npm:' + importPath;
}

function parseFile(filePath, content, relPath) {
  const ext = path.extname(filePath).toLowerCase();
  if (content === undefined || content === null) content = fs.readFileSync(filePath, 'utf-8');
  const relativePath = norm(relPath || baseName(filePath));

  try {
    if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
      return parseJS(relativePath, baseName(filePath), content);
    } else if (ext === '.java') {
      return parseJava(relativePath, baseName(filePath), content);
    } else if (ext === '.py') {
      return parsePython(relativePath, baseName(filePath), content);
    }
  } catch (e) {
    // silently skip unparseable files
  }

  return { nodes: [], edges: [], imports: {} };
}

// ===== JavaScript / TypeScript =====
function parseJS(relativePath, fileName, content) {
  const nodes = [];
  const edges = [];
  const imports = {}; // localName -> { file, name }
  const exportedNames = new Set();

  nodes.push({ id: relativePath, label: fileName, type: 'file', file: relativePath, language: 'js', line: 1 });

  let ast;
  try {
    ast = babelParser.parse(content, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript', 'decorators-legacy', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator']
    });
  } catch {
    try {
      ast = babelParser.parse(content, {
        sourceType: 'script',
        plugins: ['jsx', 'typescript', 'decorators-legacy', 'classProperties']
      });
    } catch {
      return { nodes, edges, imports };
    }
  }

  function addImportEdge(source, label) {
    edges.push({
      from: relativePath,
      to: resolveModuleSource(relativePath, source),
      label,
      type: 'imports',
      weight: 10
    });
  }

  traverse(ast, {
    ImportDeclaration(p) {
      const source = p.node.source.value;
      const specs = p.node.specifiers.map(s => {
        const local = s.local.name;
        const sourceName = s.type === 'ImportDefaultSpecifier' ? 'default'
          : s.type === 'ImportNamespaceSpecifier' ? '*'
            : s.imported?.name || local;
        return { local, sourceName };
      });

      specs.forEach(spec => {
        imports[spec.local] = { file: resolveModuleSource(relativePath, source), name: spec.sourceName };
        addImportEdge(source, `imports ${spec.local}`);
      });
      if (!specs.length) addImportEdge(source, 'imports');
    },

    ExportNamedDeclaration(p) {
      if (p.node.source) {
        edges.push({
          from: relativePath,
          to: resolveModuleSource(relativePath, p.node.source.value),
          label: 're-exports',
          type: 'exports',
          weight: 8
        });
      }
      const decl = p.node.declaration;
      if (decl) {
        if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
          if (decl.id) exportedNames.add(decl.id.name);
        } else if (decl.type === 'VariableDeclaration') {
          decl.declarations.forEach(d => { if (d.id?.name) exportedNames.add(d.id.name); });
        }
      }
      (p.node.specifiers || []).forEach(s => {
        const n = s.local?.name || s.exported?.name;
        if (n) exportedNames.add(n);
      });
    },

    ExportDefaultDeclaration(p) {
      const decl = p.node.declaration;
      if (decl && (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id) {
        exportedNames.add(decl.id.name);
      } else if (decl && decl.type === 'Identifier') {
        exportedNames.add(decl.name);
      }
    },

    CallExpression(p) {
      const call = p.node;
      if (call.callee?.type === 'Identifier' && call.callee.name === 'require'
          && call.arguments.length === 1 && call.arguments[0].type === 'StringLiteral') {
        const source = call.arguments[0].value;
        addImportEdge(source, 'requires ' + source);
        const declarator = p.parentPath?.isVariableDeclarator() ? p.parentPath.node : null;
        if (declarator) {
          const targetFile = resolveModuleSource(relativePath, source);
          if (declarator.id.type === 'Identifier') {
            imports[declarator.id.name] = { file: targetFile, name: 'default' };
          } else if (declarator.id.type === 'ObjectPattern') {
            declarator.id.properties.forEach(prop => {
              if (prop.type !== 'ObjectProperty') return;
              const importedName = prop.key.name || prop.key.value;
              const localName = prop.value.type === 'Identifier' ? prop.value.name
                : prop.value.type === 'AssignmentPattern' && prop.value.left.type === 'Identifier' ? prop.value.left.name : null;
              if (importedName && localName) imports[localName] = { file: targetFile, name: String(importedName) };
            });
          }
        }
      }
      if (isExpressRoute(p.node)) {
        const method = (p.node.callee.property?.name || 'use').toUpperCase();
        const args = p.node.arguments;
        let routePath = '/';
        if (args.length > 0 && args[0].type === 'StringLiteral') routePath = args[0].value;
        const routeId = `${relativePath}::${method} ${routePath}`;
        nodes.push({
          id: routeId,
          label: `${method} ${routePath}`,
          type: 'api',
          file: relativePath,
          language: 'js',
          parent: relativePath,
          line: p.node.loc?.start.line || null
        });
        edges.push({ from: relativePath, to: routeId, label: `defines ${method} ${routePath}`, type: 'defines', weight: 10 });
        for (let i = 1; i < args.length; i++) {
          if (args[i].type === 'Identifier') {
            edges.push({
              from: routeId,
              to: args[i].name,
              label: `calls ${args[i].name}`,
              type: 'calls',
              res: 'symbol',
              weight: 9,
              line: args[i].loc?.start.line || null
            });
          }
        }
      }
    },

    FunctionDeclaration(p) {
      if (p.node.id) {
        const fnId = `${relativePath}::${p.node.id.name}`;
        nodes.push({
          id: fnId,
          label: `${p.node.id.name}()`,
          type: 'function',
          file: relativePath,
          language: 'js',
          parent: relativePath,
          line: p.node.loc?.start.line || null
        });
        edges.push({ from: relativePath, to: fnId, label: `defines ${p.node.id.name}()`, type: 'defines', weight: 10 });
        extractCalls(p.node, relativePath, p.node.id.name, edges);
      }
    },

    VariableDeclarator(p) {
      if (p.node.init && (
        p.node.init.type === 'ArrowFunctionExpression' ||
        p.node.init.type === 'FunctionExpression'
      ) && p.node.id.type === 'Identifier') {
        const fnId = `${relativePath}::${p.node.id.name}`;
        nodes.push({
          id: fnId,
          label: `${p.node.id.name} = ()`,
          type: 'function',
          file: relativePath,
          language: 'js',
          parent: relativePath,
          line: p.node.loc?.start.line || null
        });
        edges.push({ from: relativePath, to: fnId, label: `defines ${p.node.id.name}`, type: 'defines', weight: 10 });
        extractCalls(p.node.init, relativePath, p.node.id.name, edges);
      }
    },

    ClassDeclaration(p) {
      if (p.node.id) {
        const clsId = `${relativePath}::${p.node.id.name}`;
        nodes.push({
          id: clsId,
          label: p.node.id.name,
          type: 'class',
          file: relativePath,
          language: 'js',
          parent: relativePath,
          line: p.node.loc?.start.line || null
        });
        edges.push({ from: relativePath, to: clsId, label: `defines class ${p.node.id.name}`, type: 'defines', weight: 10 });
      }
    },

    AssignmentExpression(p) {
      const left = p.node.left;
      // module.exports.foo = ... / exports.foo = ...
      if (left.type === 'MemberExpression' && left.property?.type === 'Identifier') {
        const obj = left.object;
        const isModuleExports = obj.type === 'MemberExpression' && obj.property?.name === 'exports';
        const isExports = obj.type === 'Identifier' && obj.name === 'exports';
        if (isModuleExports || isExports) {
          exportedNames.add(left.property.name);
          edges.push({
            from: relativePath,
            to: `${relativePath}::${left.property.name}`,
            label: `exports ${left.property.name}`,
            type: 'exports',
            weight: 8
          });
        }
      }
      // module.exports = { a, b, ... }
      if (left.type === 'MemberExpression' && left.object?.type === 'Identifier' && left.object.name === 'module' && left.property?.name === 'exports' && p.node.right?.type === 'ObjectExpression') {
        p.node.right.properties.forEach(pr => {
          const key = pr.key?.name || pr.key?.value;
          if (key) exportedNames.add(String(key));
        });
      }
    }
  });

  // Capture calls made at module top-level (e.g. main();) so entry functions aren't "dead".
  extractTopLevelCalls(ast.program, relativePath, edges);

  // Model detection: mongoose model
  const modelMatches = content.matchAll(/mongoose\.model\s*\(\s*['"`](.+?)['"`]/g);
  for (const m of modelMatches) {
    const modelId = `${relativePath}::Model:${m[1]}`;
    nodes.push({
      id: modelId,
      label: `📦 ${m[1]}`,
      type: 'model',
      file: relativePath,
      language: 'js',
      parent: relativePath,
      line: lineAt(content, m.index)
    });
    edges.push({ from: relativePath, to: modelId, label: `defines model ${m[1]}`, type: 'defines', weight: 10 });
  }

  // Mark exports on their symbol nodes
  nodes.forEach(n => {
    if ((n.type === 'function' || n.type === 'class') && n.id.includes('::')) {
      const name = n.id.slice(n.id.indexOf('::') + 2).replace(/\(\)$/, '');
      if (exportedNames.has(name)) n.exported = true;
    }
  });

  return { nodes, edges, imports };
}

const DB_METHODS = ['find', 'findById', 'findOne', 'save', 'create', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'populate', 'aggregate'];
const LANG_GLOBALS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'require', 'console', 'super', 'import', 'new', 'await', 'delete', 'void', 'in', 'of', 'do', 'else']);

function extractCalls(fnNode, file, fnName, edges) {
  const seen = new Set();
  const from = `${file}::${fnName}`;
  (function walk(n) {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    if (n.type === 'CallExpression' && n.callee) {
      if (n.callee.type === 'Identifier') {
        const name = n.callee.name;
        if (!LANG_GLOBALS.has(name)) {
          edges.push({ from, to: name, label: `calls ${name}()`, type: 'calls', res: 'symbol', weight: 3, line: n.loc?.start.line || null });
        }
      } else if (n.callee.type === 'MemberExpression' && n.callee.property?.type === 'Identifier') {
        const p = n.callee.property.name;
        if (DB_METHODS.includes(p)) {
          edges.push({ from, to: `db::${p}`, label: `db.${p}()`, type: 'calls', weight: 4, line: n.loc?.start.line || null });
        } else if (!LANG_GLOBALS.has(p) && !['then', 'catch', 'map', 'filter', 'forEach', 'push', 'slice', 'join', 'toString', 'json', 'send', 'status', 'log', 'replace', 'split', 'includes', 'indexOf', 'has', 'get', 'set', 'add', 'concat', 'trim', 'toLowerCase', 'toUpperCase'].includes(p)) {
          edges.push({ from, to: p, label: `calls .${p}()`, type: 'calls', res: 'symbol', weight: 2, line: n.loc?.start.line || null });
        }
      }
    }
    for (const k in n) {
      if (k === 'leadingComments' || k === 'trailingComments' || k === 'loc' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (v && typeof v === 'object') walk(v);
    }
  })(fnNode);
}

// Walk only top-level statements (not inside function/class bodies) to catch module init calls.
function extractTopLevelCalls(program, file, edges) {
  const seen = new Set();
  const SKIP = new Set(['FunctionDeclaration', 'ClassDeclaration', 'ArrowFunctionExpression', 'FunctionExpression', 'ObjectMethod', 'ClassMethod']);
  (function walk(n) {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    if (n !== program && SKIP.has(n.type)) return;
    if (n.type === 'CallExpression' && n.callee) {
      if (n.callee.type === 'Identifier' && !LANG_GLOBALS.has(n.callee.name)) {
        edges.push({ from: file, to: n.callee.name, label: `calls ${n.callee.name}()`, type: 'calls', res: 'symbol', weight: 3, line: n.loc?.start.line || null });
      } else if (n.callee.type === 'MemberExpression' && n.callee.property?.type === 'Identifier' && DB_METHODS.includes(n.callee.property.name)) {
        edges.push({ from: file, to: `db::${n.callee.property.name}`, label: `db.${n.callee.property.name}()`, type: 'calls', weight: 4, line: n.loc?.start.line || null });
      }
    }
    for (const k in n) {
      if (k === 'leadingComments' || k === 'trailingComments' || k === 'loc' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (v && typeof v === 'object') walk(v);
    }
  })(program);
}

// ===== Java =====
function parseJava(relativePath, fileName, content) {
  const nodes = [];
  const edges = [];

  nodes.push({ id: relativePath, label: fileName, type: 'file', file: relativePath, language: 'java', line: 1 });

  const importRegex = /import\s+(?:static\s+)?([\w.*]+)\s*;/g;
  let m;
  while ((m = importRegex.exec(content)) !== null) {
    const imported = m[1].replace(/\.\*$/, '');
    edges.push({
      from: relativePath,
      to: imported.replace(/\./g, '/') + '.java',
      label: `imports ${imported}`,
      type: 'imports',
      weight: 5,
      line: lineAt(content, m.index)
    });
  }

  const classRegex = /(?:public\s+)?(?:abstract\s+)?(?:class|interface|@interface|enum)\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/g;
  const classNames = [];
  while ((m = classRegex.exec(content)) !== null) {
    const clsName = m[1];
    classNames.push(clsName);
    const clsId = `${relativePath}::${clsName}`;
    const extendsCls = m[2];
    const implementsIfaces = m[3] ? m[3].split(',').map(s => s.trim()) : [];

    nodes.push({ id: clsId, label: clsName, type: 'class', file: relativePath, language: 'java', parent: relativePath, line: lineAt(content, m.index) });
    edges.push({ from: relativePath, to: clsId, label: `defines class ${clsName}`, type: 'defines', weight: 10 });

    if (extendsCls && extendsCls !== 'Object') {
      edges.push({ from: clsId, to: `${relativePath}::${extendsCls}`, label: `extends ${extendsCls}`, type: 'extends', weight: 8 });
    }
    implementsIfaces.forEach(iface => {
      if (iface) edges.push({ from: clsId, to: `${relativePath}::${iface}`, label: `implements ${iface}`, type: 'implements', weight: 7 });
    });
  }

  const methodRegex = /(?:public|private|protected|static)\s+(?:<\w+>)?\s*(\w+(?:\[\])?(?:<\w+>)?)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w,\s]+)?\{/g;
  while ((m = methodRegex.exec(content)) !== null) {
    const methodName = m[2];
    // Skip constructors (name === class name) — they add no callable symbol.
    if (classNames.includes(methodName)) continue;
    const methodId = `${relativePath}::${methodName}()`;
    nodes.push({ id: methodId, label: `${methodName}()`, type: 'function', file: relativePath, language: 'java', parent: relativePath, line: lineAt(content, m.index) });
    edges.push({ from: relativePath, to: methodId, label: `defines ${methodName}()`, type: 'defines', weight: 10 });
    const body = extractJavaBody(content, m.index + m[0].length - 1); // index of the opening '{'
    if (body) {
      const callRegex = /(\w+)\s*\(/g;
      let cm;
      const seenCalls = new Set();
      while ((cm = callRegex.exec(body.text)) !== null) {
        const callee = cm[1];
        if (['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'super', 'this', 'synchronized'].includes(callee)) continue;
        if (seenCalls.has(callee)) continue;
        seenCalls.add(callee);
        edges.push({ from: methodId, to: callee, label: `calls ${callee}()`, type: 'calls', res: 'symbol', weight: 3, line: lineAt(content, body.start + cm.index) });
      }
    }
  }

  const springTypes = ['@Controller', '@RestController', '@Service', '@Repository', '@Component', '@Configuration'];
  springTypes.forEach(st => {
    const idx = content.indexOf(st);
    if (idx !== -1) {
      nodes.push({ id: `${relativePath}::${st.replace('@', '')}`, label: st, type: 'annotation', file: relativePath, language: 'java', parent: relativePath, line: lineAt(content, idx) });
      edges.push({ from: relativePath, to: `${relativePath}::${st.replace('@', '')}`, label: `annotated ${st}`, type: 'annotates', weight: 6 });
    }
  });

  const mappingRegex = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|RequestMapping)\s*\(\s*(?:"([^"]+)"|'([^']+)'|value\s*=\s*"([^"]+)")/g;
  while ((m = mappingRegex.exec(content)) !== null) {
    const method = m[1].replace('Mapping', '').toUpperCase();
    const routePath = m[2] || m[3] || m[4] || '/';
    const routeId = `${relativePath}::${method} ${routePath}`;
    nodes.push({ id: routeId, label: `${method} ${routePath}`, type: 'api', file: relativePath, language: 'java', parent: relativePath, line: lineAt(content, m.index) });
    edges.push({ from: relativePath, to: routeId, label: `defines ${method} ${routePath}`, type: 'defines', weight: 10 });
  }

  return { nodes, edges, imports: {} };
}

// Extract a Java method body by matching braces from the opening brace.
function extractJavaBody(content, startIndex) {
  let depth = 0, started = false;
  for (let i = startIndex; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') { depth--; if (started && depth === 0) return { text: content.slice(startIndex, i), start: startIndex }; }
  }
  return null;
}

// ===== Python =====
// Resolve a Python module reference ("a.b", ".utils", "..pkg.mod") to a file id.
function pythonModulePath(mod, currentFile) {
  if (!mod) return null;
  if (mod.startsWith('.')) {
    const dots = (mod.match(/^\.+/) || [''])[0].length;
    const rest = mod.slice(dots).replace(/\./g, '/');
    const up = '../'.repeat(Math.max(0, dots - 1));
    return path.posix.join(path.posix.dirname(currentFile), up + rest) + '.py';
  }
  return mod.replace(/\./g, '/') + '.py';
}

function parsePython(relativePath, fileName, content) {
  const nodes = [];
  const edges = [];

  nodes.push({ id: relativePath, label: fileName, type: 'file', file: relativePath, language: 'python', line: 1 });

  const pyImports = {}; // localName -> { file, name } so calls can resolve through "from x import y"
  const importRegex = /^(?:from\s+([.\w]+)\s+)?import\s+([^\n#]+)/gm;
  let m;
  while ((m = importRegex.exec(content)) !== null) {
    const module = m[1] || '';
    const targets = m[2].replace(/[()\\]/g, ' ').split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    targets.forEach(t => {
      // "from . import x" / "from .. import x": the module is the package itself, x is a sibling module.
      if (/^\.+$/.test(module)) {
        const dots = module.length;
        const base = path.posix.join(path.posix.dirname(relativePath), '../'.repeat(dots - 1));
        edges.push({ from: relativePath, to: path.posix.normalize(base + '/' + t) + '.py', label: `imports ${t}`, type: 'imports', weight: 5, line: lineAt(content, m.index) });
        return;
      }
      if (module && t !== '*' && /^\w+$/.test(t)) pyImports[t] = { file: pythonModulePath(module, relativePath), name: t };
      if (t === '*') {
        edges.push({ from: relativePath, to: pythonModulePath(module, relativePath), label: `imports * from ${module}`, type: 'imports', weight: 5, line: lineAt(content, m.index) });
      } else {
        edges.push({
          from: relativePath,
          to: module ? pythonModulePath(module, relativePath) : resolveModuleSource(relativePath, t),
          label: `imports ${t}`,
          type: 'imports',
          weight: 5,
          line: lineAt(content, m.index)
        });
      }
    });
  }

  const defs = [];
  const funcRegex = /^([ \t]*)(?:async\s+)?def\s+(\w+)\s*\(/gm;
  while ((m = funcRegex.exec(content)) !== null) {
    defs.push({ name: m[2], indent: m[1].length, start: m.index, bodyStart: m.index + m[0].length });
  }

  const classRegex = /^([ \t]*)class\s+(\w+)(?:\s*\(([^)]*)\))?:/gm;
  while ((m = classRegex.exec(content)) !== null) {
    const clsId = `${relativePath}::${m[1] || ''}class::${m[2]}`;
    nodes.push({ id: clsId, label: m[2], type: 'class', file: relativePath, language: 'python', parent: relativePath, line: lineAt(content, m.index) });
    edges.push({ from: relativePath, to: clsId, label: `defines class ${m[2]}`, type: 'defines', weight: 10 });
    if (m[3]) {
      m[3].split(',').map(s => s.trim()).forEach(p => {
        if (p && p !== 'object') edges.push({ from: clsId, to: p, label: `extends ${p}`, type: 'extends', res: 'symbol', weight: 8 });
      });
    }
  }

  defs.forEach((d, i) => {
    const fnId = `${relativePath}::${d.name}()`;
    nodes.push({ id: fnId, label: `${d.name}()`, type: 'function', file: relativePath, language: 'python', parent: relativePath, line: lineAt(content, d.start) });
    edges.push({ from: relativePath, to: fnId, label: `defines ${d.name}()`, type: 'defines', weight: 10 });

    // Body = up to the next def/class at the same or lower indentation (or EOF).
    let end = content.length;
    const boundaries = defs.map(x => x.start).concat([...content.matchAll(/^([ \t]*)class\s+\w+/gm)].map(x => x.index)).sort((a, b) => a - b);
    for (const b of boundaries) if (b > d.start) { end = b; break; }
    const body = content.slice(d.bodyStart, end);
    const seen = new Set();
    const callRegex = /(?<![.\w])([A-Za-z_]\w*)\s*\(/g;
    let cm;
    while ((cm = callRegex.exec(body)) !== null) {
      const callee = cm[1];
      if (['if', 'for', 'while', 'return', 'print', 'super', 'isinstance', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple', 'open', 'enumerate', 'zip', 'type', 'self'].includes(callee)) continue;
      if (seen.has(callee)) continue;
      seen.add(callee);
      edges.push({ from: fnId, to: callee, label: `calls ${callee}()`, type: 'calls', res: 'symbol', weight: 3, line: lineAt(content, d.bodyStart + cm.index) });
    }
  });

  const routeRegex = /@(\w+)(?:\.\w+)?\.(?:route|get|post|put|delete|patch)\s*\(\s*(?:"([^"]+)"|'([^']+)')/g;
  while ((m = routeRegex.exec(content)) !== null) {
    const routePath = m[2] || m[3] || '/';
    const routeId = `${relativePath}::ROUTE ${routePath}`;
    nodes.push({ id: routeId, label: `ROUTE ${routePath}`, type: 'api', file: relativePath, language: 'python', parent: relativePath, line: lineAt(content, m.index) });
    edges.push({ from: relativePath, to: routeId, label: `defines route ${routePath}`, type: 'defines', weight: 10 });
  }

  return { nodes, edges, imports: pyImports };
}

function isExpressRoute(node) {
  if (node.callee?.type !== 'MemberExpression') return false;
  const obj = node.callee.object;
  const prop = node.callee.property;
  if (!prop || prop.type !== 'Identifier') return false;
  const methods = ['get', 'post', 'put', 'delete', 'patch', 'use', 'all'];
  return methods.includes(prop.name) && (
    (obj.type === 'Identifier' && ['app', 'router', 'route'].includes(obj.name)) ||
    (obj.type === 'MemberExpression' && obj.property?.name === 'Router')
  );
}

// Map a raw resolved path onto an actual file id (tries extensions + index files).
// `suffixIdx` (optional) maps a path suffix -> file ids, so "com/a/Bar.java" can match
// "src/main/java/com/a/Bar.java" when the scan root is not the language source root.
function pickFileTarget(raw, fileIds, suffixIdx) {
  if (!raw) return null;
  if (fileIds.has(raw)) return raw;
  const cands = [];
  FILE_EXT_CANDIDATES.forEach(e => cands.push(raw + e));
  INDEX_CANDIDATES.forEach(e => cands.push(raw + '/' + e));
  if (raw.endsWith('.py')) cands.push(raw.slice(0, -3) + '/__init__.py');
  const hit = cands.find(c => fileIds.has(c));
  if (hit) return hit;
  if (suffixIdx && (raw.endsWith('.java') || raw.endsWith('.py'))) {
    for (const c of [raw, ...(raw.endsWith('.py') ? [raw.slice(0, -3) + '/__init__.py'] : [])]) {
      const ids = suffixIdx.get(c);
      if (ids && ids.length === 1) return ids[0]; // only when unambiguous
    }
  }
  return null;
}

function buildSuffixIndex(fileIds) {
  const idx = new Map();
  fileIds.forEach(id => {
    const parts = id.split('/');
    for (let i = 1; i < parts.length; i++) {
      const s = parts.slice(i).join('/');
      if (!idx.has(s)) idx.set(s, []);
      idx.get(s).push(id);
    }
  });
  return idx;
}

// Simple (call-site) name of a symbol id: "f.py::thing()" -> "thing", "f.py::  class::Foo" -> "Foo".
function simpleName(id) {
  const i = id.indexOf('::');
  if (i === -1) return null;
  return id.slice(i + 2).replace(/^\s*class::/, '').replace(/\(\)$/, '');
}

// Post-process a parsed graph so edges point at real nodes.
function resolveGraph(nodes, edges, importsByFile) {
  importsByFile = importsByFile || {};
  const nodeIds = new Set(nodes.map(n => n.id));
  const fileIds = new Set(nodes.filter(n => n.type === 'file').map(n => n.id));
  const suffixIdx = buildSuffixIndex(fileIds);
  const byName = new Map();
  nodes.forEach(n => {
    if (n.type === 'function' || n.type === 'class') {
      const nm = simpleName(n.id);
      if (nm) {
        if (!byName.has(nm)) byName.set(nm, []);
        byName.get(nm).push(n.id);
      }
    }
  });
  // Find a symbol node in `file` by simple name, whatever its id decoration (name, name(), class::name).
  const symbolIn = (file, name) => {
    for (const c of [name, name + '()', 'class::' + name]) if (nodeIds.has(file + '::' + c)) return file + '::' + c;
    return null;
  };

  // Resolve import/export targets onto file ids.
  edges.forEach(e => {
    if (e.type !== 'imports' && e.type !== 'exports') return;
    if (e.to.startsWith('npm:') || e.to.startsWith('db::')) return;
    if (nodeIds.has(e.to)) return;
    const hit = pickFileTarget(e.to, fileIds, suffixIdx);
    if (hit) e.to = hit;
    else e.unresolvedTarget = true;
  });

  const kept = [];
  for (const e of edges) {
    if (e.type === 'calls') {
      // Support/DB pseudo-targets never correspond to real nodes.
      if (e.to.startsWith('db::') || e.to.startsWith('npm:')) continue;
      const fromFile = e.from.includes('::') ? e.from.slice(0, e.from.indexOf('::')) : e.from;
      const name = e.to;
      let resolvedTo = null;
      if (nodeIds.has(name)) {
        resolvedTo = name; // already a full id
      } else if (symbolIn(fromFile, name)) {
        resolvedTo = symbolIn(fromFile, name);
      } else {
        const im = importsByFile[fromFile];
        if (im && im[name]) {
          const tgtFile = pickFileTarget(im[name].file, fileIds, suffixIdx);
          const sym = tgtFile && symbolIn(tgtFile, im[name].name);
          if (sym) resolvedTo = sym;
          else if (tgtFile && fileIds.has(tgtFile)) resolvedTo = tgtFile;
          else if (nodeIds.has(im[name].file + '::' + im[name].name)) resolvedTo = im[name].file + '::' + im[name].name;
        }
        if (!resolvedTo) {
          const g = byName.get(name);
          if (g && g.length === 1) resolvedTo = g[0];
        }
      }
      if (resolvedTo) { e.to = resolvedTo; delete e.res; kept.push(e); }
      continue; // unresolved calls are dropped (external/builtin/method)
    }
    if ((e.type === 'extends' || e.type === 'implements') && !nodeIds.has(e.to)) {
      const nm = e.to.includes('::') ? simpleName(e.to) : e.to;
      const g = byName.get(nm);
      if (g && g.length === 1) e.to = g[0]; // unique class name across the project
      else continue;                       // ambiguous/external base class: don't guess
      delete e.res;
    }
    if ((e.type === 'imports' || e.type === 'exports') && e.unresolvedTarget) continue; // drop dangling local imports
    kept.push(e);
  }

  // Final safety net: never emit an edge pointing at a node that doesn't exist.
  const safe = kept.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to));
  return { nodes, edges: safe };
}

function scanDirectory(dirPath) {
  const allNodes = [];
  const allEdges = [];
  const importsByFile = {};
  const seen = new Set();

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_EXT.includes(ext)) {
          const rel = norm(path.relative(dirPath, fullPath));
          const result = parseFile(fullPath, undefined, rel);
          result.nodes.forEach(n => {
            if (!seen.has(n.id)) { seen.add(n.id); allNodes.push(n); }
          });
          result.edges.forEach(e => allEdges.push(e));
          if (result.imports && Object.keys(result.imports).length) importsByFile[rel] = result.imports;
        }
      }
    }
  }

  walk(dirPath);
  const resolved = resolveGraph(allNodes, allEdges, importsByFile);
  return { nodes: resolved.nodes, edges: resolved.edges };
}

module.exports = { parseFile, scanDirectory, parseJS, parseJava, parsePython, resolveGraph, isIgnoredPath, IGNORED_DIRS };
