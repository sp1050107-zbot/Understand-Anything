#!/usr/bin/env node
// Query an Understand-Anything knowledge graph for AI task routing.
//   chain  <query>   follow routes/calls/imports/middleware edges DOWN from an endpoint or file
//   impact <path>... follow the same edges UP from changed files (endpoints, files, tests)
// Usage: node scripts/graph-query.mjs <projectRoot> chain "<query>" [--depth N] [--json]
//        node scripts/graph-query.mjs <projectRoot> impact <path>... [--depth N] [--json]
// Not part of the production pipeline. The graph is a hint: always confirm by reading code.
import fs from 'node:fs';
import path from 'node:path';

const EDGE_TYPES = new Set(['routes', 'calls', 'imports', 'middleware']);
const HTTP = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|ANY)\s/i;

export function loadGraph(projectRoot) {
  const legacy = path.join(projectRoot, '.understand-anything');
  const dir = fs.existsSync(legacy) ? legacy : path.join(projectRoot, '.ua');
  return JSON.parse(fs.readFileSync(path.join(dir, 'knowledge-graph.json'), 'utf8'));
}

export function findStart(graph, query) {
  const q = query.toLowerCase();
  const exact = graph.nodes.filter(n => n.id.toLowerCase() === q || n.name?.toLowerCase() === q);
  if (exact.length) return exact;
  if (HTTP.test(query)) return graph.nodes.filter(n => n.type === 'endpoint' && n.name.toLowerCase().includes(q));
  return graph.nodes.filter(n => n.type === 'file' && (n.filePath ?? '').toLowerCase().includes(q));
}

export function nodesOfFile(graph, rel) {
  return graph.nodes.filter(n => n.filePath === rel && n.type !== 'endpoint');
}

export function traverse(graph, starts, { depth = 3, direction = 'down' } = {}) {
  const adj = new Map();
  for (const e of graph.edges) {
    if (!EDGE_TYPES.has(e.type)) continue;
    const [from, to] = direction === 'down' ? [e.source, e.target] : [e.target, e.source];
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push(to);
  }
  // Backend dependencies are mostly file-level `imports`, while `routes`/`calls` end at functions. So a symbol and its
  // file are linked at the same depth: going down a function also reaches its file (and that file's imports); going up
  // a file also reaches its functions (and whatever routes/calls them).
  const ids = new Set(graph.nodes.map(n => n.id));
  const link = new Map();
  for (const n of graph.nodes) {
    if (!n.filePath || n.type === 'file' || n.type === 'endpoint' || !ids.has(`file:${n.filePath}`)) continue;
    const f = `file:${n.filePath}`;
    const [from, to] = direction === 'down' ? [n.id, f] : [f, n.id];
    if (!link.has(from)) link.set(from, []);
    link.get(from).push(to);
  }
  const seen = new Map();
  let next = [];
  const add = (id, d) => {
    if (seen.has(id)) return;
    seen.set(id, d);
    next.push(id);
    for (const l of link.get(id) ?? []) add(l, d);
  };
  for (const s of starts) add(s.id, 0);
  for (let d = 1; d <= depth; d++) {
    const frontier = next;
    next = [];
    for (const id of frontier) for (const to of adj.get(id) ?? []) add(to, d);
  }
  return seen;
}

export function summarize(graph, seen) {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const layerOf = new Map();
  for (const l of graph.layers ?? []) for (const id of l.nodeIds) layerOf.set(id, l.name);
  const files = new Map();
  const endpoints = [];
  for (const [id, depth] of seen) {
    const node = byId.get(id);
    if (!node) continue;
    if (node.type === 'endpoint') { endpoints.push(node.name); continue; }
    if (!node.filePath || depth === 0) continue;
    const rec = files.get(node.filePath) ?? { file: node.filePath, layer: layerOf.get(`file:${node.filePath}`) ?? null, depth, symbols: [] };
    rec.depth = Math.min(rec.depth, depth);
    if (node.type !== 'file') rec.symbols.push(node.name);
    files.set(node.filePath, rec);
  }
  const visitedFiles = new Set([...seen.keys()].map(id => byId.get(id)?.filePath).filter(Boolean));
  const tests = graph.edges.filter(e => e.type === 'tested_by' && visitedFiles.has(byId.get(e.source)?.filePath))
    .map(e => byId.get(e.target)?.filePath).filter(Boolean);
  const list = [...files.values()].sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));
  // Go imports are package-level, so one import pulls in a whole package. A file whose name matches a nearer file
  // (controllers/componentData.go -> models/componentData.go) is the likely real dependency: flag it.
  for (const f of list) f.sameName = list.some(o => o.depth < f.depth && path.basename(o.file) === path.basename(f.file));
  const totalEndpoints = graph.nodes.filter(n => n.type === 'endpoint').length;
  return { files: list, endpoints: endpoints.sort(), tests: [...new Set(tests)].sort(), totalEndpoints, broad: totalEndpoints > 0 && endpoints.length > totalEndpoints / 2 };
}

