// Run keys, the worker side (docs/dispatcher.md "Run keys"): a dispatched run never gets its person's own Work OS credential. It runs
// with a strict MCP config holding only its own run key, a settings file that blanks WORK_OS_KEY in the settings env block, and an
// environment with the key removed; both files go when claude ends, and a dispatched run without a run key is never started.
// Keys here are generated test values; nothing prints one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as run from '../dispatch-run.mjs';
import { claudeArgs, launch, windowsWtArgs } from '../launch.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-run-key-'));
const dir = path.join(tmp, run.RUN_DIR_NAME);
const home = path.join(tmp, 'home');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
const tok = (p) => p + '_' + randomBytes(32).toString('base64url');
const runKey = tok('wdr');
const personKey = tok('wos');
const BASE = 'https://work.example.test';
// The person's own setup: Work OS through OAuth (no header), another Work OS entry with their key, a server on the Work OS host,
// and an unrelated server that stays.
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {
  'work-os': { type: 'http', url: BASE + '/api/mcp' },
  wos2: { type: 'http', url: 'https://elsewhere.example.test/mcp', headers: { Authorization: 'Bearer ' + personKey } },
  same: { type: 'http', url: BASE + '/other' },
  envkey: { command: 'node', args: ['x.mjs'], env: { WORK_OS_KEY: personKey } },
  tools: { command: 'npx', args: ['some-mcp'] },
} }));
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { WORK_OS_KEY: personKey, OTHER_TOKEN: tok('wkr'), TEMP: 'D:/t' } }));

test('scrubEnv drops WORK_OS_KEY and any variable holding a Work OS credential, keeps the rest', () => {
  const e = run.scrubEnv({ WORK_OS_KEY: personKey, work_os_key: 'x', AUTH: 'Bearer ' + tok('wosat'), DEV: tok('wkr'), SESS: tok('wst'), PATH: '/usr/bin', HOME: '/h', NOTE: 'wos_ is a prefix' });
  assert.deepEqual(Object.keys(e).sort(), ['HOME', 'NOTE', 'PATH']);
});

test('runSettings blanks WORK_OS_KEY and any settings env value holding a Work OS credential, nothing else', () => {
  assert.deepEqual(run.runSettings(home), { env: { WORK_OS_KEY: '', OTHER_TOKEN: '' } });
  assert.deepEqual(run.runSettings(path.join(tmp, 'nohome')), { env: { WORK_OS_KEY: '' } });
});

test('writeRunFiles: Work OS with the run key only, the other servers without any Work OS entry or credential, and the settings', () => {
  const sid = randomUUID();
  const f = run.writeRunFiles({ sessionId: sid, baseUrl: BASE + '/', key: runKey, dir, home });
  assert.equal(f.mcpConfig, path.join(dir, `run-${sid}.json`));
  assert.equal(f.settings, path.join(dir, `run-${sid}.settings.json`));
  const cfg = JSON.parse(fs.readFileSync(f.mcpConfig, 'utf8'));
  assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ['tools', 'work-os']);
  assert.deepEqual(cfg.mcpServers['work-os'], { type: 'http', url: BASE + '/api/mcp', headers: { Authorization: 'Bearer ' + runKey } });
  assert.ok(!fs.readFileSync(f.mcpConfig, 'utf8').includes(personKey), "the person's key is nowhere in the run's config");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.settings, 'utf8')), { env: { WORK_OS_KEY: '', OTHER_TOKEN: '' } });
  assert.throws(() => run.writeRunFiles({ sessionId: sid, baseUrl: BASE, key: personKey, dir, home }), /bad run key/);
  assert.throws(() => run.writeRunFiles({ sessionId: '../x', baseUrl: BASE, key: runKey, dir, home }), /bad session id/);
});

test('claudeArgs: a dispatched run uses its strict config and its settings; an ordinary start is unchanged', () => {
  const sid = randomUUID();
  const a = claudeArgs({ kind: 'start', sessionId: sid, projectName: 'P', prompt: 'go', mcpConfig: 'C:/demo.json', runFiles: { mcpConfig: 'C:/t/work-os-run/r.json', settings: 'C:/t/work-os-run/r.settings.json' } });
  assert.deepEqual(a.slice(0, 7), ['--session-id', sid, '--strict-mcp-config', '--mcp-config', 'C:/t/work-os-run/r.json', '--settings', 'C:/t/work-os-run/r.settings.json']);
  assert.equal(a.at(-1), 'go');
  const plain = claudeArgs({ kind: 'start', sessionId: sid, projectName: 'P' });
  assert.ok(!plain.includes('--strict-mcp-config') && !plain.includes('--settings'));
});

test('launch: a dispatched run without a run key is never started; with one it starts on its own files, which go if the start fails', { skip: process.platform !== 'win32' && 'Windows path' }, async () => {
  const spawned = [];
  const spawn = async (cmd, args) => { spawned.push([cmd, args]); };
  const sid = randomUUID();
  const base = { kind: 'start', folder: tmp, sessionId: sid, projectName: 'P', claudePath: 'C:/claude.exe', dispatched: 12 };
  await assert.rejects(launch(base, { spawn, runDir: dir, home }), /needs its own Work OS key/);
  assert.equal(spawned.length, 0);
  await launch({ ...base, run: { key: runKey }, baseUrl: BASE }, { spawn, runDir: dir, home });
  const args = spawned[0][1];
  assert.equal(spawned[0][0], 'wt.exe');
  assert.ok(args.includes('--work-os-dispatched=12'));
  assert.equal(args[args.indexOf('--mcp-config') + 1], path.join(dir, `run-${sid}.json`));
  assert.equal(args[args.indexOf('--settings') + 1], path.join(dir, `run-${sid}.settings.json`));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.some((x) => x.includes(runKey)), 'the key is in the file, never on the command line');
  assert.ok(fs.existsSync(path.join(dir, `run-${sid}.json`)));
  const sid2 = randomUUID();
  const boom = async () => { throw new Error('boom'); };
  await assert.rejects(launch({ ...base, sessionId: sid2, run: { key: runKey }, baseUrl: BASE }, { spawn: boom, runDir: dir, home }), /boom/);
  assert.ok(!fs.existsSync(path.join(dir, `run-${sid2}.json`)) && !fs.existsSync(path.join(dir, `run-${sid2}.settings.json`)));
  // an ordinary start writes no run files and passes no settings
  await launch({ ...base, dispatched: undefined, sessionId: randomUUID() }, { spawn, runDir: dir, home });
  assert.ok(!spawned[1][1].includes('--settings') && !spawned[1][1].includes('--strict-mcp-config'));
});

