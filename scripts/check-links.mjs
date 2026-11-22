// Checks relative links (and #anchors) in docs/**/*.md, AGENTS.md and CLAUDE.md, and that every docs/... .md path
// named in them exists. Links inside code fences are ignored.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith('.md')) files.push(p);
  }
})(path.join(root, 'docs'));
files.push(path.join(root, 'AGENTS.md'), path.join(root, 'CLAUDE.md'));

const slug = s => s.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s/g, '-');
let bad = 0, n = 0;
for (const f of files) {
  const rel = path.relative(root, f);
  const txt = fs.readFileSync(f, 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const m of txt.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const t = m[1];
    if (/^(https?:|mailto:|#$|\/)/.test(t)) continue;
    n++;
    const [p, anchor] = t.split('#');
    const target = p ? path.resolve(path.dirname(f), decodeURIComponent(p)) : f;
    if (!fs.existsSync(target)) { bad++; console.log('MISSING', rel, t); continue; }
    if (anchor && target.endsWith('.md')) {
      const heads = [...fs.readFileSync(target, 'utf8').matchAll(/^#+\s+(.*)$/gm)].map(h => slug(h[1]));
      if (!heads.includes(anchor.toLowerCase())) { bad++; console.log('ANCHOR', rel, t); }
    }
  }
  for (const m of txt.matchAll(/\bdocs\/[\w./-]+\.md\b/g)) {
    n++;
    if (!fs.existsSync(path.join(root, m[0]))) { bad++; console.log('MISSING', rel, m[0]); }
  }
}
console.log(`checked ${n} links in ${files.length} files, ${bad} bad`);
process.exit(bad ? 1 : 0);
