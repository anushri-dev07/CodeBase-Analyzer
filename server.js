require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { scanDirectory, parseFile, resolveGraph, isIgnoredPath } = require('./parser');
const GraphEngine = require('./graphEngine');

const app = express();
const PORT = process.env.PORT || 5002;

app.use(cors());
app.use(express.json({ limit: process.env.BODY_LIMIT || '100mb' }));
// Serve only the UI. (express.static(__dirname) would expose server.js, parser.js, package files, etc.)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

let currentGraph = null;
let currentProjectPath = null;

// Scan a directory
app.post('/api/scan', (req, res) => {
  try {
    const { dirPath } = req.body;
    if (!dirPath || !fs.existsSync(dirPath)) {
      return res.status(400).json({ error: 'Invalid directory path' });
    }

    const result = scanDirectory(dirPath);
    currentGraph = new GraphEngine(result.nodes, result.edges);
    currentProjectPath = dirPath;

    res.json({
      summary: currentGraph.getSummary(),
      nodes: result.nodes,
      edges: result.edges
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Analyze single file or pasted code
app.post('/api/analyze', (req, res) => {
  try {
    const { code, filename } = req.body;
    if (!code) return res.status(400).json({ error: 'No code provided' });

    const rel = (filename || 'temp.js').replace(/\\/g, '/');
    const result = parseFile(rel, code, rel);
    const importsByFile = result.imports && Object.keys(result.imports).length ? { [rel]: result.imports } : {};
    const resolved = resolveGraph(result.nodes, result.edges, importsByFile);

    currentGraph = new GraphEngine(resolved.nodes, resolved.edges);

    res.json({
      summary: currentGraph.getSummary(),
      nodes: resolved.nodes,
      edges: resolved.edges
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scan files uploaded from browser (actual content, not paths)
app.post('/api/scan-files', (req, res) => {
  try {
    const { files } = req.body;
    if (!files || !files.length) return res.status(400).json({ error: 'No files provided' });

    const allNodes = [];
    const allEdges = [];
    const importsByFile = {};
    const seenIds = new Set();
    let ignored = 0;

    files.forEach(f => {
      const relPath = f.path.replace(/\\/g, '/');
      if (isIgnoredPath(relPath)) { ignored++; return; }
      const result = parseFile(relPath, f.content, relPath);
      result.nodes.forEach(n => {
        if (!seenIds.has(n.id)) { seenIds.add(n.id); allNodes.push(n); }
      });
      result.edges.forEach(e => allEdges.push(e));
      if (result.imports && Object.keys(result.imports).length) importsByFile[relPath] = result.imports;
    });

    const resolved = resolveGraph(allNodes, allEdges, importsByFile);
    currentGraph = new GraphEngine(resolved.nodes, resolved.edges);

    res.json({
      summary: currentGraph.getSummary(),
      ignored,
      nodes: resolved.nodes,
      edges: resolved.edges
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get graph data
app.get('/api/graph', (req, res) => {
  if (!currentGraph) return res.json({ nodes: [], edges: [], summary: null });
  res.json({
    nodes: currentGraph.nodes,
    edges: currentGraph.edges,
    summary: currentGraph.getSummary()
  });
});

// Import graph data (set from client-side)
app.post('/api/graph', (req, res) => {
  const { nodes, edges } = req.body;
  if (!nodes || !edges) return res.status(400).json({ error: 'nodes and edges required' });
  // Never keep edges that point at missing nodes — they crash graph rendering.
  const ids = new Set(nodes.map(n => n.id));
  const safeEdges = edges.filter(e => ids.has(e.from) && ids.has(e.to));
  currentGraph = new GraphEngine(nodes, safeEdges);
  res.json({ success: true, summary: currentGraph.getSummary() });
});

// Search
app.get('/api/search', (req, res) => {
  if (!currentGraph) return res.json([]);
  const q = req.query.q || '';
  res.json(currentGraph.search(q));
});

// Impact analysis
app.get('/api/impact', (req, res) => {
  if (!currentGraph) return res.status(400).json({ error: 'No graph loaded' });
  const nodeId = req.query.node;
  if (!nodeId) return res.status(400).json({ error: 'No node specified' });
  const depth = parseInt(req.query.depth) || 3;
  res.json(currentGraph.impactAnalysis(nodeId, depth));
});

// Dead code
app.get('/api/dead-code', (req, res) => {
  if (!currentGraph) return res.status(400).json({ error: 'No graph loaded' });
  res.json(currentGraph.deadCode());
});

// Explain flow
app.post('/api/explain', (req, res) => {
  if (!currentGraph) return res.status(400).json({ error: 'No graph loaded' });
  const { nodeIds } = req.body;
  if (!nodeIds || !nodeIds.length) return res.status(400).json({ error: 'No nodes specified' });

  const flow = currentGraph.getFlowForExplain(nodeIds);

  // Build a readable explanation
  const explainedSteps = flow.map(e => {
    const fromLabel = currentGraph.getNode(e.from)?.label || e.from;
    const toLabel = currentGraph.getNode(e.to)?.label || e.to;
    return { from: e.from, to: e.to, label: e.label, fromLabel, toLabel };
  });

  res.json({ steps: explainedSteps });
});

// Incoming/outgoing for a node
app.get('/api/node/:id', (req, res) => {
  if (!currentGraph) return res.status(400).json({ error: 'No graph loaded' });
  const nodeId = req.params.id;
  const node = currentGraph.getNode(nodeId);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  res.json({
    node,
    incoming: currentGraph.getIncoming(nodeId),
    outgoing: currentGraph.getOutgoing(nodeId)
  });
});

// Catch-all for SPA (must be last)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Codebase Graph running on http://localhost:${PORT}`);
});
