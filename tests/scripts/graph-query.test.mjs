import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findStart, traverse, summarize } from '../../scripts/graph-query.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/graph-query.mjs');
const n = (id, type, extra = {}) => ({ id, type, name: extra.name ?? id.split(':').pop(), filePath: extra.filePath, summary: 's', tags: ['t'], complexity: 'simple' });

const graph = {
  nodes: [
    n('file:r/router.go', 'file', { filePath: 'r/router.go' }),
    n('endpoint:r/router.go:GET /api/v1/x', 'endpoint', { name: 'GET /api/v1/x', filePath: 'r/router.go' }),
    n('file:c/x.go', 'file', { filePath: 'c/x.go' }), n('function:c/x.go:GetX', 'function', { name: 'GetX', filePath: 'c/x.go' }),
    n('file:s/x.go', 'file', { filePath: 's/x.go' }), n('function:s/x.go:LoadX', 'function', { name: 'LoadX', filePath: 's/x.go' }),
    n('file:m/x.go', 'file', { filePath: 'm/x.go' }), n('function:m/x.go:FindX', 'function', { name: 'FindX', filePath: 'm/x.go' }),
    n('file:s/x_test.go', 'file', { filePath: 's/x_test.go' }),
  ],
  edges: [
    { source: 'endpoint:r/router.go:GET /api/v1/x', target: 'function:c/x.go:GetX', type: 'routes' },
    { source: 'function:c/x.go:GetX', target: 'function:s/x.go:LoadX', type: 'calls' },
    { source: 'function:s/x.go:LoadX', target: 'function:m/x.go:FindX', type: 'calls' },
    { source: 'file:s/x.go', target: 'file:s/x_test.go', type: 'tested_by' },
    { source: 'file:r/router.go', target: 'endpoint:r/router.go:GET /api/v1/x', type: 'contains' },
  ],
  layers: [{ id: 'layer:api', name: 'API', description: 'd', nodeIds: ['file:r/router.go', 'file:c/x.go'] },
           { id: 'layer:svc', name: 'Service', description: 'd', nodeIds: ['file:s/x.go', 'file:m/x.go', 'file:s/x_test.go'] }],
};

