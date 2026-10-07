#!/usr/bin/env node
// Augments an existing knowledge graph with two things the LLM pipeline cannot
// get reliably from tree-sitter alone:
//   1. `endpoint` nodes for Gin routes (router.Group / .GET / .POST ...), with
//      `routes` edges to controller functions and `middleware` edges to
//      middleware functions.
//   2. `imports` edges for relative imports in .vue / .js / .ts files (Vue SFCs
//      have no structural parser, so their imports are missing from the graph).
//
// Idempotent: everything this script adds is marked (node tag + edge
// description) and removed again at the start of the next run, so re-running it
// after an incremental `/understand` never duplicates anything.
//
// Usage: node scripts/augment-gin-vue.mjs [projectRoot] [--dry-run]
//          [--no-routes] [--no-imports]
// Not part of the production pipeline.
import fs from 'node:fs';
import path from 'node:path';

export const MARKER = 'augment-gin-vue';
export const NODE_TAG = `generated:${MARKER}`;

const HTTP = 'GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Any';
const JS_EXT = /\.(vue|js|mjs|cjs|ts|tsx|jsx)$/;
const RESOLVE_SUFFIXES = ['', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.vue', '/index.js', '/index.ts', '/index.vue'];
const FILE_LEVEL = new Set(['file', 'config', 'document', 'service', 'pipeline', 'table', 'schema', 'resource', 'endpoint']);

export function resolveDataDir(projectRoot) {
  const legacy = path.join(projectRoot, '.understand-anything');
  return fs.existsSync(legacy) ? legacy : path.join(projectRoot, '.ua');
}

function splitArgs(s) {
  const out = [];
  let depth = 0, cur = '', inStr = false;
  for (const c of s) {
    if (c === '"') inStr = !inStr;
    if (!inStr) {
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function joinPath(base, rel) {
  let p = `${base}/${rel}`.replace(/\/+/g, '/');
  if (!rel.endsWith('/') && p.length > 1) p = p.replace(/\/$/, '');
  return p;
}

// Evaluate `"/api/" + global.VERSION` style expressions using string constants
// found in the project's Go files.
function makeConstResolver(goSources) {
  const cache = new Map();
  return (ident) => {
    if (cache.has(ident)) return cache.get(ident);
    let val = null;
    const re = new RegExp(`\\b${ident}\\s*=\\s*"([^"]*)"`);
    for (const src of goSources) { const m = re.exec(src); if (m) { val = m[1]; break; } }
    cache.set(ident, val);
    return val;
  };
}

function evalPathExpr(expr, resolveConst) {
  let out = '';
  for (const term of expr.split('+').map(t => t.trim())) {
    const lit = /^"([^"]*)"$/.exec(term);
    if (lit) { out += lit[1]; continue; }
    const id = /^(?:\w+\.)?(\w+)$/.exec(term);
    const v = id ? resolveConst(id[1]) : null;
    if (v === null) return null;
    out += v;
  }
  return out;
}

export function parseGinRoutes(source, resolveConst) {
  const groups = {};
  const routes = [];
  const lines = source.split('\n');
  // Gin applies a middleware only to routes registered after Use(); child
  // groups copy the parent's handler chain at creation time.
  const rootMw = [];
  lines.forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) return;
    let m;
    if ((m = /^\w+\.Use\((.*)\)\s*$/.exec(line)) && /^(Router|router|r|engine)\./.test(line)) {
      for (const a of splitArgs(m[1])) { const mm = /^middleware\.(\w+)/.exec(a); if (mm) rootMw.push(mm[1]); }
      return;
    }
    if ((m = /^(\w+)\s*:?=\s*(\w+)\.Group\((.*)\)\s*$/.exec(line))) {
      const [, name, parent, argSrc] = m;
      const rel = evalPathExpr(splitArgs(argSrc)[0] ?? '""', resolveConst);
      if (rel === null) return;
      const par = groups[parent] ?? (/^(Router|router|r|engine)$/.test(parent) ? { path: '', mw: [...rootMw] } : null);
      if (!par) return;
      groups[name] = { path: joinPath(par.path, rel), mw: [...par.mw] };
      return;
    }
    if ((m = /^(\w+)\.Use\((.*)\)\s*$/.exec(line)) && groups[m[1]]) {
      for (const a of splitArgs(m[2])) { const mm = /^middleware\.(\w+)/.exec(a); if (mm) groups[m[1]].mw.push(mm[1]); }
      return;
    }
    if ((m = new RegExp(`^(\\w+)\\.(${HTTP})\\("([^"]*)"\\s*,\\s*(.*)\\)\\s*$`).exec(line)) && groups[m[1]]) {
      const args = splitArgs(m[4]);
      const last = args[args.length - 1];
      const h = /^(\w+)\.(\w+)$/.exec(last);
      const routeMw = args.slice(0, -1).map(a => /^middleware\.(\w+)/.exec(a)).filter(Boolean).map(x => x[1]);
      routes.push({
        method: m[2], full: joinPath(groups[m[1]].path, m[3]),
        handlerPkg: h ? h[1] : null, handler: h ? h[2] : null, raw: last,
        mw: [...groups[m[1]].mw, ...routeMw], line: i + 1,
      });
    }
  });
  return routes;
}

