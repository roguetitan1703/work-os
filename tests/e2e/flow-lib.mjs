// Helpers shared by the flow-* suites (docs/flows/step-1.md "Tests"). Kept apart from lib.mjs so slices that add flow
// suites do not edit the same file.
import { B, rawDb } from './lib.mjs';

let rid = 0;
/** An MCP tool call as `key`, with optional extra headers (X-Work-OS-Session). { isError, text, json }. */
export async function mcpH(key, name, args = {}, headers = {}) {
  const r = await fetch(B + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}`, ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }) });
  const t = await r.text();
  const line = t.split('\n').find(l => l.startsWith('data:'));
  let b;
  try { b = JSON.parse(line ? line.slice(5) : t); } catch { return { isError: true, text: t, json: null }; }
  const text = b.result?.content?.[0]?.text ?? JSON.stringify(b.error ?? b);
  let json = null;
  try { json = JSON.parse(text); } catch { /* error text */ }
  return { isError: !!b.result?.isError || !!b.error || r.status >= 400, text, json };
}
/** Like mcpH but throws on an error answer and returns the parsed JSON. */
export async function must(key, name, args = {}, headers = {}) {
  const r = await mcpH(key, name, args, headers);
  if (r.isError) throw new Error(`${name}: ${r.text.slice(0, 400)}`);
  return r.json;
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Removes everything a flow suite creates (it runs on an emptied database, but the owner and key stay). */
export async function clean() {
  for (const c of ['states', 'presence', 'policyEvents']) await rawDb.collection(c).deleteMany({});
}
/** Marks a note as a layer of Orders directly (the app does it through setOrders; there is no MCP tool for it). */
export const markOrders = async (noteId, layer, by) => rawDb.collection('notes').updateOne({ _id: noteId }, { $set: { orders: layer, ordersBy: by ?? (await rawDb.collection('notes').findOne({ _id: noteId })).ownerId } });
