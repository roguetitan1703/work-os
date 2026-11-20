// Identity step 4: a session's name, model and tool from the hook (protocol 3). POST /api/agent/start takes title, aiTitle, tool and
// model; POST /api/agent/event takes identity { title?, aiTitle?, model?, account? } on a prompt or a stop. The label order is the session's own
// name -> start_work's label -> Claude's title -> "<project> · Claude Code"; of the two explicit ones the last written wins; Claude's
// title only fills where nothing explicit is set; an old hook's plain "Claude Code" is no name; a dispatched session keeps its forced
// label; titles are one line of at most 120 characters; the roster shows the name, model and tool. Seed profile: none.
import { randomUUID } from 'node:crypto';
import { B, MCP, ME, check, finish, mkDevice, mkKey, rawDb } from './lib.mjs';
import { must, mcpH } from './flow-lib.mjs';

const call = async (url, cred, body = {}, headers = {}) => {
  const r = await fetch(B + url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', 'x-work-os-hook': '3', ...(cred ? { authorization: `Bearer ${cred}` } : {}), ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json };
};

try {
  const P = 'Ident One';
  const ONE = (await must(MCP, 'add_project', { name: P, code: [{ remote: 'acme/ident-one' }] })).project.id;
  const pc = await mkDevice('ident-pc');
  await rawDb.collection('devices').updateOne({ _id: pc.id }, { $set: { ownerId: ME.userId, orgId: ME.orgId, name: 'Ident-PC' } });
  await rawDb.collection('workerFolders').insertOne({ _id: `${pc.id}:fold1`, deviceId: pc.id, folderId: 'fold1', name: 'C:/code/f1', git: true, remote: 'acme/ident-one', projectId: ONE, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: ME.orgId, ownerId: ME.userId });
  const base = { folders: ['fold1'], remote: 'https://github.com/acme/ident-one.git', branch: 'main', path: 'C:/code/f1' };
  const start = async extra => {
    const r = await call('/api/agent/start', pc.key, { ...base, ccSession: randomUUID(), source: 'startup', ...extra });
    if (r.status !== 200) throw new Error(`start ${r.status} ${r.text.slice(0, 200)}`);
    return { token: r.json.token, sid: r.json.brief.session };
  };
  const row = sid => rawDb.collection('presence').findOne({ _id: `${ME.userId}:s:${sid}:${ONE}` });
  const ev = (S, event, identity) => call('/api/agent/event', S.token, { event, ...(identity ? { identity } : {}) });

  // the start
  const A = await start({ title: 'Made up rename', aiTitle: 'Made up AI guess', tool: 'vscode', model: 'model-x' });
  let r = await row(A.sid);
  check('start: the session\'s own name is the label (beats Claude\'s title); tool and model are kept', r.label === 'Made up rename' && r.labelSource === 'title' && r.tool === 'vscode' && r.model === 'model-x' && r.hook === 3, JSON.stringify([r.label, r.labelSource, r.tool, r.model, r.hook]));
  const B2 = await start({ aiTitle: 'Only an AI guess' });
  r = await row(B2.sid);
  check('start: with only Claude\'s title, that is the label (source ai)', r.label === 'Only an AI guess' && r.labelSource === 'ai', JSON.stringify([r.label, r.labelSource]));
  const C = await start({});
  r = await row(C.sid);
  check('start: with no name at all the label is "<project> · Claude Code", never just "Claude Code"', r.label === `${P} · Claude Code` && r.labelSource === 'fallback', JSON.stringify([r.label, r.labelSource]));
  const Old = await start({ label: 'Claude Code' });
  r = await row(Old.sid);
  check('start: an old hook\'s plain "Claude Code" label is ignored', r.label === `${P} · Claude Code` && r.labelSource === 'fallback', JSON.stringify([r.label, r.labelSource]));
  const Odd = await start({ title: '  Line one\nline two\u0007 ' + 'x'.repeat(250) });
  r = await row(Odd.sid);
  check('start: a name is one line of at most 120 characters', r.label.length === 120 && !/[\n\u0007]/.test(r.label) && r.label.startsWith('Line one line two'), JSON.stringify(r.label));
  const badTool = await call('/api/agent/start', pc.key, { ...base, tool: 'toaster' });
  check('start: a tool that is not desktop, vscode or terminal is a 400', badTool.status === 400, `${badTool.status}`);

  // events
  const e1 = await ev(A, 'prompt', { title: 'Renamed in the app' });
  r = await row(A.sid);
  check('event: a rename changes the label (last written wins)', e1.status === 200 && r.label === 'Renamed in the app' && r.labelSource === 'title');
  await ev(A, 'stop', { aiTitle: 'A newer AI guess' });
  r = await row(A.sid);
  check('event: Claude\'s title does not replace the session\'s own name', r.label === 'Renamed in the app');
  await ev(B2, 'stop', { aiTitle: 'A newer AI guess for B' });
  r = await row(B2.sid);
  check('event: Claude\'s title replaces an earlier Claude title', r.label === 'A newer AI guess for B' && r.labelSource === 'ai');
  await ev(C, 'stop', { aiTitle: 'AI title for a session that had the fallback' });
  r = await row(C.sid);
  check('event: Claude\'s title replaces the fallback', r.label === 'AI title for a session that had the fallback');
  await ev(A, 'prompt', { model: 'model-y' });
  r = await row(A.sid);
  check('event: the model follows the latest assistant message', r.model === 'model-y');
  const tooBig = await call('/api/agent/event', A.token, { event: 'tool', identity: { title: 'x' } });
  check('event: identity belongs to a prompt or a stop (a tool event with it is a 400)', tooBig.status === 400, `${tooBig.status}`);
  const extra = await call('/api/agent/event', A.token, { event: 'prompt', identity: { title: 'x', secret: 'y' } });
  check('event: identity takes nothing but title, aiTitle, model and account', extra.status === 400, `${extra.status}`);
  // the account label follows a login switch mid-session (hooks review M9); one that looks like an email or a key is dropped
  await ev(A, 'prompt', { account: 'second' });
  r = await row(A.sid);
  check('event: the account label follows the session (a login switch)', r.account === 'second', JSON.stringify(r.account));
  const badAcct = await ev(A, 'stop', { account: 'pat@example.com' });
  r = await row(A.sid);
  check('event: an account that looks like an email is dropped, the event still accepted', badAcct.status === 200 && r.account === 'second', `${badAcct.status} ${r.account}`);

  // start_work (the agent's own label) and the rename: the last written wins
  const agent = await mkKey({ agent: 'claude-code', name: 'ident agent' });
  const sw = await mcpH(agent, 'start_work', { project: P, label: 'agent chose this' }, { 'X-Work-OS-Session': A.sid });
  r = await row(A.sid);
  check('start_work\'s label overwrites an earlier name (last written wins)', !sw.isError && r.label === 'agent chose this' && r.labelSource === 'label', `${sw.text.slice(0, 100)} ${r.label}`);
  await ev(A, 'prompt', { aiTitle: 'AI again' });
  r = await row(A.sid);
  check('…and Claude\'s title does not take it back', r.label === 'agent chose this');
  await ev(A, 'stop', { title: 'Renamed after that' });
  r = await row(A.sid);
  check('…but a later rename does', r.label === 'Renamed after that' && r.labelSource === 'title');

  // a dispatched session keeps its forced label
  const ccD = randomUUID();
  await must(MCP, 'add_task', { project: P, title: 'Ident dispatched task' });
  const taskId = (await rawDb.collection('tasks').findOne({ title: 'Ident dispatched task' }))._id;
  await rawDb.collection('workerSessions').insertOne({ _id: ccD, orgId: ME.orgId, ownerId: ME.userId, deviceId: pc.id, folderId: 'fold1', projectId: ONE, state: 'running', startedAt: new Date(), updatedAt: new Date(), dispatched: true, taskId });
  const D = await start({ ccSession: ccD, title: 'A name the person typed' });
  r = await row(D.sid);
  const forced = r.label;
  check('dispatched: the forced label is kept over the session\'s own name', /worker · #\d+$/.test(forced) && r.labelSource === 'forced', JSON.stringify([r.label, r.labelSource]));
  await ev(D, 'prompt', { title: 'Another name' });
  await mcpH(agent, 'start_work', { project: P, label: 'agent label' }, { 'X-Work-OS-Session': D.sid });
  r = await row(D.sid);
  check('dispatched: events and start_work do not change it', r.label === forced);

  // the roster shows them
  const list = await must(MCP, 'list_sessions', { project: P });
  const mine = list.sessions.find(x => x.session === A.sid);
  check('list_sessions names the session by its name and shows its model', mine?.name === 'Renamed after that' && JSON.stringify(mine).includes('model-y'), JSON.stringify(mine));
} catch (e) {
  check('hook-identity (error)', false, e?.stack || String(e));
}
await finish();