export function parseRelativeImports(src) {
  const text = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
  const specs = new Set();
  let m;
  const stat = /(?:^|[\n;])\s*(?:import|export)\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?["']([^"']+)["']/g;
  while ((m = stat.exec(text))) specs.add(m[1]);
  const dyn = /import\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dyn.exec(text))) specs.add(m[1]);
  return [...specs].filter(s => s.startsWith('.'));
}

export function augment(graph, projectRoot, opts = {}) {
  const { routes: doRoutes = true, imports: doImports = true, lang = 'en' } = opts;
  const zh = lang.startsWith('zh');
  const report = { removedNodes: 0, removedEdges: 0, endpoints: 0, routesEdges: 0, middlewareEdges: 0, importEdges: 0, missingHandlers: [], missingMiddleware: [], unresolvedImports: {}, warnings: [] };

  // 1. purge what a previous run added
  const genNodes = new Set(graph.nodes.filter(n => n.tags?.includes(NODE_TAG)).map(n => n.id));
  const before = { n: graph.nodes.length, e: graph.edges.length };
  graph.nodes = graph.nodes.filter(n => !genNodes.has(n.id));
  graph.edges = graph.edges.filter(e => e.description !== MARKER && !genNodes.has(e.source) && !genNodes.has(e.target));
  for (const l of graph.layers ?? []) l.nodeIds = l.nodeIds.filter(id => !genNodes.has(id));
  report.removedNodes = before.n - graph.nodes.length;
  report.removedEdges = before.e - graph.edges.length;

  const nodeIds = new Set(graph.nodes.map(n => n.id));
  const edgeSet = new Set(graph.edges.map(e => `${e.source}|${e.target}|${e.type}`));
  const addEdge = (e) => {
    const k = `${e.source}|${e.target}|${e.type}`;
    if (edgeSet.has(k)) return false;
    edgeSet.add(k);
    graph.edges.push({ ...e, direction: 'forward', description: MARKER });
    return true;
  };
  const read = (rel) => fs.readFileSync(path.join(projectRoot, rel), 'utf8');

  // 2. Gin routes
  if (doRoutes) {
    const goFiles = graph.nodes.filter(n => n.type === 'file' && n.filePath?.endsWith('.go'));
    const goSources = goFiles.map(n => read(n.filePath));
    const resolveConst = makeConstResolver(goSources);
    const fnByName = {};
    for (const n of graph.nodes) if (n.type === 'function' && n.filePath?.endsWith('.go')) (fnByName[n.name] ||= []).push(n);
    const pick = (name, pkg) => {
      const c = fnByName[name] ?? [];
      const inPkg = c.filter(n => path.dirname(n.filePath).split('/').pop() === pkg);
      if (inPkg.length === 1) return inPkg[0];
      if (inPkg.length === 0 && c.length === 1) return c[0];
      return null;
    };
    goFiles.forEach((fileNode, idx) => {
      const src = goSources[idx];
      if (!/\.Group\(/.test(src) || !new RegExp(`\\.(${HTTP})\\("`).test(src)) return;
      const routes = parseGinRoutes(src, resolveConst);
      if (!routes.length) return;
      const layer = (graph.layers ?? []).find(l => l.nodeIds.includes(fileNode.id));
      if (!layer) report.warnings.push(`${fileNode.filePath}: file is in no layer, endpoints left unassigned`);
      const seen = new Set();
      for (const r of routes) {
        const name = `${r.method} ${r.full}`;
        const id = `endpoint:${fileNode.filePath}:${name}`;
        if (seen.has(id)) { report.warnings.push(`duplicate route ${name}`); continue; }
        seen.add(id);
        const userMw = [...new Set(r.mw)];
        const handlerDesc = r.handler ? `${r.handlerPkg}.${r.handler}` : r.raw;
        const summary = zh
          ? `${name}：由 ${handlerDesc} 處理` + (userMw.length ? `；中介層順序 ${userMw.join('、')}。` : '。')
          : `${name}: handled by ${handlerDesc}` + (userMw.length ? `; middleware chain ${userMw.join(', ')}.` : '.');
        graph.nodes.push({
          id, type: 'endpoint', name, filePath: fileNode.filePath, lineRange: [r.line, r.line],
          summary, tags: ['api', 'endpoint', r.method.toLowerCase(), r.full.split('/')[3] || 'root', NODE_TAG],
          complexity: 'simple',
        });
        nodeIds.add(id);
        if (layer) layer.nodeIds.push(id);
        report.endpoints++;
        addEdge({ source: fileNode.id, target: id, type: 'contains', weight: 1.0 });
        const fn = r.handler ? pick(r.handler, r.handlerPkg) : null;
        if (fn) { if (addEdge({ source: id, target: fn.id, type: 'routes', weight: 0.5 })) report.routesEdges++; }
        else report.missingHandlers.push(`${name} -> ${handlerDesc}`);
        for (const mw of userMw) {
          const f = pick(mw, 'middleware');
          if (f) { if (addEdge({ source: id, target: f.id, type: 'middleware', weight: 0.5 })) report.middlewareEdges++; }
          else if (!report.missingMiddleware.includes(mw)) report.missingMiddleware.push(mw);
        }
      }
    });
  }

  // 3. relative imports of JS-family / Vue files
  if (doImports) {
    const fileIds = new Set(graph.nodes.filter(n => n.type === 'file').map(n => n.id));
    for (const n of graph.nodes.filter(x => x.type === 'file' && JS_EXT.test(x.filePath ?? ''))) {
      for (const spec of parseRelativeImports(read(n.filePath))) {
        const abs = path.resolve(projectRoot, path.dirname(n.filePath), spec);
        const rel = path.relative(projectRoot, abs);
        const hit = RESOLVE_SUFFIXES.map(s => `file:${rel}${s}`).find(id => fileIds.has(id));
        if (!hit) { const ext = path.extname(spec) || 'noext'; report.unresolvedImports[ext] = (report.unresolvedImports[ext] || 0) + 1; continue; }
        if (hit !== n.id && addEdge({ source: n.id, target: hit, type: 'imports', weight: 0.7 })) report.importEdges++;
      }
    }
  }
  return report;
}

export function validateGraph(graph) {
  const issues = [];
  const ids = new Set();
  for (const n of graph.nodes) { if (ids.has(n.id)) issues.push(`duplicate node ${n.id}`); ids.add(n.id); }
  const ek = new Set();
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) issues.push(`dangling edge ${e.source} -> ${e.target}`);
    const k = `${e.source}|${e.target}|${e.type}`;
    if (ek.has(k)) issues.push(`duplicate edge ${k}`);
    ek.add(k);
  }
  const assigned = new Map();
  for (const l of graph.layers ?? []) for (const id of l.nodeIds) assigned.set(id, (assigned.get(id) || 0) + 1);
  for (const [id, c] of assigned) if (c > 1) issues.push(`node in ${c} layers: ${id}`);
  for (const n of graph.nodes) if (FILE_LEVEL.has(n.type) && (graph.layers ?? []).length && !assigned.has(n.id)) issues.push(`file-level node in no layer: ${n.id}`);
  return issues;
}

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter(a => a.startsWith('--')));
  const projectRoot = path.resolve(args.find(a => !a.startsWith('--')) ?? process.cwd());
  const dataDir = resolveDataDir(projectRoot);
  const graphPath = path.join(dataDir, 'knowledge-graph.json');
  if (!fs.existsSync(graphPath)) { console.error(`No knowledge graph at ${graphPath}. Run /understand first.`); process.exit(1); }
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  let lang = 'en';
  try { lang = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).outputLanguage || 'en'; } catch { /* no config: English */ }
  const report = augment(graph, projectRoot, { routes: !flags.has('--no-routes'), imports: !flags.has('--no-imports'), lang });
  const issues = validateGraph(graph);
  console.log(JSON.stringify({ ...report, nodes: graph.nodes.length, edges: graph.edges.length, validationIssues: issues.length }, null, 2));
  if (issues.length) { console.error(issues.slice(0, 10).join('\n')); console.error('Validation failed: graph not written.'); process.exit(2); }
  if (flags.has('--dry-run')) { console.log('--dry-run: graph not written.'); return; }
  const tmp = `${graphPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(graph));
  fs.renameSync(tmp, graphPath);
  console.log(`Wrote ${graphPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
