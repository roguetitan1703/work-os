// A fake Discord API for the discord-v4 suite (the same idea as the stub in discord-link.mjs, with state the suite can set
// and read): channels with messages, members, bot posts (create, edit, delete), DMs, OAuth (token exchange, the user behind a
// token) and attachment downloads. Listens on E2E_DISCORD_PORT.
import http from 'node:http';

export const BOT = '999999999999999999';
export const APP = '222222222222222222';

export async function startStub() {
  const st = {
    guilds: {}, // id -> { channels: [{id,type,name,...}], members: { id: { roles, user, nick } }, roles }
    messages: {}, // channelId -> [raw message]
    posts: [], // { channel, id, body } the bot's creates
    edits: [], // { channel, id, body }
    deletes: [],
    dms: [],
    interactionEdits: [], // deferred replies { token, body }
    codes: {}, // oauth code -> user object
    tokens: {}, // access token -> user object
    files: {}, // path -> { type, body }
    emojis: [], // POST /guilds/:id/emojis
    calls: [], // every request: "METHOD path"
    nextId: 5_000_000_000_000_000_000n,
    failCreate: false,
  };
  const newId = () => String(st.nextId++);
  const json = (s, code, body) => {
    s.statusCode = code;
    s.setHeader('content-type', 'application/json');
    s.end(body === null ? '' : JSON.stringify(body));
  };
  const server = http.createServer((q, s) => {
    const chunks = [];
    q.on('data', d => chunks.push(d));
    q.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const [u, qs] = q.url.split('?');
      const params = new URLSearchParams(qs ?? '');
      const body = () => {
        try {
          return JSON.parse(raw || '{}');
        } catch {
          return {};
        }
      };
      st.calls.push(`${q.method} ${u}`);
      let m;
      if (st.files[u]) {
        s.statusCode = 200;
        s.setHeader('content-type', st.files[u].type);
        return s.end(st.files[u].body);
      }
      if (u === '/oauth2/token' && q.method === 'POST') {
        const f = new URLSearchParams(raw);
        const user = st.codes[f.get('code') ?? ''];
        if (!user || f.get('client_secret') !== 'e2e-client-secret') return json(s, 400, { error: 'invalid_grant' });
        delete st.codes[f.get('code')];
        const tok = `at-${user.id}`;
        st.tokens[tok] = user;
        return json(s, 200, { access_token: tok, token_type: 'Bearer', scope: 'identify' });
      }
      if (u === '/users/@me') {
        const auth = q.headers.authorization ?? '';
        if (auth.startsWith('Bearer ')) {
          const user = st.tokens[auth.slice(7)];
          return user ? json(s, 200, user) : json(s, 401, { message: '401: Unauthorized' });
        }
        return json(s, 200, { id: BOT, username: 'workos-bot', bot: true });
      }
      if (u === '/applications/@me') return json(s, 200, { flags: 1 << 19 });
      if (u === '/users/@me/channels' && q.method === 'POST') return json(s, 200, { id: 'dm-' + body().recipient_id });
      if ((m = u.match(/^\/channels\/dm-(\d+)\/messages$/)) && q.method === 'POST') {
        st.dms.push({ to: m[1], content: body().content, components: body().components });
        return json(s, 200, { id: newId() });
      }
      if ((m = u.match(/^\/webhooks\/\d+\/([^/]+)\/messages\/@original$/))) {
        st.interactionEdits.push({ token: m[1], body: body() });
        return json(s, 200, {});
      }
      if ((m = u.match(/^\/guilds\/(\d+)$/))) return st.guilds[m[1]] ? json(s, 200, { id: m[1], owner_id: '1' }) : json(s, 404, { message: 'Unknown Guild' });
      if ((m = u.match(/^\/guilds\/(\d+)\/channels$/))) return st.guilds[m[1]] ? json(s, 200, st.guilds[m[1]].channels) : json(s, 404, { message: 'Unknown Guild' });
      if ((m = u.match(/^\/guilds\/(\d+)\/threads\/active$/))) return json(s, 200, { threads: [] });
      if ((m = u.match(/^\/guilds\/(\d+)\/roles$/))) return st.guilds[m[1]] ? json(s, 200, st.guilds[m[1]].roles) : json(s, 404, { message: 'Unknown Guild' });
      if ((m = u.match(/^\/guilds\/(\d+)\/members\/(\d+)$/))) {
        const mem = st.guilds[m[1]]?.members[m[2]];
        return mem ? json(s, 200, mem) : json(s, 404, { message: 'Unknown Member', code: 10007 });
      }
      if ((m = u.match(/^\/guilds\/(\d+)\/emojis$/))) {
        if (q.method === 'POST') {
          const b = body();
          st.emojis.push(b);
          return json(s, 201, { id: newId(), name: b.name });
        }
        return json(s, 200, st.guilds[m[1]]?.emojis ?? []);
      }
      if ((m = u.match(/^\/channels\/(\d+)\/messages$/))) {
        const ch = m[1];
        if (q.method === 'POST') {
          if (st.failCreate) return json(s, 403, { message: 'Missing Permissions' });
          const b = body();
          const msg = { id: newId(), channel_id: ch, type: 0, author: { id: BOT, username: 'workos-bot', bot: true }, content: b.content ?? '', timestamp: new Date().toISOString(), mentions: [], mention_roles: [], mention_everyone: false, attachments: [], embeds: [], components: b.components, message_reference: b.message_reference };
          (st.messages[ch] ??= []).push(msg);
          st.posts.push({ channel: ch, id: msg.id, body: b });
          return json(s, 200, msg);
        }
        let list = [...(st.messages[ch] ?? [])];
        const after = params.get('after');
        if (after) list = list.filter(x => BigInt(x.id) > BigInt(after));
        list.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1)); // newest first, as Discord does
        return json(s, 200, list.slice(0, Number(params.get('limit') ?? 50)));
      }
      if ((m = u.match(/^\/channels\/(\d+)\/messages\/(\d+)$/))) {
        const [, ch, id] = m;
        const msg = (st.messages[ch] ?? []).find(x => x.id === id);
        if (q.method === 'PATCH') {
          const b = body();
          st.edits.push({ channel: ch, id, body: b });
          if (msg) Object.assign(msg, { content: b.content ?? msg.content, components: b.components ?? msg.components });
          return json(s, 200, msg ?? { id });
        }
        if (q.method === 'DELETE') {
          st.deletes.push({ channel: ch, id });
          return json(s, 204, null);
        }
        return msg ? json(s, 200, msg) : json(s, 404, { message: 'Unknown Message' });
      }
      if ((m = u.match(/^\/channels\/(\d+)$/))) {
        for (const [gid, g] of Object.entries(st.guilds)) {
          const c = g.channels.find(x => x.id === m[1]);
          if (c) return json(s, 200, { ...c, guild_id: gid });
        }
        return json(s, 404, { message: 'Unknown Channel' });
      }
      json(s, 404, { message: 'not stubbed' });
    });
  });
  await new Promise(r => server.listen(Number(process.env.E2E_DISCORD_PORT || 4401), '127.0.0.1', r));
  return { st, close: () => server.close(), newId };
}
