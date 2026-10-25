// Every way into the app, read from the code (not a hand list): route handlers and their methods, the Better Auth
// endpoints the auth route serves, server actions ('use server' exports, and inline ones), pages, MCP tools and the
// Discord commands, autocompletes and buttons. The leak-audit suite imports it and fails on any entry point that has
// no audit entry ("unaudited entry point: X"), so a new route, action, page or tool cannot ship unaudited.
// Run alone to list them: node tests/e2e/entry-points.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

function* files(p, re) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const f of readdirSync(p)) if (f !== 'node_modules' && (!f.startsWith('.') || f === '.well-known')) yield* files(join(p, f), re);
  } else if (re.test(p)) yield p;
}
const rel = f => relative(ROOT, f).split('\\').join('/');
const read = f => readFileSync(join(ROOT, f), 'utf8');
/** app/(app)/tasks/[id]/page.tsx -> /tasks/[id] (route groups dropped). */
const urlOf = f => '/' + f.replace(/^app\//, '').replace(/(^|\/)(page|route)\.tsx?$/, '').split('/').filter(s => s && !/^\(.*\)$/.test(s)).join('/');

/** Methods a route file exports: function/const declarations, `export { x as GET }` and `export const { GET, POST } = …`. */
export function routeMethods(src) {
  const out = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let)\s+([A-Z]+)\b/gm)) if (METHODS.includes(m[1])) out.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && METHODS.includes(name)) out.add(name);
    }
  }
  // export const { GET, POST } = handlers; export const { handler: PUT } = x; export const { GET = f } = y
  for (const m of src.matchAll(/^export\s+(?:const|let)\s*\{([^}]*)\}\s*=/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.split('=')[0].split(':').pop()?.trim();
      if (name && METHODS.includes(name)) out.add(name);
    }
  }
  return [...out].sort();
}

/**
 * Routes and pages the last build serves (.next/server/app-paths-manifest.json) that the enumeration has no entry for:
 * a way in the source scan missed (a metadata file, an export form it cannot read). Null when there is no build.
 */
export function unlistedBuilt(eps = entryPoints()) {
  let keys;
  try {
    keys = Object.keys(JSON.parse(readFileSync(join(ROOT, '.next', 'server', 'app-paths-manifest.json'), 'utf8')));
  } catch {
    return null;
  }
  const routes = new Set(eps.filter(e => e.kind === 'route').map(e => e.id.split(' ').pop()));
  const pages = new Set(eps.filter(e => e.kind === 'page').map(e => e.id.split(' ').pop()));
  const out = [];
  for (const k of keys) {
    const kind = k.endsWith('/route') ? 'route' : k.endsWith('/page') ? 'page' : null;
    const url = '/' + k.replace(/\/(page|route)$/, '').split('/').filter(s => s && !/^\(.*\)$/.test(s)).join('/');
    if (kind === 'page' && (url === '/_not-found' || url === '/_global-error')) continue; // Next's own error pages
    if (!kind || !(kind === 'route' ? routes : pages).has(url)) out.push(k);
  }
  return out;
}

/** Exported names of a file-level 'use server' module. */
export function actionExports(src) {
  const out = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\s*\*?|const|let)\s+([A-Za-z0-9_$]+)/gm)) out.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop()?.trim(); if (n) out.add(n); }
  if (/^export\s+default\b/m.test(src)) out.add('default');
  return [...out].sort();
}

