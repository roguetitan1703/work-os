// The production blocks of the Work OS hook (docs/flows/agent-system.md section 10, H8): is this Bash or PowerShell command a
// push, tag or release to a project's production, or a production CLI command? An exact test, never a word detector.
// Used by hook-pre-tool.mjs; not an event of its own. Everything here runs on the PC: the command, its arguments and the
// remote's address never leave it; only { what, name } (name = a branch, tag or CLI name) goes to POST /api/agent/release.
//
// The brief hands the hook what production means for the project: { remotes: ['owner/name'], branches: ['main', 'master'],
// targets: ['<supabase project ref>'] }. Anything this file cannot parse exactly (a $VAR remote, a script that pushes, a push
// inside `bash -c "..."`) passes: this is a guard against an agent's mistake, not against an attacker, and the person's own
// terminal is never touched.
import fs from 'node:fs';
import path from 'node:path';
import { git } from './hook-lib.mjs';
import { normalizeRemote } from './remote.mjs';

const OPS = [['&&'], ['||'], [';'], ['|'], ['&'], ['\n']];

/**
 * A command line as a list of commands, each a list of words. Splits on && || ; | & and newlines outside quotes; quotes are
 * removed from the words. A word that holds a variable or a substitution ($, a backtick) is marked `dyn` on the list.
 */
export function splitCommands(cmd) {
  const cmds = [];
  let words = [];
  let cur = '';
  let has = false;
  let dyn = false;
  const endWord = () => { if (has) { const w = new String(cur); w.dyn = dyn; words.push(w); } cur = ''; has = false; dyn = false; };
  const endCmd = () => { endWord(); if (words.length) cmds.push(words); words = []; };
  const s = String(cmd ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      has = true;
      const j = s.indexOf("'", i + 1);
      const end = j < 0 ? s.length : j;
      cur += s.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      has = true;
      i++;
      for (; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === '\\' && (s[i + 1] === '"' || s[i + 1] === '\\')) i++;
        else if (s[i] === '$' || s[i] === '`') dyn = true;
        cur += s[i];
      }
    } else if (c === '\\' && (s[i + 1] === '"' || s[i + 1] === "'" || s[i + 1] === ' ')) {
      has = true;
      cur += s[++i];
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
    } else if (c === '\n' || c === ';') {
      endCmd();
    } else if (c === '&' || c === '|') {
      const two = s[i + 1] === c;
      // PowerShell's call operator `& 'x'` starts a command: dropped. A redirect like 2>&1 stays inside its word.
      if (c === '&' && !has && !words.length) { i += two ? 1 : 0; continue; }
      if (c === '&' && has && /[<>]$/.test(cur)) { cur += c; continue; }
      endCmd();
      if (two) i++;
    } else {
      has = true;
      if (c === '$' || c === '`') dyn = true;
      cur += c;
    }
  }
  endCmd();
  void OPS;
  return cmds;
}

const SKIP_LEAD = new Set(['sudo', 'then', 'do', 'else', '!', 'time', 'exec', 'command', 'nohup', 'call']);
/** The words of one command without what runs it: VAR=x assignments, sudo, then / do, and an npx / pnpm dlx / bunx runner. */
function bare(words) {
  let w = words.map((x) => String(x));
  for (;;) {
    if (!w.length) return w;
    if (SKIP_LEAD.has(w[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]) || w[0] === '&') { w = w.slice(1); continue; }
    if (/^(npx|bunx)$/.test(w[0]) || (/^(pnpm|yarn)$/.test(w[0]) && w[1] === 'dlx') || (w[0] === 'npm' && w[1] === 'exec')) {
      let i = w[0] === 'npx' || w[0] === 'bunx' ? 1 : 2;
      while (i < w.length && w[i].startsWith('-')) i += /^(-p|--package|-c|--call)$/.test(w[i]) ? 2 : 1;
      if (w[i] === '--') i++;
      w = w.slice(i);
      continue;
    }
    break;
  }
  if (w.length) w[0] = w[0].replace(/@[\w.^~-]+$/, '').replace(/\.(cmd|exe|ps1)$/i, '').replace(/^.*[\\/]/, '');
  return w;
}

