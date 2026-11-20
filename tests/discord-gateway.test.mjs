// The Discord live listener (deploy/discord-gateway.mjs) against a fake gateway: identify, heartbeat, relaying only what the
// plan names, resume after a drop (with the session and the last sequence), a fresh identify after an invalid session, a dead
// link (no heartbeat ack) and the relay's retry. Run: node --test tests/discord-gateway.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { startGateway, serverRelay, INTENTS } from '../deploy/discord-gateway.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** A tiny WebSocket server: text frames in and out, close with a code. Each connection is handed to onConn(conn). */
function fakeGateway(onConn) {
  const server = http.createServer();
  const conns = [];
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = { url: req.url, socket, got: [], closed: false, open: true };
    const frame = (op, payload) => {
      const len = payload.length;
      const head = len < 126 ? Buffer.from([0x80 | op, len]) : Buffer.from([0x80 | op, 126, len >> 8, len & 255]);
      return Buffer.concat([head, payload]);
    };
    conn.send = o => socket.write(frame(1, Buffer.from(JSON.stringify(o))));
    conn.close = code => { socket.write(frame(8, Buffer.from([code >> 8, code & 255]))); setTimeout(() => socket.end(), 20); };
    let buf = Buffer.alloc(0);
    socket.on('data', d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 15;
        let len = buf[1] & 127;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        const masked = (buf[1] & 128) !== 0;
        if (buf.length < off + (masked ? 4 : 0) + len) return;
        const mask = masked ? buf.subarray(off, off + 4) : null;
        if (masked) off += 4;
        const payload = Buffer.from(buf.subarray(off, off + len));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buf = buf.subarray(off + len);
        if (op === 1) { const m = JSON.parse(payload.toString('utf8')); conn.got.push(m); if (m.op === 1 && !conn.noAck) conn.send({ op: 11 }); }
        if (op === 8) { conn.closed = true; try { socket.write(frame(8, payload)); socket.end(); } catch {} }
      }
    });
    socket.on('close', () => (conn.open = false));
    socket.on('error', () => {});
    conns.push(conn);
    onConn(conn, conns.length - 1);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ url: `ws://127.0.0.1:${server.address().port}`, conns, close: () => { for (const c of conns) c.socket.destroy(); server.close(); } })));
}
const until = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 20)); } return fn(); };
const hello = (conn, ms = 40) => conn.send({ op: 10, d: { heartbeat_interval: ms } });