export function printText(title, s, all = false) {
  console.log(`# ${title}`);
  if (s.broad) {
    console.log(`WARNING: BROAD - reaches ${s.endpoints.length} of ${s.totalEndpoints} endpoints. Go imports are package-level, so this over-approximates; narrow it by grepping the changed function names in the backend instead of trusting this list.`);
  } else if (s.endpoints.length) console.log(`endpoints: ${s.endpoints.join(' | ')}`);
  console.log('depth  file  [layer]  symbols');
  const shown = s.files.filter(f => all || f.depth <= 1 || f.sameName || f.symbols.length);
  for (const f of shown) console.log(`${f.depth}  ${f.file}  [${f.layer ?? '-'}]  ${f.symbols.join(', ')}${f.sameName ? '  (same name as a nearer file)' : ''}`);
  const rest = s.files.filter(f => !shown.includes(f));
  if (rest.length) {
    const dirs = {};
    for (const f of rest) dirs[path.dirname(f.file)] = (dirs[path.dirname(f.file)] || 0) + 1;
    console.log(`+${rest.length} more (package-level imports): ${Object.entries(dirs).map(([d, c]) => `${d} (${c})`).join(', ')}; use --all to list`);
  }
  if (s.tests.length) console.log(`tests: ${s.tests.join(', ')}`);
  console.log('note: graph is a hint (.vue files have no function-level data); confirm by reading code.');
}

function main() {
  const args = process.argv.slice(2);
  const usage = 'usage: graph-query.mjs <projectRoot> chain "<query>" | impact <path>... [--depth N] [--json]';
  const flags = args.filter(a => a.startsWith('--'));
  const depthIdx = args.indexOf('--depth');
  let depth = 3;
  if (depthIdx >= 0) {
    const value = args[depthIdx + 1];
    depth = Number(value);
    if (value === undefined || value.trim() === '' || !Number.isInteger(depth) || depth < 1) {
      console.error(usage);
      process.exit(1);
    }
  }
  const pos = args.filter((a, i) => !a.startsWith('--') && !(depthIdx >= 0 && i === depthIdx + 1));
  const [root, cmd, ...rest] = pos;
  if (!root || !['chain', 'impact'].includes(cmd) || !rest.length) {
    console.error(usage);
    process.exit(1);
  }
  const projectRoot = path.resolve(root);
  const graph = loadGraph(projectRoot);
  // impact paths may be ./relative or absolute; match them as project-relative. Outside the project: keep as typed.
  const normalise = p => {
    const rel = path.relative(projectRoot, path.resolve(projectRoot, p));
    return rel.startsWith('..') ? p : rel;
  };
  const targets = cmd === 'impact' ? rest.map(normalise) : rest;
  let starts;
  if (cmd === 'chain') starts = findStart(graph, rest.join(' '));
  else starts = targets.flatMap(p => [...nodesOfFile(graph, p), ...graph.nodes.filter(n => n.id === `file:${p}`)]);
  if (!starts.length) {
    const hint = graph.nodes.filter(n => n.type === 'file' && n.filePath?.toLowerCase().includes(path.basename(targets[0]).toLowerCase())).slice(0, 5).map(n => n.filePath);
    console.error(`No node matches "${rest.join(' ')}".` + (hint.length ? ` Similar files: ${hint.join(', ')}` : ''));
    process.exit(2);
  }
  const seen = traverse(graph, starts, { depth, direction: cmd === 'chain' ? 'down' : 'up' });
  const s = summarize(graph, seen);
  if (flags.includes('--json')) console.log(JSON.stringify(s));
  else printText(`${cmd} ${rest.join(' ')} (depth ${depth})`, s, flags.includes('--all'));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