test('the wrapper: a dispatched run gets no WORK_OS_KEY or credential variable, and its run files are deleted when claude ends', () => {
  const sid = randomUUID();
  const f = run.writeRunFiles({ sessionId: sid, baseUrl: BASE, key: runKey, dir, home });
  const wrapper = fileURLToPath(new URL('../run-claude.mjs', import.meta.url));
  const probe = path.join(tmp, 'probe.mjs');
  fs.writeFileSync(probe, 'console.log("K=" + (process.env.WORK_OS_KEY === undefined ? "none" : "set") + " T=" + (process.env.SOME_TOKEN === undefined ? "none" : "set") + " P=" + (process.env.KEEP_ME || "") + " D=" + (process.env.WORK_OS_DISPATCHED || "none"));');
  const env = { ...process.env, WORK_OS_KEY: personKey, SOME_TOKEN: tok('wos'), KEEP_ME: 'yes' };
  // claudePath is node here and the probe script its first argument; the run files ride after it as they do on a claude command line
  const out = spawnSync(process.execPath, [wrapper, '--work-os-dispatched=12', process.execPath, probe, '--mcp-config', f.mcpConfig, '--settings', f.settings], { env, encoding: 'utf8' }).stdout;
  assert.match(out, /K=none T=none P=yes D=12/);
  assert.ok(!fs.existsSync(f.mcpConfig) && !fs.existsSync(f.settings), 'both run files are gone');
  // an ordinary run keeps its environment (the person's own session) and touches no file
  const g = run.writeRunFiles({ sessionId: randomUUID(), baseUrl: BASE, key: runKey, dir, home });
  const out2 = spawnSync(process.execPath, [wrapper, process.execPath, probe, '--mcp-config', g.mcpConfig], { env, encoding: 'utf8' }).stdout;
  assert.match(out2, /K=set T=set P=yes D=none/);
  assert.ok(fs.existsSync(g.mcpConfig));
  // a path that is not a run file is never deleted
  const other = path.join(tmp, 'keep.json');
  fs.writeFileSync(other, '{}');
  spawnSync(process.execPath, [wrapper, '--work-os-dispatched=12', process.execPath, probe, '--mcp-config', other], { env, encoding: 'utf8' });
  assert.ok(fs.existsSync(other));
  assert.equal(run.removeRunConfig(other), false);
});

test('sweepRunConfigs removes the run files of sessions that no longer run, never a young file or a running one', () => {
  const d = path.join(tmp, 'sweep', run.RUN_DIR_NAME);
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
  for (const s of [a, b, c]) run.writeRunFiles({ sessionId: s, baseUrl: BASE, key: runKey, dir: d, home });
  fs.writeFileSync(path.join(d, 'other.json'), '{}');
  const later = Date.now() + 10 * 60_000;
  assert.equal(run.sweepRunConfigs(new Set([a]), d, { now: Date.now() }), 0, 'young files stay');
  assert.equal(run.sweepRunConfigs(new Set([a]), d, { now: later }), 4);
  assert.deepEqual(fs.readdirSync(d).sort(), ['other.json', `run-${a}.json`, `run-${a}.settings.json`].sort());
  void c;
});

test('runFor: asks the server for the run key of a dispatched start or resume; without one the run is not started', async () => {
  const sid = randomUUID();
  const asked = [];
  const api = { runKey: async (s) => (asked.push(s), { key: runKey }) };
  assert.equal(await run.runFor({ sessionId: sid }, api), null);
  assert.deepEqual(await run.runFor({ sessionId: sid.toUpperCase(), dispatched: 7 }, api), { key: runKey });
  assert.deepEqual(asked, [sid]);
  await assert.rejects(run.runFor({ sessionId: sid, dispatched: 7 }, { runKey: async () => { throw new Error('HTTP 400: not a dispatched session of this computer'); } }), /no run key .*not started/);
  await assert.rejects(run.runFor({ sessionId: sid, dispatched: 7 }, { runKey: async () => ({ key: personKey }) }), /no run key/);
});

test('the wt command line carries the strict config and the settings through to the wrapper unchanged', () => {
  const cargs = claudeArgs({ kind: 'resume', sessionId: randomUUID(), projectName: 'P', runFiles: { mcpConfig: 'C:/t/work-os-run/a.json', settings: 'C:/t/work-os-run/a.settings.json' } });
  const w = windowsWtArgs('C:/f', 'T', 'C:/claude.exe', cargs, 'node', 'wrap.mjs', 3);
  assert.deepEqual(w.slice(w.indexOf('wrap.mjs'), w.indexOf('wrap.mjs') + 3), ['wrap.mjs', '--work-os-dispatched=3', 'C:/claude.exe']);
  assert.ok(w.includes('--strict-mcp-config') && w.includes('C:/t/work-os-run/a.settings.json'));
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
