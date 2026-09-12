const fs = require('fs');
const path = require('path');
const babelParser = require('@babel/parser');
const { default: traverse } = require('@babel/traverse');

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '__pycache__', '.venv']);

function parseFile(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  if (!content) content = fs.readFileSync(filePath, 'utf-8');
  const nodes = [];
  const edges = [];
  const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');

  try {
    if (ext === '.js' || ext === '.jsx' || ext === '.ts' || ext === '.tsx') {
      return parseJS(filePath, relativePath, content);
    } else if (ext === '.java') {
      return parseJava(filePath, relativePath, content);
    } else if (ext === '.py') {
      return parsePython(filePath, relativePath, content);
    }
  } catch (e) {
    // silently skip unparseable files
  }

  return { nodes, edges };
}

function parseJS(filePath, relativePath, content) {
  const nodes = [];
  const edges = [];

  const fileNode = {
    id: relativePath,
    label: path.basename(filePath),
    type: 'file',
    file: relativePath,
    language: 'js'
  };
  nodes.push(fileNode);

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
      return { nodes, edges };
    }
  }

  traverse(ast, {
    ImportDeclaration(path) {
      const source = path.node.source.value;
      const imported = path.node.specifiers.map(s => {
        const local = s.local.name;
        const sourceName = s.type === 'ImportDefaultSpecifier' ? 'default' :
          s.type === 'ImportNamespaceSpecifier' ? '*' : s.imported?.name || local;
        return { local, sourceName };
      });

      imported.forEach(spec => {
        edges.push({
          from: relativePath,
          to: resolveModuleSource(relativePath, source),
          label: `imports ${spec.local}`,
          type: 'imports',
          weight: 10
        });
      });

      if (imported.length === 0) {
        edges.push({
          from: relativePath,
          to: resolveModuleSource(relativePath, source),
          label: 'imports',
          type: 'imports',
          weight: 5
        });
      }
    },

    ExportNamedDeclaration(path) {
      if (path.node.source) {
        edges.push({
          from: relativePath,
          to: resolveModuleSource(relativePath, path.node.source.value),
          label: 're-exports',
          type: 'exports',
          weight: 8
        });
      }
    },

    CallExpression(path) {
      if (isExpressRoute(path.node)) {
        const method = (path.node.callee.property?.name || 'use').toUpperCase();
        const args = path.node.arguments;
        let routePath = '/';
        if (args.length > 0 && args[0].type === 'StringLiteral') {
          routePath = args[0].value;
        }
        const routeId = `${relativePath}::${method} ${routePath}`;
        nodes.push({
          id: routeId,
          label: `${method} ${routePath}`,
          type: 'api',
          file: relativePath,
          language: 'js',
          parent: relativePath
        });
        edges.push({
          from: relativePath,
          to: routeId,
          label: `defines ${method} ${routePath}`,
          type: 'defines',
          weight: 10
        });
        // link to handler functions
        for (let i = 1; i < args.length; i++) {
          if (args[i].type === 'Identifier') {
            edges.push({
              from: routeId,
              to: `${relativePath}::${args[i].name}`,
              label: `calls ${args[i].name}`,
              type: 'calls',
              weight: 9
            });
          }
        }
      }
    },

    FunctionDeclaration(path) {
      if (path.node.id) {
        const fnId = `${relativePath}::${path.node.id.name}`;
        nodes.push({
          id: fnId,
          label: `${path.node.id.name}()`,
          type: 'function',
          file: relativePath,
          language: 'js',
          parent: relativePath
        });
        edges.push({
          from: relativePath,
          to: fnId,
          label: `defines ${path.node.id.name}()`,
          type: 'defines',
          weight: 10
        });
        extractCalls(path.node, relativePath, edges);
      }
    },

    VariableDeclarator(path) {
      if (path.node.init && (
        path.node.init.type === 'ArrowFunctionExpression' ||
        path.node.init.type === 'FunctionExpression'
      ) && path.node.id.type === 'Identifier') {
        const fnId = `${relativePath}::${path.node.id.name}`;
        nodes.push({
          id: fnId,
          label: `${path.node.id.name} = ()`,
          type: 'function',
          file: relativePath,
          language: 'js',
          parent: relativePath
        });
        edges.push({
          from: relativePath,
          to: fnId,
          label: `defines ${path.node.id.name}`,
          type: 'defines',
          weight: 10
        });
        extractCalls(path.node.init, relativePath, edges);
      }
    },

    ClassDeclaration(path) {
      if (path.node.id) {
        const clsId = `${relativePath}::${path.node.id.name}`;
        nodes.push({
          id: clsId,
          label: path.node.id.name,
          type: 'class',
          file: relativePath,
          language: 'js',
          parent: relativePath
        });
        edges.push({
          from: relativePath,
          to: clsId,
          label: `defines class ${path.node.id.name}`,
          type: 'defines',
          weight: 10
        });
      }
    },

    AssignmentExpression(path) {
      if (path.node.left.type === 'MemberExpression' &&
          path.node.left.object.type === 'MemberExpression' &&
          path.node.left.object.property?.name === 'exports') {
        const exportName = path.node.left.property?.name;
        if (exportName) {
          edges.push({
            from: relativePath,
            to: `${relativePath}::${exportName}`,
            label: `exports ${exportName}`,
            type: 'exports',
            weight: 8
          });
        }
      }
    }
  });

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
      parent: relativePath
    });
    edges.push({
      from: relativePath,
      to: modelId,
      label: `defines model ${m[1]}`,
      type: 'defines',
      weight: 10
    });
  }

  return { nodes, edges };
}

