// The Claude account this computer is signed in to, read from ~/.claude.json (read only: never written, never kept).
// Only a hash id and the email's part before @ come out; the uuid and the full email never do. Used by usage.mjs (usage per
// account) and hook-identity.mjs (the account label of a session). Hooks copy this file with the others (hooks-install.mjs FILES).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const oneLine = (s, n) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);

export const hashAccount = (uuid) => crypto.createHash('sha256').update('work-os-acct:' + uuid).digest('hex').slice(0, 16);

/** The Claude account this computer is signed in to: { id, label } (id a hash, label the email's part before @), or null. Read only. */
export function readAccount(file = path.join(os.homedir(), '.claude.json')) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const a = j && j.oauthAccount;
    if (!a || typeof a.accountUuid !== 'string' || !a.accountUuid) return null;
    const mail = typeof a.emailAddress === 'string' ? a.emailAddress : '';
    return { id: hashAccount(a.accountUuid), label: oneLine(mail.split('@')[0], 40) };
  } catch { return null; }
}