const fileLevelUseServer = src => /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use server['"]/.test(src);

export function entryPoints() {
  const out = [];
  const add = (kind, id, where) => out.push({ kind, id: `${kind} ${id}`, where });

  for (const f of files(join(ROOT, 'app'), /[\\/]route\.tsx?$/)) {
    const r = rel(f);
    const methods = routeMethods(read(r));
    if (!methods.length) add('route', `? ${urlOf(r)}`, r); // a route file with no method we can read is still an entry point
    for (const m of methods) add('route', `${m} ${urlOf(r)}`, r);
  }
  // Metadata routes Next serves from special files in app/ (GET only). unlistedBuilt() catches any this list misses.
  for (const [file, url] of [['favicon.ico', '/favicon.ico'], ['manifest.ts', '/manifest.webmanifest'], ['manifest.json', '/manifest.json'], ['manifest.webmanifest', '/manifest.webmanifest'], ['robots.ts', '/robots.txt'], ['robots.txt', '/robots.txt'], ['sitemap.ts', '/sitemap.xml'], ['sitemap.xml', '/sitemap.xml']]) {
    try {
      if (statSync(join(ROOT, 'app', file)).isFile()) add('route', `GET ${url}`, `app/${file}`);
    } catch {
      /* not there */
    }
  }

  // The Better Auth endpoints the auth route serves (its ALLOWED set; everything else is a 404 there).
  const authRoute = 'app/api/auth/[...all]/route.ts';
  const allowed = read(authRoute).match(/const ALLOWED = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
  for (const m of allowed.matchAll(/'([^']+)'/g)) add('auth', m[1], authRoute);
  if (/reset-password\\\/\[/.test(read(authRoute))) add('auth', '/reset-password/<token>', authRoute);

  for (const f of files(ROOT, /\.(ts|tsx|mjs|js)$/)) {
    const r = rel(f);
    if (!/^(app|lib|components)\//.test(r)) continue;
    const src = read(r);
    if (fileLevelUseServer(src)) for (const n of actionExports(src)) add('action', `${r}#${n}`, r);
    // An inline server action ('use server' inside a function body) is an entry point too.
    src.split(/\r?\n/).forEach((line, i) => {
      if (i > 0 && /^\s+['"]use server['"]/.test(line)) add('action', `${r}:${i + 1} (inline)`, r);
    });
  }

  for (const f of files(join(ROOT, 'app'), /[\\/]page\.tsx?$/)) add('page', urlOf(rel(f)), rel(f));

  // MCP tools: every tool('<name>', …) registration in the server (the leak-audit suite also compares this with tools/list as the owner).
  const mcp = 'lib/mcp/server.ts';
  for (const m of read(mcp).matchAll(/\btool\(\s*'([a-z_]+)'/g)) add('mcp', m[1], mcp);

  // Discord: commands registered per server, what the interactions route and handleInteraction answer, autocompletes
  // and the buttons, select and modal of an "Added" reply.
  const dc = 'lib/discord/commands.ts';
  const dsrc = read(dc);
  const defs = dsrc.slice(dsrc.indexOf('Command definitions'), dsrc.indexOf('// ── Helpers'));
  for (const m of defs.matchAll(/^\s*(?:\{\s*)?type: [13],\s*(?:\n\s*)?name: '([^']+)'/gm)) add('discord', `command ${m[1]}`, dc);
  for (const m of dsrc.matchAll(/focused\.name === '([a-z_]+)'/g)) add('discord', `autocomplete ${m[1]}`, dc);
  const comp = dsrc.match(/\^wo:\(([a-z|]+)\)/)?.[1] ?? '';
  for (const k of comp.split('|').filter(Boolean)) add('discord', `component ${k}`, dc);
  // Handled names must all be registered (and the other way round): a handler with no registration is still reachable
  // by a crafted interaction.
  for (const m of dsrc.matchAll(/(?<!focused\.)\bname === '([^']+)'/g)) if (!out.some(e => e.id === `discord command ${m[1]}`)) add('discord', `command ${m[1]} (handled, not registered)`, dc);

  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const all = entryPoints();
  const by = {};
  for (const e of all) by[e.kind] = (by[e.kind] ?? 0) + 1;
  for (const e of all) console.log(e.id);
  console.log('\n' + Object.entries(by).map(([k, n]) => `${k} ${n}`).join(', ') + `, total ${all.length}`);
  const gaps = unlistedBuilt(all);
  console.log(gaps === null ? 'no build to compare with' : gaps.length ? `built but not listed: ${gaps.join(', ')}` : 'every built route and page is listed');
}