describe('graph-query', () => {
  it('finds an endpoint by exact name and a file by path substring', () => {
    expect(findStart(graph, 'GET /api/v1/x').map(x => x.id)).toEqual(['endpoint:r/router.go:GET /api/v1/x']);
    expect(findStart(graph, 'm/x.go').map(x => x.id)).toContain('file:m/x.go');
    expect(findStart(graph, 'nope/nothing')).toEqual([]);
  });

  it('chain follows routes/calls down to the requested depth', () => {
    const starts = findStart(graph, 'GET /api/v1/x');
    const d1 = summarize(graph, traverse(graph, starts, { depth: 1, direction: 'down' }));
    expect(d1.files.map(f => f.file)).toEqual(['c/x.go']);
    const d3 = summarize(graph, traverse(graph, starts, { depth: 3, direction: 'down' }));
    expect(d3.files.map(f => f.file).sort()).toEqual(['c/x.go', 'm/x.go', 's/x.go']);
    expect(d3.files.find(f => f.file === 'm/x.go').layer).toBe('Service');
  });

  it('impact walks up from a changed file to endpoints and its tests', () => {
    const starts = [graph.nodes.find(x => x.id === 'file:m/x.go'), graph.nodes.find(x => x.id === 'function:m/x.go:FindX')];
    const s = summarize(graph, traverse(graph, starts, { depth: 4, direction: 'up' }));
    expect(s.endpoints).toEqual(['GET /api/v1/x']);
    expect(s.files.map(f => f.file)).toContain('c/x.go');
    const fromService = summarize(graph, traverse(graph, [graph.nodes.find(x => x.id === 'file:s/x.go'), graph.nodes.find(x => x.id === 'function:s/x.go:LoadX')], { depth: 2, direction: 'up' }));
    expect(fromService.tests).toEqual(['s/x_test.go']);
  });

  it('a symbol and its file are linked at the same depth, so file-level imports are followed', () => {
    const g = {
      nodes: [n('endpoint:r.go:GET /h', 'endpoint', { name: 'GET /h', filePath: 'r.go' }), n('function:h/h.go:Handle', 'function', { name: 'Handle', filePath: 'h/h.go' }),
        n('file:h/h.go', 'file', { filePath: 'h/h.go' }), n('file:u/u.go', 'file', { filePath: 'u/u.go' }), n('file:m/h.go', 'file', { filePath: 'm/h.go' })],
      edges: [{ source: 'endpoint:r.go:GET /h', target: 'function:h/h.go:Handle', type: 'routes' },
        { source: 'file:h/h.go', target: 'file:u/u.go', type: 'imports' }, { source: 'file:h/h.go', target: 'file:m/h.go', type: 'imports' }],
      layers: [],
    };
    const down = summarize(g, traverse(g, findStart(g, 'GET /h'), { depth: 2, direction: 'down' }));
    expect(down.files.map(f => f.file)).toEqual(['h/h.go', 'm/h.go', 'u/u.go']);
    expect(down.files.find(f => f.file === 'm/h.go').sameName).toBe(true);   // same basename as nearer h/h.go
    expect(down.files.find(f => f.file === 'u/u.go').sameName).toBe(false);
    const up = summarize(g, traverse(g, [g.nodes.find(x => x.id === 'file:u/u.go')], { depth: 3, direction: 'up' }));
    expect(up.endpoints).toEqual(['GET /h']);
  });

  it('flags an impact result that reaches most endpoints as broad', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-gq-broad-'));
    fs.mkdirSync(path.join(dir, '.ua'));
    fs.writeFileSync(path.join(dir, '.ua/knowledge-graph.json'), JSON.stringify(graph));
    const out = JSON.parse(execFileSync('node', [SCRIPT, dir, 'impact', 'm/x.go', '--json'], { encoding: 'utf8' }));
    expect(out.broad).toBe(true);          // 1 of 1 endpoints
    expect(out.totalEndpoints).toBe(1);
    const text = execFileSync('node', [SCRIPT, dir, 'impact', 'm/x.go'], { encoding: 'utf8' });
    expect(text).toMatch(/BROAD/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('CLI exits 2 with a clear message when nothing matches', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-gq-'));
    fs.mkdirSync(path.join(dir, '.ua'));
    fs.writeFileSync(path.join(dir, '.ua/knowledge-graph.json'), JSON.stringify(graph));
    const r = spawnSync('node', [SCRIPT, dir, 'chain', 'does/not/exist'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no node matches/i);
    const ok = execFileSync('node', [SCRIPT, dir, 'chain', 'GET /api/v1/x', '--json'], { encoding: 'utf8' });
    expect(JSON.parse(ok).files.map(f => f.file)).toContain('c/x.go');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // --- honesty / input-handling behaviours ---
  const withGraph = (g, fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-gq-x-'));
    fs.mkdirSync(path.join(dir, '.ua'));
    fs.writeFileSync(path.join(dir, '.ua/knowledge-graph.json'), JSON.stringify(g));
    try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const run = (...a) => spawnSync('node', [SCRIPT, ...a], { encoding: 'utf8' });

  it('does not flag impact as broad when it reaches only some endpoints, and lists them', () => {
    const g = {
      nodes: [
        n('endpoint:r.go:GET /a', 'endpoint', { name: 'GET /a', filePath: 'r.go' }), n('endpoint:r.go:GET /b', 'endpoint', { name: 'GET /b', filePath: 'r.go' }),
        n('function:a/a.go:A', 'function', { name: 'A', filePath: 'a/a.go' }), n('file:a/a.go', 'file', { filePath: 'a/a.go' }),
        n('function:b/b.go:B', 'function', { name: 'B', filePath: 'b/b.go' }), n('file:b/b.go', 'file', { filePath: 'b/b.go' }),
      ],
      edges: [{ source: 'endpoint:r.go:GET /a', target: 'function:a/a.go:A', type: 'routes' }, { source: 'endpoint:r.go:GET /b', target: 'function:b/b.go:B', type: 'routes' }],
      layers: [],
    };
    withGraph(g, dir => {
      const out = JSON.parse(run(dir, 'impact', 'a/a.go', '--json').stdout);
      expect(out.broad).toBe(false);
      expect(out.totalEndpoints).toBe(2);
      expect(out.endpoints).toEqual(['GET /a']);
      const text = run(dir, 'impact', 'a/a.go').stdout;
      expect(text).not.toMatch(/BROAD/);
      expect(text).toContain('GET /a');
      expect(text).not.toContain('GET /b');
    });
  });

  it('validates --depth: bad or missing values exit 1 with usage; a valid value keeps the query intact', () => {
    withGraph(graph, dir => {
      for (const bad of [['--depth', 'abc'], ['--depth', '0'], ['--depth', '-2'], ['--depth', '1.5']]) {
        const r = run(dir, 'chain', 'GET /api/v1/x', ...bad);
        expect(r.status, bad.join(' ')).toBe(1);
        expect(r.stderr).toMatch(/usage/i);
      }
      const last = run(dir, 'chain', 'GET /api/v1/x', '--depth');
      expect(last.status).toBe(1);
      expect(last.stderr).toMatch(/usage/i);
      const ok = run(dir, 'chain', 'GET /api/v1/x', '--depth', '2', '--json');
      expect(ok.status).toBe(0);
      expect(JSON.parse(ok.stdout).files.map(f => f.file)).toEqual(['c/x.go', 's/x.go']);
      // flag before the query and a depth value equal to a positional must not eat the wrong argument
      const early = run('--depth', '2', dir, 'chain', 'GET /api/v1/x', '--json');
      expect(JSON.parse(early.stdout).files.map(f => f.file)).toEqual(['c/x.go', 's/x.go']);
    });
  });

  it('impact normalises ./relative and absolute paths against the project root', () => {
    withGraph(graph, dir => {
      const files = (...a) => JSON.parse(run(dir, 'impact', ...a, '--json').stdout).files.map(f => f.file);
      const base = files('m/x.go');
      expect(base).toContain('c/x.go');
      expect(files('./m/x.go')).toEqual(base);
      expect(files(path.join(dir, 'm/x.go'))).toEqual(base);
      const miss = run(dir, 'impact', '/definitely/outside/y.go');
      expect(miss.status).toBe(2);
      expect(miss.stderr).toContain('/definitely/outside/y.go');
    });
  });

  it('collapses symbol-less deeper files into a "more" line and --all lists them', () => {
    const g = {
      nodes: ['a/a.go', 'b/b.go', 'c/c.go', 'd/d.go'].map(f => n(`file:${f}`, 'file', { filePath: f })),
      edges: [{ source: 'file:a/a.go', target: 'file:b/b.go', type: 'imports' }, { source: 'file:b/b.go', target: 'file:c/c.go', type: 'imports' }, { source: 'file:b/b.go', target: 'file:d/d.go', type: 'imports' }],
      layers: [],
    };
    withGraph(g, dir => {
      const text = run(dir, 'chain', 'a/a.go', '--depth', '2').stdout;
      expect(text).toContain('b/b.go');
      expect(text).toMatch(/\+2 more \(package-level imports\)/);
      expect(text).not.toContain('c/c.go  [');
      const all = run(dir, 'chain', 'a/a.go', '--depth', '2', '--all').stdout;
      expect(all).toContain('c/c.go');
      expect(all).toContain('d/d.go');
      expect(all).not.toMatch(/more \(package-level imports\)/);
    });
  });
});
