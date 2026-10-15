// POSIX single-quote escaping: every value wrapped in '...', embedded ' becomes '\''
export function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
// Escape for use inside an AppleScript "..." string literal.
export function asEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
export function macScript(folder, claudePath, args) {
  return `cd ${shQuote(folder)} && ${shQuote(claudePath)} ${args.map(shQuote).join(' ')}`;
}
