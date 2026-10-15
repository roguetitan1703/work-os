// Normalise a git remote URL to lowercase host/owner/name, no credentials, no .git.
export function normalizeRemote(url) {
  if (typeof url !== 'string') return null;
  const s = url.trim();
  if (!s) return null;
  let host, rest;
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]*)\/?(.*)$/i);
  if (m) {
    host = m[1];
    rest = m[2];
    host = host.slice(host.lastIndexOf('@') + 1); // strip user:token@
    host = host.replace(/:\d*$/, ''); // strip port
  } else {
    // scp-like: [user@]host:owner/name
    const sm = s.match(/^(?:[^@/]*@)?([^:/]+):(.*)$/);
    if (!sm) return null;
    host = sm[1];
    rest = sm[2];
  }
  rest = rest.replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!host || !rest) return null;
  const out = `${host}/${rest}`.toLowerCase();
  if (out.includes('@') || out.length > 200) return null;
  return out;
}