const isDyn = (x) => !!x && (x.dyn || /[$`]/.test(String(x)));
/** owner/name of a remote's address (https, ssh, scp style) or of an owner/name as written, lowercase; null when it is none. */
export function ownerName(s) {
  s = String(s ?? '').trim();
  // "owner/name" (or "host/owner/name") as gh and a project's code location write it: no scheme, no colon.
  if (!/[:@\\]/.test(s) && /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+){1,2}$/.test(s.replace(/\.git$/i, ''))) return s.replace(/\.git$/i, '').split('/').slice(-2).join('/').toLowerCase();
  const n = normalizeRemote(s);
  if (!n) return null;
  const parts = n.split('/').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('/') : null;
}
const nameOfUrlOrNull = (s) => (/[/:]/.test(s) ? ownerName(s) : null);

const branchHit = (b, branches) => branches.some((p) => (p.endsWith('*') ? b.startsWith(p.slice(0, -1)) : p === b));

/** The remote's owner/name for a remote given by name or address (git push's first positional), or null. */
function remoteOf(cwd, remote) {
  const direct = nameOfUrlOrNull(remote);
  if (direct) return direct;
  const url = git(cwd, ['remote', 'get-url', '--push', remote]);
  return url ? ownerName(url) : null;
}

const PUSH_VALUE_FLAGS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec', '--signed']);
const GIT_VALUE_GLOBALS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

/** `git [globals] push [flags] [remote [refspec...]]` against the production remotes and branches, or null. */
function gitPush(w, cwd, prod) {
  let i = 1;
  for (; i < w.length; i++) {
    const a = w[i];
    if (a === '-C') { cwd = path.resolve(cwd, w[++i] ?? '.'); continue; }
    if (a === '-c') { i++; continue; }
    if (a.startsWith('-')) { if (GIT_VALUE_GLOBALS.has(a)) i++; continue; }
    break;
  }
  if (w[i] !== 'push') return null;
  const flags = new Set();
  const pos = [];
  let repo = null;
  for (i++; i < w.length; i++) {
    const a = w[i];
    if (a === '--') { pos.push(...w.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, v] = a.split(/=(.*)/s);
      if (k === '--repo') repo = v ?? w[++i];
      else if (PUSH_VALUE_FLAGS.has(k) && v === undefined) i++;
      flags.add(k);
    } else if (a.startsWith('-') && a.length > 1) {
      if (/^-[A-Za-z]*n/.test(a)) flags.add('--dry-run');
      if (a === '-o') i++;
      if (/^-[A-Za-z]*d/.test(a)) flags.add('--delete');
    } else pos.push(a);
  }
  if (flags.has('--dry-run')) return null;
  if (pos.some((x) => isDyn(x)) || isDyn(repo)) return null;
  const everything = ['--tags', '--follow-tags', '--all', '--branches', '--mirror'].some((f) => flags.has(f));
  let remote = repo ?? pos.shift();
  let current = null;
  const cur = () => (current ??= git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']));
  let defaultBranch = null;
  if (!remote) {
    const up = git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}']);
    const slash = up.indexOf('/');
    if (slash > 0) { remote = up.slice(0, slash); defaultBranch = up.slice(slash + 1); } else remote = 'origin';
  } else if (repo) pos.unshift(...[]);
  const name = remoteOf(cwd, remote);
  if (!name || !prod.remotes.includes(name)) return null;
  const to = `${name}`;
  if (everything) {
    const f = ['--mirror', '--all', '--branches', '--tags', '--follow-tags'].find((x) => flags.has(x));
    return { what: f === '--tags' || f === '--follow-tags' ? 'tag' : 'push', name: f.slice(2), label: `push (${f} to ${to})` };
  }
  const specs = pos.length ? pos : [defaultBranch ?? cur()];
  for (const raw of specs) {
    let spec = raw.replace(/^\+/, '');
    let dst = spec.includes(':') ? spec.slice(spec.lastIndexOf(':') + 1) : spec;
    if (!spec.includes(':') && spec === 'HEAD') dst = cur();
    if (spec.includes(':') && !dst) dst = cur(); // "src:" pushes to the same name
    if (!dst) continue;
    if (dst.includes('*')) return { what: 'push', name: 'all branches', label: `push (all branches to ${to})` };
    if (dst.startsWith('refs/tags/')) return { what: 'tag', name: dst.slice(10).slice(0, 100), label: `tag (${dst.slice(10)} to ${to})` };
    const b = dst.replace(/^refs\/heads\//, '');
    if (branchHit(b, prod.branches)) return { what: 'push', name: b.slice(0, 100), label: `push (${b} to ${to})` };
    // A bare name that is a local tag (and no branch of the list) is a tag push.
    if (!spec.includes(':') && !dst.startsWith('refs/') && git(cwd, ['rev-parse', '-q', '--verify', `refs/tags/${b}`])) return { what: 'tag', name: b.slice(0, 100), label: `tag (${b} to ${to})` };
  }
  return null;
}

/** `gh release create|upload|edit|delete`: the repo from -R / --repo, else the folder's remotes; production when listed. */
function ghRelease(w, cwd, prod) {
  const at = w.indexOf('release');
  if (at < 1 || !w.slice(1, at).every((x, i) => x.startsWith('-') || /^(-R|--repo)$/.test(w[i]))) return null; // only flags (and their values) before "release"
  const sub = w[at + 1];
  if (!/^(create|upload|edit|delete)$/.test(sub ?? '')) return null;
  let repo = null;
  for (let i = 1; i < w.length; i++) {
    if (w[i] === '-R' || w[i] === '--repo') repo = w[i + 1];
    else if (w[i].startsWith('--repo=')) repo = w[i].slice(7);
    else if (/^-R./.test(w[i])) repo = w[i].slice(2);
  }
  if (isDyn(repo)) return null;
  let names;
  if (repo) names = [ownerName(repo)];
  else names = git(cwd, ['config', '--get-regexp', '^remote\\..*\\.(push)?url$']).split('\n').map((l) => ownerName(l.split(/\s+/)[1])).filter(Boolean);
  const hit = names.find((n) => n && prod.remotes.includes(n));
  return hit ? { what: 'release', name: `release ${sub}`, label: `release (${sub} on ${hit})` } : null;
}

/** The words that are not flags (a flag that takes a value is skipped with it). */
function positionals(w, valueFlags) {
  const out = [];
  for (let i = 0; i < w.length; i++) {
    const a = w[i];
    if (a === '--') { out.push(...w.slice(i + 1)); break; }
    if (a.startsWith('-')) { if (valueFlags.has(a)) i++; continue; }
    out.push(a);
  }
  return out;
}
const flagValue = (w, ...names) => {
  for (let i = 0; i < w.length; i++) for (const n of names) {
    if (w[i] === n) return w[i + 1] ?? '';
    if (w[i].startsWith(n + '=')) return w[i].slice(n.length + 1);
  }
  return null;
};

const VERCEL_VALUE = new Set(['--scope', '-S', '--token', '-t', '--cwd', '--target', '-A', '--local-config', '--team', '--git-branch', '--environment', '-e', '--env', '-b', '--build-env', '-m', '--meta', '--name', '--project', '--regions']);
const SUPABASE_VALUE = new Set(['--project-ref', '--workdir', '--db-url', '--password', '-p', '--schema', '-s', '--file', '-f', '--env-file', '--import-map', '--dns-resolver', '--network-id', '--output', '-o']);

/**
 * The production CLI table (PROD_CLI): each tool is one function from its words to a match or null.
 *   vercel   --prod, --target production, env add|rm|remove|update <name> production, promote, rollback
 *   netlify  deploy --prod
 *   supabase secrets set|unset, db push, db reset --linked, migration up|repair, functions deploy|delete, config push,
 *            when the project ref (--project-ref, else supabase/.temp/project-ref) is one of the project's targets
 */
export const PROD_CLI = {
  vercel(w) {
    if (w.slice(1).some((a) => a === '--prod' || a === '--production' || a === '--prod=true')) return true;
    const t = flagValue(w, '--target');
    if (t && t.toLowerCase() === 'production') return true;
    const p = positionals(w.slice(1), VERCEL_VALUE);
    if (p[0] === 'promote' || p[0] === 'rollback') return true;
    if (p[0] === 'env' && /^(add|rm|remove|update)$/.test(p[1] ?? '')) return (p[3] ?? '').toLowerCase() === 'production' || ['--environment', '-e'].some((f) => (flagValue(w, f) ?? '').toLowerCase() === 'production');
    return false;
  },
  netlify(w) {
    const p = positionals(w.slice(1), new Set(['--site', '-s', '--auth', '--dir', '-d', '--message', '-m', '--alias', '--functions', '-f']));
    return p[0] === 'deploy' && w.slice(1).some((a) => a === '--prod' || a === '-p' || a === '--prod-if-unlocked');
  },
  supabase(w, cwd, prod) {
    const p = positionals(w.slice(1), SUPABASE_VALUE);
    const [a, b] = [p[0], p[1]];
    const hit =
      (a === 'secrets' && /^(set|unset)$/.test(b ?? '')) ||
      (a === 'db' && b === 'push') ||
      (a === 'db' && b === 'reset' && w.includes('--linked')) ||
      (a === 'migration' && /^(up|repair)$/.test(b ?? '')) ||
      (a === 'functions' && /^(deploy|delete)$/.test(b ?? '')) ||
      (a === 'config' && b === 'push');
    if (!hit || w.includes('--local') || flagValue(w, '--db-url') !== null) return false;
    let ref = flagValue(w, '--project-ref');
    if (ref === null) {
      const dirs = [path.resolve(cwd, flagValue(w, '--workdir') ?? '.')];
      const top = git(dirs[0], ['rev-parse', '--show-toplevel']);
      if (top) dirs.push(top);
      for (const d of dirs) {
        try { ref = fs.readFileSync(path.join(d, 'supabase', '.temp', 'project-ref'), 'utf8').trim().slice(0, 64); break; } catch { /* next */ }
      }
    }
    return !!ref && (prod.targets ?? []).includes(ref);
  },
};

/**
 * Is this tool call a production action for the project? input: { command, cwd }; prod: the brief's production
 * { remotes, branches, targets }. Returns { what: 'push'|'tag'|'release'|'cli', name, label } (label is for the refusal only),
 * or null. At most a few git calls, each with the shared helper's timeout, and only for a command that names git, gh,
 * vercel, netlify or supabase.
 */
export function prodAction(input, prod) {
  if (!prod || typeof prod !== 'object') return null;
  const command = String(input?.command ?? '');
  if (!/\b(git|gh|vercel|netlify|supabase)\b/.test(command)) return null;
  const p = { remotes: Array.isArray(prod.remotes) ? prod.remotes : [], branches: Array.isArray(prod.branches) ? prod.branches : [], targets: Array.isArray(prod.targets) ? prod.targets : [] };
  let cwd = input?.cwd || process.cwd();
  for (const words of splitCommands(command)) {
    const w = bare(words);
    if (!w.length) continue;
    const tool = w[0];
    try {
      if (tool === 'cd' && w[1] && !isDyn(w[1])) { cwd = path.resolve(cwd, w[1]); continue; }
      if (tool === 'git') {
        const r = gitPush(w, cwd, p);
        if (r) return r;
      } else if (tool === 'gh') {
        const r = ghRelease(w, cwd, p);
        if (r) return r;
      } else if (PROD_CLI[tool] && !w.slice(1).some(isDyn) && (p.targets.length || tool !== 'supabase')) {
        if (PROD_CLI[tool](w, cwd, p)) return { what: 'cli', name: tool, label: `command (${tool} on production)` };
      }
    } catch { /* anything unexpected passes */ }
  }
  return null;
}

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason.slice(0, 600) } });

/**
 * The refusal, naming what to do. `answer` is the grant route's JSON answer ({ allowed: false, open?, owner? }), or one of
 * 'no-token', 'unconfirmed' (the route was unreachable, slow, refused or erroring).
 */
export function releaseDeny(action, answer, project) {
  const what = `Production ${action.label}`;
  if (answer === 'no-token') return deny(`${what} needs an answered release Need, and this session has no Work OS session token: push from a PC with the worker, or the person does it.`);
  if (answer === 'unconfirmed') return deny(`${what}: Work OS could not confirm a release Need. Try again, or the person does it.`);
  if (answer && typeof answer.open === 'number') return deny(`${what} waits for release Need #${answer.open}, which is open: wait for its answer (it comes to this session), then try again.`);
  const owner = answer && typeof answer.owner === 'string' && answer.owner ? ` It goes to ${answer.owner.slice(0, 40)}.` : '';
  const proj = String(project || 'this project').replace(/["\\\n]/g, '').slice(0, 60);
  return deny(`${what} needs an answered release Need. Call ask {project: "${proj}", kind: "approve", release: true, ask: "Release ${action.what === 'cli' ? action.name : action.name}"}.${owner} The answer comes to this session; then try again.`);
}
