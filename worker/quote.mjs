// POSIX single-quote escaping: every value wrapped in '...', embedded ' becomes '\''
export function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
// Escape for use inside an AppleScript "..." string literal.
export function asEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
export function macScript(folder, claudePath, args, dispatched = null) {
  const env = Number.isInteger(dispatched) && dispatched > 0 ? `WORK_OS_DISPATCHED=${dispatched} ` : '';
  return `cd ${shQuote(folder)} && ${env}${shQuote(claudePath)} ${args.map(shQuote).join(' ')}`;
}
