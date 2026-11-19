// H9 hook side: Orders versions. The version in the brief's Orders heading, the "Orders changed" section right after the
// Orders, and (later steps) the delivery of changes and the subagent short form. No server: formatBrief gets a brief as data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hook-h9-'));
process.env.WORK_OS_HOOK_DIR = path.join(tmp, 'markers');
process.env.WORK_OS_WORKER_DIR = path.join(tmp, 'cfg');
delete process.env.WORK_OS_KEY;
delete process.env.WORK_OS_URL;
const { formatBrief } = await import('../hook.mjs');

const base = { project: { id: 'p1', name: 'Demo' }, session: 's-1', state: { now: { text: 'x' } }, stateVersion: 2 };

test('formatBrief: the Orders heading carries the page version', () => {
  const b = formatBrief({ ...base, orders: [{ layer: 'organisation', title: 'Delpat Orders', version: 14, text: 'Rule one.' }, { layer: 'project', title: 'P rules', version: 1, text: 'Two.', writtenBy: 'Akash' }] });
  assert.match(b, /## Orders \(organisation: Delpat Orders, v14\)\nRule one\./);
  assert.match(b, /## Orders \(project: P rules, v1, writtenBy Akash\)/);
  const old = formatBrief({ ...base, orders: [{ layer: 'organisation', title: 'Delpat Orders', text: 'Rule one.' }] });
  assert.match(old, /## Orders \(organisation: Delpat Orders\)\n/, 'an older server sends no version: the heading stays as it was');
});

test('formatBrief: "Orders changed" sits right after the Orders, with who, why and the lines out and in', () => {
  const b = formatBrief({
    ...base,
    orders: [{ layer: 'organisation', title: 'Delpat Orders', version: 14, text: 'Rule one.' }],
    ordersChanged: [
      { layer: 'organisation', title: 'Delpat Orders', version: 14, at: new Date(2026, 10, 19, 10, 42).toISOString(), by: 'me', session: 'Work OS · lead', why: 'Om 19 Nov: merging to dev needs no ask', removed: ['Ask Om before merging'], added: ['Merge to dev without asking'], noteId: 'n1', own: true },
      { layer: 'project', title: 'P rules', version: 3, at: new Date().toISOString(), by: 'claude', removed: [], added: ['A line'], noteId: 'n2', writtenBy: 'Akash' },
    ],
  });
  assert.ok(b.indexOf('## Orders (') < b.indexOf('## Orders changed') && b.indexOf('## Orders changed') < b.indexOf('## State'));
  assert.match(b, /- organisation v14 "Delpat Orders" by me \(Work OS · lead\), 10:42; why: Om 19 Nov: merging to dev needs no ask; undo in the app: Orders page, Changes\n  - Ask Om before merging\n  \+ Merge to dev without asking/);
  assert.match(b, /- project v3 "P rules" by claude.*writtenBy Akash/);
  assert.doesNotMatch(b.split('## Orders changed')[1].split('\n\n')[0].split('project v3')[1], /undo in the app/, 'no undo hint on a change that is not the holder\'s own');
  assert.match(b, /These are your rules from now on\./);
});

test('formatBrief: no section without changes, and it stays inside 1,200 characters', () => {
  assert.doesNotMatch(formatBrief({ ...base, orders: 'no Orders set' }), /Orders changed/);
  const many = Array.from({ length: 5 }, (_, i) => ({ layer: 'organisation', title: 'T', version: 20 + i, at: new Date().toISOString(), by: 'claude', removed: Array.from({ length: 6 }, (_, j) => 'r'.repeat(190) + j), added: Array.from({ length: 6 }, (_, j) => 'a'.repeat(190) + j), noteId: 'n' }));
  const b = formatBrief({ ...base, orders: [{ layer: 'organisation', title: 'T', version: 24, text: 'x' }], ordersChanged: many });
  const sec = b.split('## Orders changed\n')[1].split('\n\n')[0];
  assert.ok(sec.length <= 1200 + 60, `section is ${sec.length}`);
});
