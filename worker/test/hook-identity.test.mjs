// Identity step 4: transcriptMeta reads the rename, Claude's title and the model from the end of a transcript; toolOf maps the entrypoint.
// Every value below is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcriptMeta, toolOf, identityOf, identityKey, META_BYTES } from '../hook-identity.mjs';

const rec = (o) => JSON.stringify(o) + '\n';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-ident-'));
let n = 0;
const file = (...records) => { const f = path.join(dir, `t${++n}.jsonl`); fs.writeFileSync(f, records.join('')); return f; };
const asst = (model, text = 'made-up reply') => rec({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text }] } });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the latest custom-title, ai-title and assistant model win', () => {
  const f = file(rec({ type: 'ai-title', aiTitle: 'First made-up guess' }), asst('model-a'), rec({ type: 'custom-title', customTitle: 'Made-up name', sessionId: 'x' }), rec({ type: 'ai-title', aiTitle: 'Second made-up guess' }), asst('model-b'), rec({ type: 'custom-title', customTitle: 'Renamed again' }));
  assert.deepEqual(transcriptMeta(f), { title: 'Renamed again', aiTitle: 'Second made-up guess', model: 'model-b' });
});

test('titles are one line and at most 120 characters; control characters go', () => {
  const f = file(rec({ type: 'custom-title', customTitle: 'Line one\nline two\u0007 ' + 'x'.repeat(300) }));
  const t = transcriptMeta(f).title;
  assert.ok(t.length === 120 && !/[\n\u0007]/.test(t) && t.startsWith('Line one line two'));
});

test('a synthetic model and a model with odd characters are not taken; an empty rename clears the title', () => {
  assert.deepEqual(transcriptMeta(file(asst('model-a'), asst('<synthetic>'))), { model: 'model-a' });
  assert.deepEqual(transcriptMeta(file(asst('bad model; rm -rf'))), {});
  assert.deepEqual(transcriptMeta(file(rec({ type: 'custom-title', customTitle: 'Named' }), rec({ type: 'custom-title', customTitle: '  ' }))), {});
});

test('only the end of a big transcript is read; a title far back is not found', () => {
  const big = rec({ type: 'user', message: { content: 'x'.repeat(2000) } }).repeat(Math.ceil((META_BYTES * 2) / 2000));
  const f = file(rec({ type: 'custom-title', customTitle: 'Far back' }), big, rec({ type: 'ai-title', aiTitle: 'Near the end' }));
  assert.deepEqual(transcriptMeta(f), { aiTitle: 'Near the end' });
});

test('nothing breaks on a missing file, a non-transcript path or garbage lines', () => {
  assert.deepEqual(transcriptMeta(path.join(dir, 'nope.jsonl')), {});
  assert.deepEqual(transcriptMeta(path.join(dir, 'x.txt')), {});
  assert.deepEqual(transcriptMeta(undefined), {});
  assert.deepEqual(transcriptMeta(file('{"type":"custom-title","customTitle":\n', 'not json at all but has "ai-title" and "aiTitle"\n')), {});
});

test('the tool comes from the entrypoint: desktop, vscode, terminal; sdk and unknown send none', () => {
  assert.equal(toolOf({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }), 'desktop');
  assert.equal(toolOf({ CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }), 'vscode');
  assert.equal(toolOf({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), 'terminal');
  assert.equal(toolOf({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), undefined);
  assert.equal(toolOf({}), undefined);
});

test('identityOf joins the transcript and the tool; identityKey changes only with title, ai title or model', () => {
  const f = file(rec({ type: 'custom-title', customTitle: 'A' }), asst('m1'));
  const i = identityOf(f, { CLAUDE_CODE_ENTRYPOINT: 'cli' }, path.join(dir, 'no-such-claude.json')); // a fixture: never the real account file
  assert.deepEqual(i, { title: 'A', model: 'm1', tool: 'terminal' });
  assert.equal(identityKey(i), identityKey({ ...i, tool: 'vscode' }));
  assert.notEqual(identityKey(i), identityKey({ ...i, model: 'm2' }));
});

test('identityOf: the account label from the account file (the part before @), never the uuid, id or email; no file, no account', () => {
  const f = file(rec({ type: 'custom-title', customTitle: 'A' }), asst('m1'));
  const acct = path.join(dir, 'claude-account.json');
  const UUID = 'aaaaaaaa-0000-4000-8000-123456789abc';
  fs.writeFileSync(acct, JSON.stringify({ oauthAccount: { accountUuid: UUID, emailAddress: 'pat@example.com' } }));
  const i = identityOf(f, {}, acct);
  assert.equal(i.account, 'pat');
  const json = JSON.stringify(i);
  assert.ok(!json.includes(UUID) && !json.includes('example.com') && !json.includes('@'));
  assert.equal(identityKey(i), identityKey({ ...i, account: 'other' })); // an account never makes an event carry the identity again
  assert.ok(!('account' in identityOf(f, {}, path.join(dir, 'missing.json'))));
  fs.writeFileSync(acct, JSON.stringify({ oauthAccount: { accountUuid: UUID, emailAddress: '@example.com' } }));
  assert.ok(!('account' in identityOf(f, {}, acct)), 'an empty label sends nothing');
});
