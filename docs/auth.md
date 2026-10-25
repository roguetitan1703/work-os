# Sign-in, members and keys

Phase 1 of `docs/multi-user.md`. Work OS signs people in with [Better Auth](https://better-auth.com) 1.7 (pinned exact)
on the existing MongoDB, in Better Auth's own collections: `user`, `account`, `session`, `verification`, `twoFactor`,
`passkey`, `organization`, `member`, `invitation`, `apikey`, `rateLimit`. Data is **not** scoped by organization yet:
every member sees everything. Phase 2 does that.

## For Om

- **Sign in:** `/login` with email and password, then the authenticator code if it is on. Or *Sign in with passkey*.
- **Forgot password:** *Forgot password?* emails a link to your own address. It works once, for 15 minutes, and
  signs every device out. Unlike the old flow it does not ask for the authenticator code.
- **Settings › Security:** passkeys, authenticator app (QR, then one code, then 10 backup codes shown once; turning it
  off or new backup codes needs your password), change password (other devices signed out), test email.
- **Connect Claude (no key to copy):** Settings › Connections › *Connect Claude* shows the address to add. On claude.ai:
  Settings → Connectors → Add custom connector → paste `https://work.delpat.in/api/mcp` → Connect. A Work OS page asks you to
  sign in (if you aren't) and shows *"Claude wants to access your Work OS as you in <organization>: Allow / Deny"*. Allow, and
  it works. Claude Code: `claude mcp add --scope user --transport http work-os https://work.delpat.in/api/mcp`, then `/mcp` →
  work-os → Authenticate (or `claude mcp login work-os`); the same Allow screen opens in the browser. *Signed-in apps* lists
  what you allowed (when, last used) with *Revoke*. API keys moved to *Advanced: API keys* (for the worker, scripts, clients
  that cannot sign in).
- **Settings › Members:** who is in the organization. Owners and admins invite by email; only an owner can invite an
  owner. The invitation email holds `/accept-invitation/<id>?t=<secret>`, valid 7 days, once. By default the inviter
  also sees the link, to copy when email is off; with `INVITE_LINK_TO_INVITER=0` it goes only by email (below). The
  invited person picks a name and password there and lands on Today; someone who already has an account signs in
  first and clicks *Join*. Sign-up is otherwise closed. Pending invitations are listed and can be cancelled.
- **Roles and removal** (phase 4, docs/multi-user.md "As built: phase 4"):
  - Owners and admins change roles and remove members. Only an owner makes, changes or removes an owner.
  - The last owner can't be demoted or removed. An owner may step down while there is another one.
  - Removing someone signs them out of the organization and deletes their keys for it. It revokes their computers there and stops the tasks they gave to Claude.
  - Their private things stay, unseen by anyone.
- **Keys** (each belongs to the person who made it, in their organization; history records who):
  - *Claude chat key* (Settings › Connections): the claude.ai connector. Replaces `MCP_TOKEN`. Also accepted on
    `/api/admin/*` for owners and admins, and on the other API routes.
  - *Claude Code key* (Claude › Setup): `/api/mcp` only, with the Claude Code rules.
  - *Computers* (Claude › Setup): `wkr_` device keys for the worker, made by a signed-in person; the jobs they run
    are recorded as that person.
  - Revoking deletes the key at once.

## Moving over (once)

1. Set `BETTER_AUTH_SECRET` (32+ random characters) and `APP_URL` on Vercel. Remove `APP_PASSWORD`, `SESSION_SECRET`
   (after step 2) and `MCP_TOKEN`.
2. `OWNER_EMAIL=<Om's address> node scripts/migrate-auth.mjs --db workos` (dry run), then add `--apply`. It creates
   Om (no password), the organization *Delpat* with Om as owner, lists the old Claude Code keys and computers, revokes
   the old computers and writes the one-time Settings notice. `--apply --drop-old` later deletes the old auth data
   (`apiKeys`, `passkeys`, `authChallenges`, `authFailures`, `passwordResets`, settings `security`). Idempotent; it
   refuses to run without `--db`.
3. `/login` → *Forgot password?* → set a password from the email. Turn the authenticator app and passkeys on again
   (old passkeys and TOTP are not carried over).
4. Add the connector on claude.ai again (sign in with Work OS and Allow; no key), and Claude Code (`claude mcp add`, then
   `/mcp` → Authenticate); re-add each computer and put the new `wkr_` key in the worker config. Settings shows this as a
   notice until dismissed.

## Connecting Claude with OAuth

Claude (claude.ai, Desktop, mobile, Claude Code) signs in to `/api/mcp` with OAuth, as the MCP authorization spec
describes (the installed `@modelcontextprotocol/sdk` 1.32 speaks protocol 2025-11-25; the flow below is what Claude's
connector docs ask for: https://claude.com/docs/connectors/building/authentication). The authorization server is
Better Auth's own OAuth provider, `@better-auth/oauth-provider` 1.7.12 (pinned together with `@better-auth/core` 1.7.12;
official, same release train as Better Auth, MongoDB through the same adapter, collections `oauthClient`,
`oauthAccessToken`, `oauthRefreshToken`, `oauthConsent`, `oauthResource`, `oauthClientResource`). No JWT plugin: access
tokens are opaque.

**The flow**

1. `/api/mcp` without a valid token answers **401** with `WWW-Authenticate: Bearer resource_metadata="<site>/.well-known/oauth-protected-resource/api/mcp", scope="workos"`
   (plus `error="invalid_token"` when a bad token was sent, so the client refreshes).
2. Protected-resource metadata (RFC 9728): `/.well-known/oauth-protected-resource[/api/mcp]`
   (`app/.well-known/oauth-protected-resource/[[...path]]/route.ts`): `resource` = `<APP_URL>/api/mcp` exactly,
   `authorization_servers` = [`<APP_URL>/api/auth`], scope `workos`.
3. Authorization-server metadata (RFC 8414): `/.well-known/oauth-authorization-server` and the RFC path form
   `/.well-known/oauth-authorization-server/api/auth`: Better Auth's document minus the endpoints we don't serve
   (introspection, userinfo, end-session). `code_challenge_methods_supported` = [S256]; public clients (`none`); grants
   `authorization_code` and `refresh_token` (no `client_credentials`); scopes `workos` and `offline_access` (Claude adds
   `offline_access` itself to get a refresh token).
4. **Dynamic client registration** (RFC 7591) at `POST /api/auth/oauth2/register`, open (claude.ai registers itself) but cut
   down in `app/api/auth/[...all]/route.ts` before Better Auth sees it: 1 to 5 redirect addresses, each `https` or `http` on
   `localhost`/`127.0.0.1`/`[::1]`, no fragment, no credentials, no custom schemes; always a public client; fields that make
   the server fetch an address (`jwks_uri`, `logo_uri`, backchannel logout, software statement) and `skip_consent` are dropped;
   body at most 8 KB. Better Auth rate-limits it (20 an hour per address; per address needs `TRUST_PROXY=1`). Clients that
   nobody approved within 48 hours are deleted (`pruneUnusedClients`, lib/oauth.ts).
5. **Authorize** (`GET /api/auth/oauth2/authorize`): S256 PKCE required (`plain` and no challenge are refused), `resource`
   must be the MCP address, scope must be ours, `redirect_uri` must be exactly a registered one (except a loopback port, which
   may differ: RFC 8252, and what Claude Code does). Anything else is refused without redirecting. A signed-out person goes to
   `/login` (the login page carries the request through: `app/login/page.tsx` `oauthNext`) and back. Then the **consent
   screen** `/oauth/consent` (our own page, `app/oauth/consent`): app name (labelled *not verified*: the app chose it), the
   person and organization, what it can do, where Allow sends the browser (host shown; a loopback-only client gets a "program
   on this computer" warning), **Allow / Deny**. The page is not frameable (CSP `frame-ancestors 'none'`, `X-Frame-Options`)
   and shows nothing for a request whose signature (Better Auth's signed query) or app is wrong. Allow and Deny post to
   `/api/auth/oauth2/consent`, which checks the signature, the session and the origin again. A new app (every dynamic
   registration is a new client) always asks; an app this person already approved for this organization does not ask again.
6. **Token** (`POST /api/auth/oauth2/token`, form-encoded): the code (valid 2 minutes, single use; reusing it revokes what it
   issued) with its PKCE verifier gives `wosat_…` (access, **1 hour**) and `wosrt_…` (refresh, 30 days). Refreshing **rotates**
   the refresh token; presenting an already-rotated one (`refreshTokenReuseInterval: 0`) answers `invalid_grant` and deletes
   the whole family (every token of that app for that person). Both are stored **hashed** (SHA-256). `POST /api/auth/oauth2/revoke`
   revokes one.
7. **`/api/mcp` with the token** (`lib/oauth.ts` `callerFromOAuthToken`): looked up in the database on every call; must be
   unexpired, unrevoked, carry scope `workos` and the MCP address as its resource; its app must exist and be enabled; and the
   person must still be a member of the organization it was approved for. That organization (`referenceId`, the session's
   active organization at the consent screen) is the only one it can reach. It then runs exactly like that person's Claude
   key: the same `Caller` with `key.agent`, scope, rate limits, `lib/mcp/policy.ts`, usage logging, actor "Claude · <person>".

**Chat or Claude Code.** Decided by the app's registered redirect addresses, never by its name (anyone can register as
"Claude"): a client whose every address is `https://claude.ai/api/mcp/auth_callback` (or `claude.com`) is **chat** (`claude`,
no Claude Code rules). Any other client (Claude Code's loopback callback, any other app, a mix) is **claude-code**: the
stricter rules of `lib/mcp/policy.ts`. The consent screen says so. Call limits and dry-run confirmations are per (app,
person) (`oauth_<clientId>_<userId>`), so they survive a refresh.

**What ends a token:** Revoke in Settings › Connections › Signed-in apps (that app, for you, in this organization); the
revoke endpoint; removing the member (`releaseAccess` deletes their approvals and tokens for the organization, and the role
check stops them even before that); a password *reset* (all of that person's approvals and tokens); refresh-token reuse;
expiry (1 hour for access, 30 days for refresh, renewed on each refresh). **Not** ending a token: signing out of the browser
or "sign out other devices" (the connection is not the browser session; Revoke the app for that).

**Not served** (404 from `app/api/auth/[...all]/route.ts`): introspection, userinfo, end-session, client create/update/delete,
consent list/delete, `continue`, resource admin, device grant, JWKS. Apps register only through `/oauth2/register`.

**Known limits:** the client-metadata-document way (CIMD) is not offered, so Claude falls back to registration, which it
supports; a person in two organizations approves each separately (switch organization before pressing Allow);
registration's per-address rate limit shares one bucket without `TRUST_PROXY=1` (on the server Caddy sets it).

Tests: `tests/e2e/oauth.mjs` (the whole flow with a scripted client and the real pages).

## For Claude Code

| File | What |
|---|---|
| `lib/auth-server.ts` | the Better Auth instance (`getAuth()`), plugins: organization, twoFactor, passkey, apiKey, oauthProvider, nextCookies (last) |
| `lib/auth.ts` | light helpers with no Better Auth import: `authSecret()`, `appBaseUrl()`, cookie prefix `workos`, `SafeError` |
| `lib/caller.ts` | `getCaller()` → `{userId, orgId, role, email, name, via, key?}`; `requireCaller(...roles)`, `withCaller`, `asCaller`, `callerFromRequest`, `verifyKey` |
| `lib/members.ts` | members list, invite, cancel, view and accept invitations |
| `lib/oauth.ts`, `lib/oauth-config.ts` | OAuth for MCP clients: token check for `/api/mcp`, chat vs Claude Code, the consent view, Settings list and revoke, `dropOAuth` (member removal, password reset), unused-client clean-up; constants (scope, lifetimes, resource address) |
| `app/oauth/consent/*`, `app/.well-known/*` | the consent screen; protected-resource and authorization-server metadata |
| `lib/api-keys.ts`, `lib/devices.ts` | Claude keys on the apiKey plugin (`metadata: {agent, orgId}`); worker devices with `ownerId`/`orgId` |
| `app/api/auth/[...all]/route.ts` | Better Auth over HTTP, **allowlist only**: sign-in, sign-out, session, reset, change password, sessions, two-factor, passkeys, organization reads, set-active. Sign-up, API keys, organization create, invite and cancel-invitation are 404: server code calls `auth.api.*` directly. Also the five OAuth endpoints (`/oauth2/authorize`, `consent`, `token`, `revoke`, `register`; register is trimmed first) |
| `proxy.ts` | session via Better Auth's cookie cache; a Claude chat key passes on API routes |
| `scripts/migrate-auth.mjs`, `scripts/lib/auth-admin.mjs` | the migration; a script-side Better Auth for creating users, organizations and keys (also used by the e2e seed) |

- **Every request knows who.** Server actions use `requireCaller()` + `withCaller()` (or `asCaller(fn)`), API routes
  `callerFromRequest(req)`, MCP and worker routes their key. Since phase 2 every data call takes the caller's scope
  and history records the actor as an object with its user (`{kind:'agent', agent:'claude', userId}`; see
  docs/multi-user.md "As built").
- **Proxy cost:** the signed `workos.session_data` cookie (compact, 120 s) is checked without a database read. When
  it is stale the proxy calls `getSession` once and forwards the refreshed cookies. So a revoked or signed-out session
  can keep opening pages (and GET routes) for up to 2 minutes; a removed member cannot (their role is read on every
  request, and removal clears the role cache). Server actions (a fetch call with `Next-Action`, or a form post with a
  `multipart/form-data` or urlencoded body) and POST routes read the session from the database (`callerFromHeaders`; until the leak audit they used the cookie cache too, so a cookie copied before sign-out could
  still write for 2 minutes).
  `/api/worker`, `/api/mcp`, `/api/cron`, `/api/discord/interactions` and `/api/auth` check their own
  credentials. Public pages: `/login`, `/login/reset`, `/accept-invitation/<id>`.
- **Keys:** `wos_` + 48 characters, hashed by the plugin; `verifyKey` also requires the owner to still be a member of
  the key's organization (roles cached 60 s per instance). The plugin's own HTTP endpoints are not served. The URL
  form `/api/mcp/<key>` still needs `MCP_ALLOW_URL_TOKEN=1` and accepts only Claude chat keys. Rate limits and the
  rules in `lib/mcp/policy.ts` are unchanged; the `confirm` token HMAC now uses `BETTER_AUTH_SECRET`.
- **Invitations:** Better Auth's invitation id is listable by admins, so the link also carries a secret whose SHA-256
  is in `invitation.tokenHash`; accepting swaps `pending` → `accepted` atomically before the account is made.
- **Reset tokens** are stored hashed (`verification.storeIdentifier`, hashed for `reset-password:`). Mail: `lib/mail.ts`
  `sendMail({to, …})`, per-recipient and global hourly slots in `mailLog`.
- **Rate limits per IP:** Better Auth's, in the database, tighter for sign-in, two-factor, reset and
  change-password. `AUTH_RATE_LIMIT=off` turns them off (the e2e runner only). Better Auth reads the client
  address only from `x-workos-client-ip`, which `app/api/auth/[...all]/route.ts` sets (after deleting any copy the
  client sent) from `clientIp()` in `lib/auth.ts`. That trusts forwarded headers **only with `TRUST_PROXY=1`**: then
  `X-Real-IP`, else the right-most `X-Forwarded-For` entry (the one our proxy added). Without it every client shares
  one bucket per endpoint (Next route handlers don't see the socket address). Set `TRUST_PROXY=1` on Vercel and on
  the server behind our nginx, which must set `proxy_set_header X-Real-IP $remote_addr;`.
- **Rate limits per account** (`lib/auth-limits.ts`, collection `authLimits`): 10 failed passwords, authenticator
  codes or backup codes for one account in 15 minutes lock that step for the account (429) until the window passes;
  a success clears the count. Accounts are stored as hashes. Passkey sign-in is not limited. Re-entering the
  password (below) has the same limit. Not affected by `AUTH_RATE_LIMIT`.
- **Fresh session** (`lib/fresh.ts`): adding a passkey, creating or rotating an API key and adding a computer need a
  sign-in or a password re-entry in the last 10 minutes. Otherwise the action answers "Enter your password again to
  continue." (passkeys: 403 `FRESH_SESSION_REQUIRED`) and the page asks for the password (`components/reauth.tsx`),
  which stores `reauthAt` on the session, then retries.
- **Computers and agent sessions are private to their owner** (`ownerId` + `orgId` on the device): Claude › Setup,
  a project's folders and sessions, the Start picker, the Claude page and Today's Claude card, and the Give to
  Claude folder picker show only your own computers (`DeviceScope` in `lib/data/launcher.ts`). Start, link, unlink,
  resume, stop, remove and take back answer "not found" for anyone else's folder, session or task. A task given to
  Claude records who gave it (`claude.markedByUserId`) and only that person's computers claim it. Max 10 computers
  per person. Computers from before the migration have no owner: they are invisible, and since phase 2 the worker
  routes refuse them (401); re-add the computer in Claude › Setup.
- **Locked out of the authenticator app** (no passkey, no backup code): in Mongo delete the user's `twoFactor` doc
  and set `user.twoFactorEnabled` to false. Password reset still needs working email.

## Environment

| Variable | What |
|---|---|
| `BETTER_AUTH_SECRET` | 32+ characters; signs cookies, hashes tokens. `SESSION_SECRET` is read if it is missing. Without either, every page answers 503 |
| `APP_URL` | base URL: cookies, passkey domain, reset and invitation links (else `https://$VERCEL_PROJECT_PRODUCTION_URL`) |
| `EMAIL_*` | SMTP for reset, invitation and test mail |
| `OWNER_EMAIL`, `OWNER_NAME` | the migration script only |
| `AUTH_RATE_LIMIT` | `off` only in tests |
| `TRUST_PROXY` | `1` when a proxy we control (Vercel, our nginx) sets `X-Real-IP` / `X-Forwarded-For`; without it, per-IP limits use one shared bucket |
| `APP_URL` (again) | is also the OAuth issuer (`<APP_URL>/api/auth`) and resource (`<APP_URL>/api/mcp`): it must be the public address people type into Claude, https in production. No other new variable |
| `MCP_ALLOW_URL_TOKEN` | `1` allows `/api/mcp/<Claude chat key>` |
| `INVITE_LINK_TO_INVITER` | unset or `1` (default): whoever invites also sees the invitation link. `0`: the link goes only by email, so an owner or admin can't open it and claim the invitee's account; inviting then needs working email (`lib/members.ts` `inviteLinkToInviter`) |
| `MAIL_CAPTURE_DIR` | tests: write mail as JSON files instead of sending |

Tests: `tests/e2e/oauth.mjs` (OAuth sign-in, above), `tests/e2e/auth.mjs` (sign-in, 2FA, reset by email, invitations, other organizations, keys, a sweep of every
page and API route without credentials) and `tests/e2e/team.mjs` (roles, the last owner, removal). The e2e seed makes
a test owner, organization and Claude chat key per run.
