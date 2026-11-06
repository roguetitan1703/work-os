# Calendar subscription (one-way ICS feed)

Part of Akash's asks (Work OS #165). Each signed-in person can make a private link that Google Calendar, Outlook or
Apple Calendar subscribe to. It shows that person's own tasks with a due and/or start date. It is read-only: Work OS
never reads or writes the calendar.

## What it is

- Settings > Connections > **Calendar**: Create link, Copy, Rotate, Turn off. One link per person per organization.
- The link is `<APP_URL>/api/calendar/<token>.ics`. Anyone holding it can read the feed, so treat it like a password.
- Not in this change: two-way Google Calendar sync per person (Sign in with Google, write events). That is a separate
  later ask and needs a Google Cloud OAuth client from Om.

## Token handling

- 32 random bytes (43 characters, base64url). Only its SHA-256 is stored (`calendarFeeds`, `_id` = `orgId:userId`,
  unique index on `hash`), like API keys. The link is shown once, when it is created or rotated; it cannot be shown again.
- Rotate: a new token replaces the hash in one write, so the old link stops at once. Turn off: the row is deleted.
- Leaving or being removed from the organization deletes the row (`releaseAccess`, lib/members.ts). The feed also
  re-checks membership on every request, so a missed delete still answers 404.
- A bad, malformed, rotated or revoked token answers `404 Not found` with no other detail. Same answer for all of them.
- Rate limit: per client address (TRUST_PROXY rules, lib/auth.ts), more than 20 misses in a minute answers `429` until
  the minute passes. In memory per process, like /api/worker.
- No session or cookie is needed or sent. The route is exempt from proxy.ts' session check (it checks its own token).
  The path is never logged: Usage counts it as `/api/calendar/[file]`.
- Headers: `Content-Type: text/calendar; charset=utf-8`, `Cache-Control: private, no-store` (a revoked link must stop
  at once; calendar apps poll every few hours anyway), `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`.

## What is in the feed

Tasks in the person's organization that are **open** (Not Started, In Progress, Blocked), not archived, have a due and/or
start date, and are **assigned to them or owned by them**, read through the same door as everything else
(`scoped()`, lib/scope.ts): never another person's private task, never a task of a project shared with chosen people
they are not on, never another organization's task.

- **Done and Dropped tasks are left out** (the calendar shows what is still to do; a finished task disappears at the
  next refresh).
- All-day events. Only a due date: that day. Only a start date: that day. Both: a span from start to due (inclusive).
  If start is after due, the due day alone is used.
- Event text: summary `#12 Title`, description `Status: In Progress` and a link back to the task, `URL` the same link.
  Priority maps to the iCalendar priority. **Not included:** notes, description, comments, checklist, links, tags,
  people's names, project names.
- All-day events carry no time, so they land on the right date in any timezone. The calendar's `X-WR-TIMEZONE` is the
  person's own timezone (Settings > Notifications, else the server default).
- Event ids are stable (`<task id>@work-os`), so a calendar updates an event in place when the task changes.
- Capped at 2000 events.

## Files

`lib/calendar-feed.ts` (token and rate limit), `lib/calendar-ics.ts` (ICS text), `lib/data/calendar.ts` (the tasks),
`app/api/calendar/[file]/route.ts`, `app/(app)/settings/calendar-section.tsx` and `calendar-actions.ts`,
`tests/e2e/calendar.mjs`.
