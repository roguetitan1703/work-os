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
- **Settings › Members:** who is in the organization. Owners and admins invite by email; only an owner can invite an
  owner. The invitation email holds `/accept-invitation/<id>?t=<secret>`, valid 7 days, once. If email is not set up
  the link is shown to copy. The invited person picks a name and password there and lands on Today; someone who
  already has an account signs in first and clicks *Join*. Sign-up is otherwise closed.
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
4. Make a Claude chat key and update the claude.ai connector; make Claude Code keys; re-add each computer and put
   the new `wkr_` key in the worker config. Settings shows this as a notice until dismissed.

## For Claude Code

| File | What |
|---|---|
| `lib/auth-server.ts` | the Better Auth instance (`getAuth()`), plugins: organization, twoFactor, passkey, apiKey, nextCookies (last) |
| `lib/auth.ts` | light helpers with no Better Auth import: `authSecret()`, `appBaseUrl()`, cookie prefix `workos`, `SafeError` |
| `lib/caller.ts` | `getCaller()` → `{userId, orgId, role, email, name, via, key?}`; `requireCaller(...roles)`, `withCaller`, `asCaller`, `callerFromRequest`, `verifyKey` |
| `lib/members.ts` | members list, invite, cancel, view and accept invitations |
| `lib/api-keys.ts`, `lib/devices.ts` | Claude keys on the apiKey plugin (`metadata: {agent, orgId}`); worker devices with `ownerId`/`orgId` |
| `app/api/auth/[...all]/route.ts` | Better Auth over HTTP, **allowlist only**: sign-in, sign-out, session, reset, change password, sessions, two-factor, passkeys, organization reads, set-active, cancel-invitation. Sign-up, API keys, organization create and invite are 404: server code calls `auth.api.*` directly |
| `proxy.ts` | session via Better Auth's cookie cache; a Claude chat key passes on API routes |
| `scripts/migrate-auth.mjs`, `scripts/lib/auth-admin.mjs` | the migration; a script-side Better Auth for creating users, organizations and keys (also used by the e2e seed) |

- **Every request knows who.** Server actions use `requireCaller()` + `withCaller()` (or `asCaller(fn)`), API routes
  `callerFromRequest(req)`, MCP and worker routes their key. The caller's `userId` goes into the request context and
  every history entry gets `actorUserId` next to `actor`.
- **Proxy cost:** the signed `workos.session_data` cookie (compact, 120 s) is checked without a database read. When
  it is stale the proxy calls `getSession` once and forwards the refreshed cookies. So a revoked session or removed
  member can keep opening pages for up to 2 minutes; server actions and `getCaller()` read the session from the
  database. `/api/worker`, `/api/mcp`, `/api/cron`, `/api/discord/interactions` and `/api/auth` check their own
  credentials. Public pages: `/login`, `/login/reset`, `/accept-invitation/<id>`.
- **Keys:** `wos_` + 48 characters, hashed by the plugin; `verifyKey` also requires the owner to still be a member of
  the key's organization (roles cached 60 s per instance). The plugin's own HTTP endpoints are not served. The URL
  form `/api/mcp/<key>` still needs `MCP_ALLOW_URL_TOKEN=1` and accepts only Claude chat keys. Rate limits and the
  rules in `lib/mcp/policy.ts` are unchanged; the `confirm` token HMAC now uses `BETTER_AUTH_SECRET`.
- **Invitations:** Better Auth's invitation id is listable by admins, so the link also carries a secret whose SHA-256
  is in `invitation.tokenHash`; accepting swaps `pending` → `accepted` atomically before the account is made.
- **Reset tokens** are stored hashed (`verification.storeIdentifier`, hashed for `reset-password:`). Mail: `lib/mail.ts`
  `sendMail({to, …})`, per-recipient and global hourly slots in `mailLog`.
- **Rate limits:** Better Auth's, in the database, tighter for sign-in, two-factor, reset and change-password.
  `AUTH_RATE_LIMIT=off` turns them off (the e2e runner only).
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
| `MCP_ALLOW_URL_TOKEN` | `1` allows `/api/mcp/<Claude chat key>` |
| `MAIL_CAPTURE_DIR` | tests: write mail as JSON files instead of sending |

Tests: `tests/e2e/auth.mjs` (sign-in, 2FA, reset by email, invitations, other organizations, keys, a sweep of every
page and API route without credentials). The e2e seed makes a test owner, organization and Claude chat key per run.