test('identifies with the four intents, heartbeats, and relays only the named events', async () => {
  const relayed = [];
  const gw = await fakeGateway(conn => {
    hello(conn);
    setTimeout(() => {
      conn.send({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess1', resume_gateway_url: gwUrl, guilds: [{ id: '4444' }], user: { id: '999' } } });
      conn.send({ op: 0, t: 'GUILD_CREATE', s: 2, d: { id: 'x' } });
      conn.send({ op: 0, t: 'TYPING_START', s: 3, d: {} });
      conn.send({ op: 0, t: 'MESSAGE_CREATE', s: 4, d: { id: 'm1', content: 'hello' } });
      conn.send({ op: 0, t: 'MESSAGE_REACTION_ADD', s: 5, d: { message_id: 'm1', emoji: { name: 'x' } } });
      conn.send({ op: 0, t: 'MESSAGE_UPDATE', s: 6, d: { id: 'm1' } });
    }, 50);
  });
  const gwUrl = gw.url;
  const g = startGateway({ token: 'T0KEN', url: gw.url, relay: async (e, d) => (relayed.push([e, d]), true) });
  try {
    await until(() => relayed.length >= 3);
    const c = gw.conns[0];
    const ident = c.got.find(m => m.op === 2);
    assert.equal(ident.d.token, 'T0KEN');
    assert.equal(ident.d.intents, INTENTS);
    assert.equal(INTENTS, (1 << 0) | (1 << 9) | (1 << 10) | (1 << 15));
    assert.deepEqual(relayed.map(r => r[0]), ['READY', 'MESSAGE_CREATE', 'MESSAGE_REACTION_ADD']);
    assert.deepEqual(relayed[0][1], { guildIds: ['4444'], userId: '999' });
    assert.equal(relayed[1][1].id, 'm1');
    await until(() => c.got.some(m => m.op === 1));
    assert.ok(c.got.some(m => m.op === 1), 'sends heartbeats');
  } finally {
    g.stop();
    gw.close();
  }
});

test('resumes with the session and the last sequence after a drop, and says RESUMED', async () => {
  const relayed = [];
  const relayedData = [];
  const gw = await fakeGateway((conn, n) => {
    hello(conn);
    if (n === 0) setTimeout(() => {
      conn.send({ op: 0, t: 'READY', s: 7, d: { session_id: 'sessA', resume_gateway_url: gw.url, guilds: [], user: { id: '1' } } });
      setTimeout(() => conn.close(4006), 120); // not fatal
    }, 30);
    else setTimeout(() => conn.send({ op: 0, t: 'RESUMED', s: 8, d: {} }), 60);
  });
  const g = startGateway({ token: 'T', url: gw.url, relay: async (e, d) => (relayed.push(e), relayedData.push(d), true) });
  try {
    await until(() => relayed.includes('RESUMED'), 8000);
    const second = gw.conns[1];
    const resume = second.got.find(m => m.op === 6);
    assert.deepEqual(resume.d, { token: 'T', session_id: 'sessA', seq: 7 });
    assert.ok(!second.got.some(m => m.op === 2), 'no fresh identify');
    assert.deepEqual(relayed, ['READY', 'RESUMED']);
    assert.deepEqual(relayedData[1], { guildIds: [] }, 'RESUMED carries the guilds of the READY');
  } finally {
    g.stop();
    gw.close();
  }
});

test('an invalid session that cannot resume starts again with an identify', async () => {
  const gw = await fakeGateway((conn, n) => {
    hello(conn);
    if (n === 0) setTimeout(() => {
      conn.send({ op: 0, t: 'READY', s: 3, d: { session_id: 's', resume_gateway_url: gw.url, guilds: [], user: { id: '1' } } });
      setTimeout(() => conn.send({ op: 9, d: false }), 60);
    }, 30);
  });
  const g = startGateway({ token: 'T', url: gw.url, relay: async () => true });
  try {
    await until(() => gw.conns[1]?.got.some(m => m.op === 2 || m.op === 6), 8000);
    assert.ok(gw.conns[1].got.some(m => m.op === 2), 'identifies again');
    assert.ok(!gw.conns[1].got.some(m => m.op === 6));
  } finally {
    g.stop();
    gw.close();
  }
});

test('a link with no heartbeat ack is closed and resumed; a fatal close code is not retried', async () => {
  const gw = await fakeGateway((conn, n) => {
    conn.noAck = true; // never acks
    hello(conn, 30);
    if (n === 0) setTimeout(() => conn.send({ op: 0, t: 'READY', s: 1, d: { session_id: 's', resume_gateway_url: gw.url, guilds: [], user: { id: '1' } } }), 10);
    if (n === 1) setTimeout(() => conn.close(4004), 5);
  });
  let fatal = 0;
  const g = startGateway({ token: 'T', url: gw.url, relay: async () => true, onFatal: c => (fatal = c) });
  try {
    await until(() => gw.conns.length >= 2, 8000);
    assert.ok(gw.conns.length >= 2, 'reconnected after the dead link');
    await until(() => fatal === 4004, 4000);
    assert.equal(fatal, 4004);
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(gw.conns.length, 2, 'no retry after a fatal code');
  } finally {
    g.stop();
    gw.close();
  }
});

test('the relay retries a failed post, then gives up on that event and goes on', async () => {
  let calls = 0;
  const seen = [];
  const gw = await fakeGateway(conn => {
    hello(conn, 5000);
    setTimeout(() => {
      conn.send({ op: 0, t: 'READY', s: 1, d: { session_id: 's', resume_gateway_url: 'x', guilds: [], user: { id: '1' } } });
      conn.send({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: 'a' } });
      conn.send({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: { id: 'b' } });
    }, 20);
  });
  const g = startGateway({
    token: 'T',
    url: gw.url,
    retryMs: [10, 10],
    relay: async (e, d) => {
      calls++;
      if (e === 'MESSAGE_CREATE' && d.id === 'a') return false; // always refused
      seen.push(d.id ?? e);
      return true;
    },
  });
  try {
    await until(() => seen.includes('b'));
    assert.deepEqual(seen, ['READY', 'b']);
    assert.equal(calls, 5, 'READY once, a three times, b once');
  } finally {
    g.stop();
    gw.close();
  }
});

test('serverRelay posts {event, data} with the secret as bearer', async () => {
  const got = [];
  const relay = serverRelay({ baseUrl: 'http://127.0.0.1:3100/', secret: 'sekret', fetchImpl: async (u, o) => (got.push([u, o]), { ok: true }) });
  assert.equal(await relay('READY', { a: 1 }), true);
  assert.equal(got[0][0], 'http://127.0.0.1:3100/api/discord/gateway');
  assert.equal(got[0][1].headers.authorization, 'Bearer sekret');
  assert.deepEqual(JSON.parse(got[0][1].body), { event: 'READY', data: { a: 1 } });
});