function parseJava(filePath, relativePath, content) {
  const nodes = [];
  const edges = [];

  const fileNode = {
    id: relativePath,
    label: path.basename(filePath),
    type: 'file',
    file: relativePath,
    language: 'java'
  };
  nodes.push(fileNode);

  // Package
  const pkgMatch = content.match(/package\s+([\w.]+)\s*;/);
  const pkg = pkgMatch ? pkgMatch[1] : '';

  // Imports
  const importRegex = /import\s+(?:static\s+)?([\w.*]+)\s*;/g;
  let m;
  while ((m = importRegex.exec(content)) !== null) {
    const imported = m[1].replace(/\.\*$/, '');
    edges.push({
      from: relativePath,
      to: imported.replace(/\./g, '/') + '.java',
      label: `imports ${imported}`,
      type: 'imports',
      weight: 5
    });
  }

  // Class/Interface
  const classRegex = /(?:public\s+)?(?:abstract\s+)?(?:class|interface|@interface|enum)\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/g;
  while ((m = classRegex.exec(content)) !== null) {
    const clsName = m[1];
    const clsId = `${relativePath}::${clsName}`;
    const extendsCls = m[2];
    const implementsIfaces = m[3] ? m[3].split(',').map(s => s.trim()) : [];

    nodes.push({
      id: clsId,
      label: clsName,
      type: 'class',
      file: relativePath,
      language: 'java',
      parent: relativePath
    });
    edges.push({
      from: relativePath,
      to: clsId,
      label: `defines class ${clsName}`,
      type: 'defines',
      weight: 10
    });

    if (extendsCls && extendsCls !== 'Object') {
      edges.push({
        from: clsId,
        to: `${relativePath}::${extendsCls}`,
        label: `extends ${extendsCls}`,
        type: 'extends',
        weight: 8
      });
    }
    implementsIfaces.forEach(iface => {
      if (iface) {
        edges.push({
          from: clsId,
          to: `${relativePath}::${iface}`,
          label: `implements ${iface}`,
          type: 'implements',
          weight: 7
        });
      }
    });
  }

  // Methods
  const methodRegex = /(?:public|private|protected|static)\s+(?:<\w+>)?\s*(\w+(?:\[\])?(?:<\w+>)?)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w,\s]+)?\{/g;
  while ((m = methodRegex.exec(content)) !== null) {
    const returnType = m[1];
    const methodName = m[2];
    const params = m[3];
    const methodId = `${relativePath}::${methodName}()`;

    if (methodName.charAt(0) === methodName.charAt(0).toUpperCase() && methodName === clsName) continue;

    nodes.push({
      id: methodId,
      label: `${methodName}()`,
      type: 'function',
      file: relativePath,
      language: 'java',
      parent: relativePath
    });
    edges.push({
      from: relativePath,
      to: methodId,
      label: `defines ${methodName}()`,
      type: 'defines',
      weight: 10
    });
  }

  // Spring annotations for controllers/services
  const springTypes = ['@Controller', '@RestController', '@Service', '@Repository', '@Component', '@Configuration'];
  springTypes.forEach(st => {
    if (content.includes(st)) {
      nodes.push({
        id: `${relativePath}::${st.replace('@', '')}`,
        label: st,
        type: 'annotation',
        file: relativePath,
        language: 'java',
        parent: relativePath
      });
      edges.push({
        from: relativePath,
        to: `${relativePath}::${st.replace('@', '')}`,
        label: `annotated ${st}`,
        type: 'annotates',
        weight: 6
      });
    }
  });

  // Spring request mappings
  const mappingRegex = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|RequestMapping)\s*\(\s*(?:"([^"]+)"|'([^']+)'|value\s*=\s*"([^"]+)")/g;
  while ((m = mappingRegex.exec(content)) !== null) {
    const method = m[1].replace('Mapping', '').toUpperCase();
    const routePath = m[2] || m[3] || m[4] || '/';
    const routeId = `${relativePath}::${method} ${routePath}`;
    nodes.push({
      id: routeId,
      label: `${method} ${routePath}`,
      type: 'api',
      file: relativePath,
      language: 'java',
      parent: relativePath
    });
    edges.push({
      from: relativePath,
      to: routeId,
      label: `defines ${method} ${routePath}`,
      type: 'defines',
      weight: 10
    });
  }

  return { nodes, edges };
}

