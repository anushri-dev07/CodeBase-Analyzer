class GraphEngine {
  constructor(nodes, edges) {
    this.nodes = nodes;
    this.edges = edges;
    this.adjList = new Map();
    this.reverseAdj = new Map();
    this.buildIndex();
  }

  buildIndex() {
    this.nodeMap = new Map();
    this.nodes.forEach(n => this.nodeMap.set(n.id, n));

    this.adjList.clear();
    this.reverseAdj.clear();
    this.edges.forEach(e => {
      if (!this.adjList.has(e.from)) this.adjList.set(e.from, []);
      this.adjList.get(e.from).push(e);
      if (!this.reverseAdj.has(e.to)) this.reverseAdj.set(e.to, []);
      this.reverseAdj.get(e.to).push(e);
    });
  }

  getNode(id) {
    return this.nodeMap.get(id);
  }

  getOutgoing(id) {
    return this.adjList.get(id) || [];
  }

  getIncoming(id) {
    return this.reverseAdj.get(id) || [];
  }

  // "What breaks if I change this?" — walks DEPENDENTS (reverse edges) outward.
  impactAnalysis(nodeId, depth = 4) {
    const start = this.getNode(nodeId);
    if (!start) {
      return { nodeId, resolved: false, error: `Symbol not found in the loaded project: ${nodeId}`, affected: [], direct: [], indirect: [], totalAffected: 0 };
    }

    // Edge types that mean "the source depends on the target".
    const DEP_TYPES = new Set(['calls', 'imports', 'extends', 'implements', 'exports']);

    const resultById = new Map();
    const queue = [{ id: nodeId, depth: 0, path: [] }];
    const seen = new Set([nodeId]);

    while (queue.length > 0) {
      const cur = queue.shift();
      if (cur.depth >= depth) continue;

      for (const edge of this.getIncoming(cur.id)) {
        if (!DEP_TYPES.has(edge.type)) continue;
        const depId = edge.from;
        if (seen.has(depId)) continue;
        seen.add(depId);

        const step = { from: edge.from, to: edge.to, label: edge.label, type: edge.type, line: edge.line || null };
        const path = [...cur.path, step];
        resultById.set(depId, {
          id: depId,
          node: this.getNode(depId),
          depth: cur.depth + 1,
          via: step,
          reason: this.describeReason(step),
          path
        });
        queue.push({ id: depId, depth: cur.depth + 1, path });
      }
    }

    const direct = [];
    const indirect = [];
    resultById.forEach(r => { (r.depth === 1 ? direct : indirect).push(r); });
    direct.sort((a, b) => (a.node?.label || a.id).localeCompare(b.node?.label || b.id));

    // Scope of the change: distinct files and modules touched.
    const files = new Set();
    const modules = new Set();
    resultById.forEach(r => {
      const f = r.node?.file || r.id.split('::')[0];
      if (f) { files.add(f); modules.add(f.includes('/') ? f.split('/')[0] : 'other'); }
    });

    const affected = [...direct, ...indirect];
    return {
      nodeId,
      resolved: true,
      node: start,
      nodeLocation: start.line ? `${start.file}:${start.line}` : start.file,
      direct,
      indirect,
      affected,
      totalAffected: resultById.size,
      scope: { directCount: direct.length, indirectCount: indirect.length, files: files.size, modules: modules.size, depth }
    };
  }

  describeReason(step) {
    switch (step.type) {
      case 'calls': return `calls ${step.label ? step.label.replace(/^calls\s+/, '').replace(/\(\)$/, '') : 'this'}`;
      case 'imports': return 'imports this module';
      case 'extends': return 'extends this class';
      case 'implements': return 'implements this interface';
      case 'exports': return 're-exports this';
      default: return step.type;
    }
  }

  // Functions/classes with no detected callers. Distinguishes confirmed vs possible
  // (exported symbols, entry-point files, tests and framework files are not auto-dead).
  deadCode() {
    const ENTRY_FILE = /(^|\/)(index|main|app|server|cli)\.(js|jsx|ts|tsx|py|java)$/i;
    const TEST_FILE = /(^|\/)(tests?|spec|__tests__)(\/|\.)|\.(test|spec)\./i;
    const results = [];

    this.nodes.forEach(n => {
      if (n.type !== 'function' && n.type !== 'class') return;

      // Ignore structural 'defines' edges and self-references (recursion is not a real caller).
      const consumers = this.getIncoming(n.id).filter(e => e.type !== 'defines' && e.from !== n.id);
      if (consumers.length) return; // has at least one caller/importer/implementer

      const file = n.file || '';
      const reasons = [];
      let confidence = 'confirmed';

      if (n.exported) { confidence = 'possible'; reasons.push('exported — may be used by other packages or entry points'); }
      if (ENTRY_FILE.test(file)) { confidence = 'possible'; reasons.push('defined in an entry-point file'); }
      if (TEST_FILE.test(file)) { confidence = 'possible'; reasons.push('defined in a test file'); }
      const simple = (n.id.split('::').pop() || '').replace(/^\s*class::/, '').replace(/\(\)$/, '');
      if (/^__\w+__$/.test(simple)) { confidence = 'possible'; reasons.push('dunder/special method — invoked implicitly by the runtime'); }
      if (n.language === 'python' && /^\s+/.test((n.id.split('::')[1] || '')) ) { confidence = 'possible'; reasons.push('nested definition'); }
      if (simple === 'main') { confidence = 'possible'; reasons.push('looks like a program entry point'); }
      if (this.nodes.some(o => o.id !== n.id && (o.type === 'function' || o.type === 'class') && (o.id.split('::').pop() || '').replace(/^\s*class::/, '').replace(/\(\)$/, '') === simple)) {
        confidence = 'possible';
        reasons.push('another symbol shares this name — calls by bare name cannot be attributed reliably');
      }
      if (n.type === 'class' && this.nodes.some(a => a.type === 'annotation' && a.file === file)) {
        confidence = 'possible';
        reasons.push('class in a framework (annotated) file');
      }

      results.push({
        id: n.id,
        label: n.label,
        type: n.type,
        file: n.file,
        line: n.line || null,
        confidence,
        reasons
      });
    });

    // Confirmed findings first.
    results.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === 'confirmed' ? -1 : 1));
    return results;
  }

  search(query) {
    const q = query.toLowerCase();
    return this.nodes.filter(n =>
      n.id.toLowerCase().includes(q) ||
      (n.label && n.label.toLowerCase().includes(q))
    ).slice(0, 30);
  }

  getPathBetween(fromId, toId, maxDepth = 5) {
    const queue = [{ id: fromId, path: [] }];
    const seen = new Set();

    while (queue.length > 0) {
      const current = queue.shift();
      if (current.id === toId) return current.path;
      if (current.path.length >= maxDepth) continue;
      if (seen.has(current.id)) continue;
      seen.add(current.id);

      const outgoing = this.getOutgoing(current.id);
      for (const edge of outgoing) {
        queue.push({
          id: edge.to,
          path: [...current.path, { from: edge.from, to: edge.to, label: edge.label, type: edge.type }]
        });
      }

      const incoming = this.getIncoming(current.id);
      for (const edge of incoming) {
        queue.push({
          id: edge.from,
          path: [...current.path, { from: edge.from, to: edge.to, label: edge.label, type: edge.type }]
        });
      }
    }
    return [];
  }

  getFlowForExplain(nodeIds) {
    const flow = [];
    const seen = new Set();

    nodeIds.forEach(id => {
      const outgoing = this.getOutgoing(id);
      outgoing.forEach(e => {
        if (!seen.has(`${e.from}->${e.to}`)) {
          flow.push(e);
          seen.add(`${e.from}->${e.to}`);
        }
      });
      const incoming = this.getIncoming(id);
      incoming.forEach(e => {
        if (!seen.has(`${e.from}->${e.to}`)) {
          flow.push(e);
          seen.add(`${e.from}->${e.to}`);
        }
      });
    });

    return flow;
  }

  getSummary() {
    const byType = {};
    this.nodes.forEach(n => {
      byType[n.type] = (byType[n.type] || 0) + 1;
    });
    return {
      totalNodes: this.nodes.length,
      totalEdges: this.edges.length,
      nodeTypes: byType,
      deadFunctionCount: this.deadCode().length,
      files: this.nodes.filter(n => n.type === 'file').length,
      apis: this.nodes.filter(n => n.type === 'api').length,
      models: this.nodes.filter(n => n.type === 'model').length,
    };
  }
}

module.exports = GraphEngine;
