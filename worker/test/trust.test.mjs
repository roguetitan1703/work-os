import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-trust-'));
const FILE = path.join(dirTmp, 'claude.json');
process.env.WORK_OS_CLAUDE_JSON = FILE;
const { trustFolder, trustKey } = await import('../trust.mjs');

const D = process.platform === 'win32' ? 'D:\\Work\\proj one' : '/work/proj one';
const K = trustKey(D);
const put = (o) => fs.writeFileSync(FILE, typeof o === 'string' ? o : JSON.stringify(o, null, 2));
const get = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

test('sets the flag on a new entry, others untouched, 2-space JSON', () => {
  const base = { numStartups: 3, theme: 'x', projects: { '/other': { hasTrustDialogAccepted: false, foo: [1] } } };
  put(base);
  assert.equal(trustFolder(D), 'set');
  const out = get();
  assert.deepEqual(out.projects[K], { hasTrustDialogAccepted: true });
  assert.deepEqual(out.projects['/other'], base.projects['/other']);
  assert.equal(out.numStartups, 3);
  assert.equal(out.theme, 'x');
  assert.equal(fs.readFileSync(FILE, 'utf8'), JSON.stringify(out, null, 2));
  assert.deepEqual(fs.readdirSync(dirTmp), ['claude.json']);
});

test('keeps other keys of an existing entry', () => {
  put({ projects: { [K]: { allowedTools: ['a'], hasTrustDialogAccepted: false } } });
  assert.equal(trustFolder(D), 'set');
  assert.deepEqual(get().projects[K], { allowedTools: ['a'], hasTrustDialogAccepted: true });
});

test('no duplicate for slash or drive-case variant', { skip: process.platform !== 'win32' }, () => {
  put({ projects: { 'd:\\Work\\proj one': { hasTrustDialogAccepted: false } } });
  assert.equal(trustFolder(D), 'set');
  const keys = Object.keys(get().projects);
  assert.deepEqual(keys, ['d:\\Work\\proj one']);
  assert.equal(get().projects[keys[0]].hasTrustDialogAccepted, true);
  put({ projects: { 'd:/Work/proj one': {} } });
  trustFolder(D);
  assert.deepEqual(Object.keys(get().projects), ['d:/Work/proj one']);
});

test('invalid JSON is skipped without a write', () => {
  put('{ not json');
  assert.equal(trustFolder(D), 'skipped');
  assert.equal(fs.readFileSync(FILE, 'utf8'), '{ not json');
});

test('no write when already true', () => {
  put({ projects: { [K]: { hasTrustDialogAccepted: true } } });
  const old = new Date(2020, 1, 1);
  fs.utimesSync(FILE, old, old);
  const before = fs.statSync(FILE).mtimeMs;
  assert.equal(trustFolder(D), 'already');
  assert.equal(fs.statSync(FILE).mtimeMs, before);
});

test('trustKey format', { skip: process.platform !== 'win32' }, () => {
  assert.equal(trustKey('d:\\a\\b'), 'D:/a/b');
});

test('cleanup', () => fs.rmSync(dirTmp, { recursive: true, force: true }));
