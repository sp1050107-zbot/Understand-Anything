import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseGinRoutes, parseRelativeImports } from '../../scripts/augment-gin-vue.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/augment-gin-vue.mjs');

const ROUTER = `package routes
func ConfigureRoutes() {
	Router.Use(middleware.ValidateJWT)
	RouterGroup = Router.Group("/api/" + global.VERSION)
	configureUserRoutes()
}
func configureUserRoutes() {
	userRoutes := RouterGroup.Group("/user")
	userRoutes.Use(middleware.IsLoggedIn())
	{
		userRoutes.GET("/me", controllers.GetUserInfo)
		userRoutes.POST("/:id/pin", middleware.Strict(1), controllers.PinUser)
	}
	userRoutes.Use(middleware.IsSysAdm())
	userRoutes.GET("/", controllers.GetAllUsers)
	// userRoutes.DELETE("/gone", controllers.Gone)
}
`;

function fn(file, name) {
  return { id: `function:${file}:${name}`, type: 'function', name, filePath: file, summary: 's', tags: ['t'], complexity: 'simple' };
}
function file(p, type = 'file') {
  return { id: `file:${p}`, type, name: path.basename(p), filePath: p, summary: 's', tags: ['t'], complexity: 'simple' };
}

describe('parseGinRoutes', () => {
  const resolve = (id) => ({ VERSION: 'v1' })[id] ?? null;

  it('builds full paths, applies Use() only to later routes, skips comments', () => {
    const routes = parseGinRoutes(ROUTER, resolve);
    expect(routes.map(r => `${r.method} ${r.full}`)).toEqual([
      'GET /api/v1/user/me', 'POST /api/v1/user/:id/pin', 'GET /api/v1/user/',
    ]);
    expect(routes[0].mw).toEqual(['ValidateJWT', 'IsLoggedIn']);
    expect(routes[1].mw).toEqual(['ValidateJWT', 'IsLoggedIn', 'Strict']);
    expect(routes[2].mw).toEqual(['ValidateJWT', 'IsLoggedIn', 'IsSysAdm']);
    expect(routes[2].handler).toBe('GetAllUsers');
  });
});

describe('parseRelativeImports', () => {
  it('finds static, side-effect, re-export and dynamic imports; ignores comments and packages', () => {
    const src = `
import { a,
  b } from "../store/x";
import "./side.css";
export * from './re';
// import nope from './commented';
const P = () => import("../views/P.vue");
import vue from "vue";
`;
    expect(parseRelativeImports(src).sort()).toEqual(['../store/x', '../views/P.vue', './re', './side.css'].sort());
  });
});

describe('augment-gin-vue CLI', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-augment-'));
    const w = (rel, content) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), content); };
    w('be/routes/router.go', ROUTER);
    w('be/global/consts.go', 'package global\nconst VERSION = "v1"\n');
    w('be/controllers/u.go', 'package controllers\n');
    w('be/middleware/m.go', 'package middleware\n');
    w('fe/src/main.js', 'import App from "./App.vue";\nimport s from "./store/s";\n');
    w('fe/src/App.vue', '<script setup>\nimport { x } from "./store/s.js";\n</script>\n');
    w('fe/src/store/s.js', 'export const x = 1;\n');
    const nodes = [
      file('be/routes/router.go'), file('be/global/consts.go'), file('be/controllers/u.go'), file('be/middleware/m.go'),
      file('fe/src/main.js'), file('fe/src/App.vue'), file('fe/src/store/s.js'),
      fn('be/controllers/u.go', 'GetUserInfo'), fn('be/controllers/u.go', 'PinUser'), fn('be/controllers/u.go', 'GetAllUsers'),
      ...['ValidateJWT', 'IsLoggedIn', 'IsSysAdm', 'Strict'].map(n => fn('be/middleware/m.go', n)),
    ];
    const graph = {
      version: '1.0.0', project: { name: 'p' }, nodes, edges: [],
      layers: [{ id: 'layer:be', name: 'be', description: 'd', nodeIds: nodes.filter(n => n.type === 'file' && n.filePath.startsWith('be/')).map(n => n.id) },
               { id: 'layer:fe', name: 'fe', description: 'd', nodeIds: nodes.filter(n => n.type === 'file' && n.filePath.startsWith('fe/')).map(n => n.id) }],
      tour: [],
    };
    fs.mkdirSync(path.join(dir, '.ua'));
    fs.writeFileSync(path.join(dir, '.ua/knowledge-graph.json'), JSON.stringify(graph));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = (...extra) => execFileSync('node', [SCRIPT, dir, ...extra], { encoding: 'utf8' });
  const load = () => JSON.parse(fs.readFileSync(path.join(dir, '.ua/knowledge-graph.json'), 'utf8'));

  it('adds endpoint nodes, routes/middleware edges and import edges', () => {
    run();
    const g = load();
    const eps = g.nodes.filter(n => n.type === 'endpoint');
    expect(eps.map(n => n.name).sort()).toEqual(['GET /api/v1/user/', 'GET /api/v1/user/me', 'POST /api/v1/user/:id/pin']);
    expect(g.edges.filter(e => e.type === 'routes')).toHaveLength(3);
    expect(g.edges.filter(e => e.type === 'middleware').length).toBeGreaterThan(3);
    const imp = g.edges.filter(e => e.type === 'imports').map(e => `${e.source}>${e.target}`).sort();
    expect(imp).toEqual(['file:fe/src/App.vue>file:fe/src/store/s.js', 'file:fe/src/main.js>file:fe/src/App.vue', 'file:fe/src/main.js>file:fe/src/store/s.js']);
    const beLayer = g.layers.find(l => l.id === 'layer:be');
    expect(eps.every(n => beLayer.nodeIds.includes(n.id))).toBe(true);
  });

  it('is idempotent: a second run yields the same graph', () => {
    run();
    const first = load();
    run();
    const second = load();
    expect(second.nodes).toHaveLength(first.nodes.length);
    expect(second.edges).toHaveLength(first.edges.length);
    expect(second.layers.flatMap(l => l.nodeIds)).toHaveLength(first.layers.flatMap(l => l.nodeIds).length);
  });

  it('removes stale generated nodes after the router changes', () => {
    run();
    fs.writeFileSync(path.join(dir, 'be/routes/router.go'), ROUTER.replace('\t\tuserRoutes.GET("/me", controllers.GetUserInfo)\n', ''));
    run();
    const names = load().nodes.filter(n => n.type === 'endpoint').map(n => n.name);
    expect(names).not.toContain('GET /api/v1/user/me');
    expect(names).toHaveLength(2);
  });

  it('does not touch the graph with --dry-run', () => {
    const before = fs.readFileSync(path.join(dir, '.ua/knowledge-graph.json'), 'utf8');
    run('--dry-run');
    expect(fs.readFileSync(path.join(dir, '.ua/knowledge-graph.json'), 'utf8')).toBe(before);
  });
});
