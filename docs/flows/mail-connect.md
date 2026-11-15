# Connect Mailloom (one click instead of pasting a key)

Status: Work OS half built (lib/mail/connect.ts, tests `mail` and `mail-paste`); Mailloom half built separately. Replaces copying a Mailloom agent key into Settings › Connections › Mail.

## The flow a person sees

1. Work OS, Settings › Connections › Mail › **Connect Mailloom**.
2. The browser goes to Mailloom. If not signed in there, Mailloom's normal sign-in first. If several mailboxes are
   signed in, a picker ("Connect which mailbox?").
3. Mailloom shows: "**Work OS** wants to read, move and send mail as **om@delpat.in**", three ticks (all on, *read*
   cannot be unticked), the mailbox password field, **Allow** / **Cancel**.
4. Allow: back in Work OS, "Connected: om@delpat.in (read, organise, send)". Cancel: back with "Not connected".

The key is minted by Mailloom and travels only Mailloom server → Work OS server. It never appears in a URL, a page,
the browser, or a log.

## Shape: OAuth authorization code + PKCE, one registered client

Work OS is the client, Mailloom the authorization server. This is the same thing Work OS already does as a client of
Delpat OS (`lib/delpat-os.ts`, `app/api/delpat-os/callback/route.ts`): reuse that file's shape (pending row keyed by
state, verifier sealed next to it, `redirect: 'error'`, 10 s timeouts, 1 MB body cap, callback that checks the
signed-in caller and redirects to Settings with one fixed word). Work OS's own OAuth server (docs/auth.md) is not
involved. There is one client, so Mailloom registers it in env, not in a database or by dynamic registration.

### Mailloom endpoints (served under both `/` and `/mail`)

| Endpoint | Who calls | What it does |
|---|---|---|
| `GET /oauth/authorize?response_type=code&client_id&redirect_uri&scope&state&code_challenge&code_challenge_method=S256` | browser | Checks client id and **exact** redirect URI against env, S256 only, scope ⊆ `read organise send`. Bad client or redirect: an error page, **never** a redirect. Good: stores a pending request (`agent_auth_requests`, 10 min) and redirects to `<same prefix>/#/connect/<request id>` |
| `GET /api/oauth/requests/:id` | consent screen (session) | Client name, requested scopes, signed-in mailboxes. 404 when expired or used |
| `POST /api/oauth/consent` | consent screen (session + `X-Mailloom-Account`, the existing CSRF guard) | `{request_id, allow, scopes, password}`. Allow: `verifyReentry` (existing throttle), then makes a code (256 random bits), stores **sha256(code)**, client, mailbox, redirect URI, challenge, granted scopes, and the mailbox password sealed with a key derived from SESSION_SECRET **and the code** (same idea as `agent/crypto.ts`). Returns the redirect URL `redirect_uri?code&state&iss`; the page navigates. Cancel: `?error=access_denied&state`. Demo account refused |
| `POST /api/agent/v1/oauth/token` | Work OS server | Under the existing `AGENT_ALLOWED_IPS` check. `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier`, `client_id`, `client_secret`. Deletes the code row first (single use), checks expiry, client, redirect, `sha256(verifier) == challenge`, then mints the key with `store.createKey` and answers `{key, key_id, prefix, email, scopes}` with `Cache-Control: no-store`. Rate-limited per IP |
| `POST /api/agent/v1/key/revoke` | Work OS server, `Bearer <key>` | A key revokes itself. Used for Disconnect, replacing a key, and member removal |

The key is minted at the swap, not at Allow, so an abandoned flow leaves no live key. Codes live **60 seconds**. A
code used twice: the second attempt fails and the key minted by the first is revoked (records `code_hash → key_id`
for 10 minutes). `agent_keys` gains `client_id` and `label` so Connections shows "Work OS (Delpat), connected
16 Nov" and its Revoke button works as today.

### Work OS endpoints

| Piece | What it does |
|---|---|
| `startMailConnectAction()` (`app/(app)/settings/mail-actions.ts`) | New `lib/mail/connect.ts` `startConnect(caller)`: random state, PKCE verifier (sealed), pending row `{_id: state, orgId, userId, sessionId, expiresAt: +10 min}` in `mailConnectAuth` (one per person; a new start clears the old). Returns the authorize URL; the button navigates |
| `GET /api/mail/callback` | Fresh caller read (signed out → login). Takes the pending row by state with `findOneAndDelete`; must match caller org, user and session, not expired. `error=` → `?mail=denied`. Else token call (secret + verifier), `whoami` with the new key as a check, seal as today (`sealMailKey`, AAD org+user), then self-revoke the replaced key. Answers 303 to `/settings?section=connections&mail=linked|denied|error`, `Referrer-Policy: no-referrer`, `no-store` |
| `disconnectMailAction()` | Self-revoke at Mailloom, then delete the setting. If Mailloom is down, delete anyway and say "revoke it in Mailloom › Connections" |

## Decisions

