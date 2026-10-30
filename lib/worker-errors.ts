// What a worker says when a job fails, in words for a person who is not a developer. Applied wherever a failed
// session or job is shown; an unknown message is shown as it is. Safe for client and server code.
const PLAIN: [string, string][] = [
  ['claude not found on PATH outside the allowed roots', "Claude Code isn't installed on this PC (or not on PATH)"],
  ['folder not linked to a project', 'Link this folder to a project first'],
  ['folder outside allowed roots', 'That folder is outside the folders this PC lets Work OS use'],
  ['unknown folder', "This PC doesn't know that folder yet; it learns folders at its next scan"],
  ['session not found on this computer', "Claude Code's history for that session isn't on this PC"],
  ['session folder unknown', "Can't tell which folder that session belongs to"],
  ['session not running', "That session isn't running"],
  ['unknown session', 'This PC has no record of that session'],
  ['VS Code not found in its standard install folders', "VS Code isn't installed in its usual place on this PC"],
  ['VS Code not found', "VS Code isn't installed in its usual place on this PC"],
  ['Opening in VS Code is not available on this computer', "This PC's worker is too old to open VS Code; update it"],
  ['unknown job kind', "This PC's worker is too old for that; update it"],
  ['bad session id', "That isn't a valid session"],
];
export function friendlyError(msg: string | undefined | null): string | undefined {
  if (!msg) return undefined;
  let out = msg;
  for (const [from, to] of PLAIN) out = out.split(from).join(to);
  return out;
}
