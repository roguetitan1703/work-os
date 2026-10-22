// Static half of the one-door test (docs/multi-user.md "One door for data"): fails when code that serves people reaches
// a MongoDB collection without going through lib/scope.ts. Raw access is allowed only on a line that says why:
//   // scope-ok: <reason>
// Run: node tests/scope-check.mjs (also `npm run build` via prebuild, and the tenancy e2e suite).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SCANNED = ['lib', 'app'];
// db.ts opens the connection and defines the collections; scope.ts is the door itself.
const SKIPPED = new Set(['lib/db.ts', 'lib/scope.ts']);
// These read Better Auth's own collections (member, user, organization, invitation, session, account) or the auth
// rate-limit log: sign-in, roles and memberships, no work data; each query is keyed by the caller's id or organization.
const ALLOWED_FILES = new Set(['lib/people.ts', 'lib/auth-server.ts', 'lib/auth-limits.ts', 'lib/caller.ts', 'lib/fresh.ts', 'lib/members.ts']);
const RAW = /\b(collections|getDb|getClient)\s*\(|\.collection\s*[<(]/;

function* files(p) {
  const st = statSync(p);
  if (st.isDirectory()) for (const f of readdirSync(p)) yield* files(join(p, f));
  else if (/\.(ts|tsx|mjs|js)$/.test(p)) yield p;
}

export function scopeViolations() {
  const out = [];
  for (const top of SCANNED) {
    for (const f of files(join(ROOT, top))) {
      const rel = relative(ROOT, f).split('\\').join('/');
      if (ALLOWED_FILES.has(rel) || SKIPPED.has(rel)) continue;
      readFileSync(f, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (RAW.test(line) && !/scope-ok:\s*\S/.test(line) && !/^\s*(\/\/|\*)/.test(line)) out.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`);
        });
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const v = scopeViolations();
  if (v.length) {
    console.error(`Data access outside the scoped door (lib/scope.ts). Use scoped(scope), or add "// scope-ok: <reason>" on the line:\n${v.join('\n')}`);
    process.exit(1);
  }
  console.log('scope check: ok');
}