- **Client authentication on the swap: client secret in env, plus PKCE, and the IP check stays.** PKCE alone stops a
  stolen code (the verifier never leaves Work OS's server). The secret is the client's identity: the IP allow-list
  alone depends on `TRUST_PROXY` being right and admits anything else running on an allowed address (both apps may
  share a box). It costs one env value on each side and Work OS already sends `client_secret_post` to Delpat OS. The
  IP check is free (the token route sits under the agent API) and stays.
- **Scopes:** Work OS asks for all three. *read* is required (every mail tool needs it); *organise* and *send* can be
  unticked. Work OS stores what the swap says was granted and the mail tools already answer clearly on a missing
  scope. *send* still cannot reach outside the mailbox's domain (Work OS refuses; a person sends).
- **An existing key:** connecting again (same org) replaces the stored key, then self-revokes the old one. A failed
  revoke is shown, not fatal.
- **Revoking from Mailloom:** Connections › Revoke as today. Work OS finds out on the next call (`KEY_REVOKED`) and
  Settings shows "Disconnected in Mailloom. Connect again."
- **A person in two organizations:** each org has its own sealed key (setting is per org+user already) and its own
  Mailloom key, labelled with the org name (`label` passed on authorize, shown on consent and in Connections).
  Revoking one does not touch the other.
- **Member removal:** where `lib/oauth.ts` drops Delpat OS links, also self-revoke the person's Mailloom key for
  that org and delete the setting. Today the sealed key just stays (Later item).
- **Paste box:** kept as a fallback behind "Paste a key instead" (works when Connect is not configured, e.g. a test
  box). Remove once Connect has run on the live site for a few weeks.

## Threats and what stops each

| Threat | Stopped by |
|---|---|
| Code read from history, a proxy log or Referer | Useless alone: needs the verifier (server-only), the secret and an allowed IP; 60 s; single use; no-referrer redirect |
| Code sent somewhere else (open redirect) | Exact redirect URI list in Mailloom env; a mismatch never redirects |
| Mix-up: my mailbox lands in someone else's Work OS, or theirs in mine (forged link, CSRF) | State is bound to the person, org and session that started; callback rechecks the signed-in caller; Settings shows the address after |
| Clickjacked or one-click Allow | `frame-ancestors 'none'`, consent is a POST with the account header, password on Allow |
| Someone at an unlocked computer giving their own Work OS lasting access to your mail | Password on Allow; the key shows in Mailloom › Connections with its org label and can be revoked |
| Key in logs | Never in a URL; token route's body and reply excluded from request logging; Work OS logs only error names |
| Mailloom database copied | Codes stored hashed; password sealed with a key that needs the code; keys hashed as today |
| Fake or broken Mailloom answer | https only (http for localhost tests), no redirects followed, timeouts, 1 MB cap, reply shape checked, `whoami` check |
| Guessing codes or hammering the swap | 256-bit codes, per-IP rate limit, IP allow-list |
| Asking for more than allowed | Granted scopes are the requested ones the person kept ticked, never more |

## Tests

- **Work OS** (`tests/e2e/mail.mjs`, its fake Mailloom gains `/oauth/authorize` that auto-approves, the token and
  self-revoke routes): connect stores a sealed key and shows the address and scopes; `mlk_` never appears in any
  Location header, page HTML or the server log; state reused, expired, from another person or org: refused; denied;
  token error; whoami mismatch; reconnect revokes the old key; disconnect revokes; two orgs keep two keys; member
  removal revokes; paste fallback still works; Connect hidden when env is missing.
- **Mailloom** (`server/test/`, new `connect.test.ts`, fake clock as in `agent.test.ts`): unknown client or redirect
  shows an error and does not redirect; plain PKCE and wrong verifier refused; 61-second code refused; reused code
  refused and its key revoked; wrong secret; disallowed IP; scopes subset; consent needs session, account header and
  the right password (throttled); demo refused; key absent from logs (`logging.test.ts` pattern); self-revoke.

## Build plan

**Mailloom (first, deployed before Work OS turns Connect on):** `agent/config.ts` client settings; store tables for
requests and codes plus `client_id`/`label` on keys; `routes/oauth.ts` (authorize, request, consent); token and
self-revoke in `routes/agent.ts`; `#/connect/:id` consent screen in the client; Connections shows the label; tests.

**Work OS:** `lib/mail/connect.ts` (copy of the Delpat OS client shape), `app/api/mail/callback/route.ts`, start and
disconnect actions, `mail-key.tsx` button, status and the folded paste box, member-removal hook, tests, env rows in
docs/hosting.md and HANDOVER.

Both are access and security work: builder A, Mailloom first; a review subagent before each merge.

## Env changes

| Server | Variable | Value |
|---|---|---|
| Mailloom | `AGENT_CLIENT_ID` | e.g. `work-os` (not secret) |
| Mailloom | `AGENT_CLIENT_SECRET` | 32+ random characters, same as Work OS's `MAILLOOM_CLIENT_SECRET` |
| Mailloom | `AGENT_CLIENT_REDIRECT_URIS` | comma list, exact, https (http only for localhost): `https://<work os>/api/mail/callback` |
| Mailloom | `AGENT_ALLOWED_IPS`, `MAILLOOM_PUBLIC_URL` | unchanged |
| Work OS | `MAILLOOM_PUBLIC_URL` | where browsers open Mailloom, e.g. `https://mail.delpat.in/mail` (authorize lives under it) |
| Work OS | `MAILLOOM_CLIENT_ID`, `MAILLOOM_CLIENT_SECRET` | as above. With `MAILLOOM_AGENT_URL` set, all three switch Connect on; otherwise only the paste box shows |
| Work OS | `MAILLOOM_AGENT_URL`, `MAIL_KEY_SECRET` | unchanged (token and self-revoke are under the agent URL) |

## Open questions for Om

1. **Ask the mailbox password on Allow?** Yes means one extra field; no means a true single click, but anyone at a
   signed-in browser could hand their own Work OS lasting access. Recommend **yes** (Mailloom already asks it for
   every new key).
2. **Keep the paste box?** Recommend **keep, folded**, remove after a few weeks of Connect on the live site.
3. **Default ticks:** recommend **all three on**, read required.
4. **Revoke the Mailloom key when someone is removed from an org?** Recommend **yes**, automatically.
