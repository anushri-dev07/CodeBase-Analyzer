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

  impactAnalysis(nodeId, depth = 3) {
    const affected = new Set();
    const queue = [{ id: nodeId, depth: 0 }];
    const seen = new Set();

    while (queue.length > 0) {
      const current = queue.shift();
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      if (current.id !== nodeId) affected.add(current.id);
      if (current.depth >= depth) continue;

      const outgoing = this.getOutgoing(current.id);
      for (const edge of outgoing) {
        if (edge.type === 'defines') {
          queue.push({ id: edge.to, depth: current.depth + 1 });
        }
      }

      const incoming = this.getIncoming(current.id);
      for (const edge of incoming) {
        if (['imports', 'calls', 'extends', 'implements'].includes(edge.type)) {
          queue.push({ id: edge.from, depth: current.depth + 1 });
        }
      }
    }

    return {
      nodeId,
      node: this.getNode(nodeId),
      totalAffected: affected.size,
      affected: Array.from(affected).map(id => ({
        id,
        node: this.getNode(id),
        path: this.getPathBetween(nodeId, id)
      }))
    };
  }

  deadCode() {
    const candidates = [];
    this.nodes.forEach(n => {
      if (n.type === 'function' || n.type === 'class') {
        const incoming = this.getIncoming(n.id);
        const hasParentEdge = incoming.some(e => e.type === 'defines');
        const hasConsumer = incoming.some(e => e.type !== 'defines');

        if (hasParentEdge && !hasConsumer) {
          candidates.push(n);
        }
      }
    });
    return candidates;
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
