# Session messaging across accounts and platforms (design, 18 Nov 2026)

Om 18 Nov: "I want cross-platform, cross-account messaging, just how Claude sessions in the same account can do it."
Today a Work OS project message reaches a session only at `start_work` or on its next Work OS call (the `forYou` line).
A session in the middle of a conversation never sees it arrive (Om's test message from Claude chat, 18 Nov 16:09, sat
unread until the session was told to look).

## Idea
Work OS is the post office (identity, projects, threads, the labelling rule); each Claude Code session carries a small
Work OS plugin as its mailbox. Identity is Work OS's, not Claude's, so any Claude account with a Work OS key can send and
receive. Sending exists (`send_message`, `reply`, the Inbox tab). Delivery into a running session is the missing half.

## Delivery, per surface
| Where the session runs | Route | When |
|---|---|---|
| Claude Code, any surface (terminal, VS Code, desktop Code tab) | Plugin hook after each tool call (PostToolUse) adds new messages to context | Within seconds while working |
| Claude Code terminal, idle | Channel: the plugin's local stdio server pushes `notifications/claude/channel` | At once |
| Claude Code elsewhere, idle | The wait line (docs/flows/step-4.md section 6): a background command that ends on an event | At once |
| claude.ai chat, other AIs | `forYou` on their next call | Next call |
| People | Inbox tab, phone push, Discord | At once |

Channels (code.claude.com/docs/en/channels.md, checked 18 Nov): research preview; local stdio only; documented for the
terminal only; a custom channel needs `--dangerously-load-development-channels` (a confirmation each start) until it is
in the official allowlist; Team/Enterprise owners must enable Channels in org settings. So channels are an extra for
idle terminal sessions, not the main route.

## Plan
1. Check by hand: a test PostToolUse hook injects a fake message into a desktop Code tab session and a VS Code session.
2. Work OS plugin (one install per PC): SessionStart -> `start_work`; PostToolUse -> new messages for this session
   (one short HTTP call with a 1 s timeout, at most every 20 s, ids from the presence cursor so each is shown once);
   reply through the existing `reply` tool. Text from others arrives labelled as information, never orders; an agent's
   message never approves shipping, money or credentials (the rule `inbox` already applies).
3. Addressing: to a project (every session on it), to one session by label, or to a person (their sessions + phone).
4. Idle routes: the channel for terminal sessions; the wait line for the rest.

Open: a Fable review of this design before step 2.
