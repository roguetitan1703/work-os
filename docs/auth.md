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
| `app/api/auth/[...all]/route.ts` | Better Auth over HTTP, **allowlist only**: sign-in, sign-out, session, reset, change password, sessions, two-factor, passkeys, organization reads, set-active. Sign-up, API keys, organization create, invite and cancel-invitation are 404: server code calls `auth.api.*` directly |
| `proxy.ts` | session via Better Auth's cookie cache; a Claude chat key passes on API routes |
| `scripts/migrate-auth.mjs`, `scripts/lib/auth-admin.mjs` | the migration; a script-side Better Auth for creating users, organizations and keys (also used by the e2e seed) |

- **Every request knows who.** Server actions use `requireCaller()` + `withCaller()` (or `asCaller(fn)`), API routes
  `callerFromRequest(req)`, MCP and worker routes their key. Since phase 2 every data call takes the caller's scope
  and history records the actor as an object with its user (`{kind:'agent', agent:'claude', userId}`; see
  docs/multi-user.md "As built").
- **Proxy cost:** the signed `workos.session_data` cookie (compact, 120 s) is checked without a database read. When
  it is stale the proxy calls `getSession` once and forwards the refreshed cookies. So a revoked or signed-out session
  can keep opening pages (and GET routes) for up to 2 minutes; a removed member cannot (their role is read on every
  request, and removal clears the role cache). Server actions and POST routes read the session from the database
  (`callerFromHeaders`; until the leak audit they used the cookie cache too, so a cookie copied before sign-out could
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
| `MCP_ALLOW_URL_TOKEN` | `1` allows `/api/mcp/<Claude chat key>` |
| `INVITE_LINK_TO_INVITER` | unset or `1` (default): whoever invites also sees the invitation link. `0`: the link goes only by email, so an owner or admin can't open it and claim the invitee's account; inviting then needs working email (`lib/members.ts` `inviteLinkToInviter`) |
| `MAIL_CAPTURE_DIR` | tests: write mail as JSON files instead of sending |

Tests: `tests/e2e/auth.mjs` (sign-in, 2FA, reset by email, invitations, other organizations, keys, a sweep of every
page and API route without credentials) and `tests/e2e/team.mjs` (roles, the last owner, removal). The e2e seed makes
a test owner, organization and Claude chat key per run.
