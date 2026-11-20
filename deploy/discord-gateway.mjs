#!/usr/bin/env node
// The Discord live listener (plan "Work OS in Discord" v4, section 1). Plain Node 22: the built-in WebSocket, no packages.
// It connects to Discord's gateway as the bot, keeps the heartbeat, resumes after a drop, and relays only
//   MESSAGE_CREATE, MESSAGE_REACTION_ADD and READY / RESUMED
// to POST /api/discord/gateway on this machine, with CRON_SECRET as the bearer. All logic lives in the server
// (lib/discord/gateway.ts); this file keeps no state beyond the connection. Run by work-os-discord.service.
//
//   DISCORD_BOT_TOKEN   the bot (without it the service says so and stops, exit 0)
//   CRON_SECRET         the relay's credential (the same one the alert check uses)
//   WORK_OS_LOCAL_URL   default http://127.0.0.1:<WORK_OS_PORT or 3100>
//   DISCORD_GATEWAY_URL for tests against a fake gateway; default wss://gateway.discord.gg
import { pathToFileURL } from 'node:url';

// GUILDS (1<<0), GUILD_MESSAGES (1<<9), GUILD_MESSAGE_REACTIONS (1<<10), MESSAGE_CONTENT (1<<15)
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 10) | (1 << 15);
const RELAYED = new Set(['MESSAGE_CREATE', 'MESSAGE_REACTION_ADD']);
// Close codes that retrying cannot fix: wrong token, bad intents, intents the app has not been given.
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const QUEUE_MAX = 500;

/**
 * Starts the listener. `relay(event, data)` posts one event to the server and resolves true when it was taken.
 * Returns { stop() }. `ws` and `setTimer` are for tests.
 */
export function startGateway({ token, url = 'wss://gateway.discord.gg', relay, log = () => {}, ws: WS = globalThis.WebSocket, onFatal = () => {}, retryMs = [1000, 3000, 8000] }) {
  let sock = null;
  let seq = null;
  let sessionId = null;
  let guildIds = [];
  let resumeUrl = null;
  let acked = true;
  let beat = null;
  let first = null;
  let stopped = false;
  let backoff = 0;
  let reconnectTimer = null;
  const queue = [];
  let draining = false;

  const base = u => (u.includes('?') ? u : `${u.replace(/\/+$/, '')}/?v=10&encoding=json`);

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length && !stopped) {
        const [event, data] = queue[0];
        let ok = false;
        for (let i = 0; i <= retryMs.length && !ok && !stopped; i++) {
          ok = await relay(event, data).catch(() => false);
          if (!ok && i < retryMs.length) await new Promise(r => setTimeout(r, retryMs[i]));
        }
        if (!ok && !stopped) log(`relay of ${event} failed; dropped (the catch-up on the next READY reads missed posts)`);
        queue.shift();
      }
    } finally {
      draining = false;
    }
  }
  function push(event, data) {
    if (queue.length >= QUEUE_MAX) {
      queue.shift();
      log('relay queue full: dropped the oldest event');
    }
    queue.push([event, data]);
    void drain();
  }

  const send = o => {
    try {
      sock?.send(JSON.stringify(o));
    } catch {
      /* the close handler reconnects */
    }
  };
  const clearBeat = () => {
    clearTimeout(first);
    clearInterval(beat);
    first = beat = null;
  };
  function heartbeat() {
    if (!acked) {
      // No ack since the last beat: the link is dead. Close and resume.
      try {
        sock?.close(4000, 'no heartbeat ack');
      } catch {
        /* closed already */
      }
      return;
    }
    acked = false;
    send({ op: 1, d: seq });
  }

  function connect() {
    if (stopped) return;
    const resuming = !!(sessionId && resumeUrl);
    const s = new WS(base(resuming ? resumeUrl : url));
    sock = s;
    s.onmessage = ev => {
      if (sock !== s) return;
      let m;
      try {
        m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      } catch {
        return;
      }
      if (typeof m.s === 'number') seq = m.s;
      switch (m.op) {
        case 10: {
          const ms = Number(m.d?.heartbeat_interval) || 41_250;
          clearBeat();
          acked = true;
          first = setTimeout(() => {
            heartbeat();
            beat = setInterval(heartbeat, ms);
          }, Math.floor(ms * Math.random()));
          if (resuming) send({ op: 6, d: { token, session_id: sessionId, seq } });
          else send({ op: 2, d: { token, intents: INTENTS, properties: { os: 'linux', browser: 'work-os', device: 'work-os' } } });
          break;
        }
        case 11:
          acked = true;
          break;
        case 1:
          heartbeat();
          break;
        case 7:
          // Discord asks us to reconnect: resume.
          try {
            s.close(4000, 'reconnect requested');
          } catch {
            /* closed already */
          }
          break;
        case 9:
          // Invalid session: d true = resumable. Otherwise start fresh after a short wait.
          if (!m.d) {
            sessionId = null;
            resumeUrl = null;
            seq = null;
          }
          try {
            s.close(4000, 'invalid session');
          } catch {
            /* closed already */
          }
          break;
        case 0:
          if (m.t === 'READY') {
            sessionId = m.d?.session_id ?? null;
            resumeUrl = m.d?.resume_gateway_url ?? null;
            backoff = 0;
            guildIds = (m.d?.guilds ?? []).map(g => g.id).filter(Boolean);
            push('READY', { guildIds, userId: m.d?.user?.id ?? null });
          } else if (m.t === 'RESUMED') {
            backoff = 0;
            push('RESUMED', { guildIds });
          } else if (RELAYED.has(m.t)) push(m.t, m.d);
          break;
      }
    };
    s.onclose = ev => {
      if (sock !== s) return;
      clearBeat();
      sock = null;
      if (stopped) return;
      if (FATAL.has(ev?.code)) {
        log(`gateway closed with ${ev.code}: not retrying (check the token and the bot's intents in the Developer Portal)`);
        onFatal(ev.code);
        return;
      }
      const wait = Math.min(30_000, 1000 * 2 ** backoff++);
      log(`gateway closed (${ev?.code ?? '?'}); ${sessionId ? 'resuming' : 'reconnecting'} in ${wait} ms`);
      reconnectTimer = setTimeout(connect, wait);
    };
    s.onerror = () => {
      /* onclose follows */
    };
  }

  connect();
  return {
    stop() {
      stopped = true;
      clearBeat();
      clearTimeout(reconnectTimer);
      try {
        sock?.close(1000, 'stop');
      } catch {
        /* closed already */
      }
    },
  };
}

/** The relay to the server on this machine. */
export function serverRelay({ baseUrl, secret, fetchImpl = fetch }) {
  return async (event, data) => {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/discord/gateway`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ event, data }),
    });
    return res.ok;
  };
}

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  const secret = process.env.CRON_SECRET?.trim();
  if (!token) {
    console.log('[discord-gateway] DISCORD_BOT_TOKEN is not set: nothing to listen to.');
    return;
  }
  if (!secret || secret.length < 16) {
    console.error('[discord-gateway] CRON_SECRET is not set (16+ characters): it is the relay credential.');
    process.exit(1);
  }
  const baseUrl = process.env.WORK_OS_LOCAL_URL || `http://127.0.0.1:${process.env.WORK_OS_PORT || 3100}`;
  const g = startGateway({
    token,
    url: process.env.DISCORD_GATEWAY_URL || undefined,
    relay: serverRelay({ baseUrl, secret }),
    log: m => console.log(`[discord-gateway] ${m}`),
    onFatal: () => process.exit(1),
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => (g.stop(), process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