function parsePython(filePath, relativePath, content) {
  const nodes = [];
  const edges = [];

  const fileNode = {
    id: relativePath,
    label: path.basename(filePath),
    type: 'file',
    file: relativePath,
    language: 'python'
  };
  nodes.push(fileNode);

  // Imports
  const importRegex = /(?:from\s+([\w.]+)\s+)?import\s+([\w.*\s,]+)/g;
  let m;
  while ((m = importRegex.exec(content)) !== null) {
    const module = m[1] || '';
    const targets = m[2].split(',').map(s => s.trim().split(' as ')[0].trim());
    targets.forEach(t => {
      if (t === '*') {
        edges.push({
          from: relativePath,
          to: (module || '*').replace(/\./g, '/') + '.py',
          label: `imports * from ${module}`,
          type: 'imports',
          weight: 5
        });
      } else {
        edges.push({
          from: relativePath,
          to: resolveModuleSource(relativePath, module ? `${module}.${t}` : t),
          label: `imports ${t}`,
          type: 'imports',
          weight: 5
        });
      }
    });
  }

  // Functions
  const funcRegex = /^(?:async\s+)?def\s+(\w+)\s*\(/gm;
  while ((m = funcRegex.exec(content)) !== null) {
    const fnId = `${relativePath}::${m[1]}()`;
    nodes.push({
      id: fnId,
      label: `${m[1]}()`,
      type: 'function',
      file: relativePath,
      language: 'python',
      parent: relativePath
    });
    edges.push({
      from: relativePath,
      to: fnId,
      label: `defines ${m[1]}()`,
      type: 'defines',
      weight: 10
    });
  }

  // Classes
  const classRegex = /^class\s+(\w+)(?:\s*\(([^)]*)\))?:/gm;
  while ((m = classRegex.exec(content)) !== null) {
    const clsId = `${relativePath}::${m[1]}`;
    nodes.push({
      id: clsId,
      label: m[1],
      type: 'class',
      file: relativePath,
      language: 'python',
      parent: relativePath
    });
    edges.push({
      from: relativePath,
      to: clsId,
      label: `defines class ${m[1]}`,
      type: 'defines',
      weight: 10
    });
    if (m[2]) {
      const parents = m[2].split(',').map(s => s.trim());
      parents.forEach(p => {
        if (p && p !== 'object') {
          edges.push({
            from: clsId,
            to: `${relativePath}::${p}`,
            label: `extends ${p}`,
            type: 'extends',
            weight: 8
          });
        }
      });
    }
  }

  // Flask/FastAPI routes
  const routeRegex = /@\w+(?:\.\w+)?\.(?:route|get|post|put|delete|patch)\s*\(\s*(?:"([^"]+)"|'([^']+)')/g;
  while ((m = routeRegex.exec(content)) !== null) {
    const routePath = m[1] || m[2] || '/';
    const routeId = `${relativePath}::ROUTE ${routePath}`;
    nodes.push({
      id: routeId,
      label: `ROUTE ${routePath}`,
      type: 'api',
      file: relativePath,
      language: 'python',
      parent: relativePath
    });
    edges.push({
      from: relativePath,
      to: routeId,
      label: `defines route ${routePath}`,
      type: 'defines',
      weight: 10
    });
  }

  return { nodes, edges };
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

function extractCalls(node, file, edges) {
  const seen = new Set();
  function walk(n) {
    if (!n || seen.has(n)) return;
    seen.add(n);
    if (n.type === 'CallExpression' && n.callee?.type === 'Identifier') {
      edges.push({
        from: `${file}::${node.id?.name || 'anonymous'}`,
        to: n.callee.name,
        label: `calls ${n.callee.name}()`,
        type: 'calls',
        weight: 3
      });
    }
    if (n.type === 'MemberExpression' && n.property?.type === 'Identifier') {
      const memberCalls = ['find', 'findById', 'save', 'create', 'updateOne', 'deleteOne', 'populate'];
      if (memberCalls.includes(n.property.name)) {
        edges.push({
          from: file,
          to: `db::${n.property.name}`,
          label: `db.${n.property.name}()`,
          type: 'calls',
          weight: 4
        });
      }
    }
    for (const key in n) {
      if (key !== 'leadingComments' && key !== 'trailingComments') {
        walk(n[key]);
      }
    }
  }
  walk(node);
}

function resolveModuleSource(currentFile, importPath) {
  if (importPath.startsWith('.')) {
    const dir = path.dirname(currentFile);
    const resolved = path.resolve(dir, importPath).replace(/\\/g, '/');
    return resolved;
  }
  return `npm:${importPath}`;
}

function scanDirectory(dirPath) {
  const allNodes = [];
  const allEdges = [];
  const fileIds = new Set();

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
        if (['.js', '.jsx', '.ts', '.tsx', '.java', '.py'].includes(ext)) {
          const result = parseFile(fullPath);
          result.nodes.forEach(n => {
            if (!fileIds.has(n.id) || n.type === 'function' || n.type === 'class' || n.type === 'api') {
              allNodes.push(n);
              fileIds.add(n.id);
            }
          });
          result.edges.forEach(e => allEdges.push(e));
        }
      }
    }
  }

  walk(dirPath);
  return { nodes: allNodes, edges: allEdges };
}

module.exports = { parseFile, scanDirectory, parseJS, parseJava, parsePython };
