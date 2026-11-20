import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { MongoClient, type ClientSession, type Db, type Collection, type IndexDescription } from 'mongodb';
import type { CodeLocation, TaskSource, Activity, Actor, ActivityType, FieldChange, ProjectStatus, Mode, Priority, Status, ChecklistItem, Link, Recurrence, Visibility, WeeklyReview, RoutineLog } from './types';
import { asActor } from './actors';

// ── Ownership (docs/multi-user.md, phase 2) ──
// Every stored document carries orgId. Documents that belong to one person carry ownerId (or userId: the recipient of
// a notification, push device, alert). Shared things carry visibility (and, for 'members', sharedWith): a project's,
// which its tasks, notes, Claude items, history and trash entries copy. Queries go through lib/scope.ts, which adds
// orgId and the visibility rule.
/** Fields of a document that lives in the shared space of an organization (project, task, note, ...). */
export type Placed = { orgId: string; ownerId: string; visibility: Visibility; /** visibility 'members': who sees it (always holds the project's owner). */ sharedWith?: string[] };

// ── Document shapes as stored in MongoDB ────────────────────────────────────

export type TaskDoc = Placed & {
  _id: string;
  ref: number;
  /** Get the task's alerts (when the task is shared); else the owner does. Read through assigneesOf (lib/assignees.ts). */
  assigneeIds?: string[];
  /** Before several assignees: the one assignee. Read only (scripts/migrate-assignees.mjs moves it into assigneeIds). */
  assigneeId?: string | null;
  title: string;
  description: string;
  mode: Mode | null;
  projectId: string | null;
  priority: Priority;
  status: Status;
  tags: string[];
  due: string | null;
  start: string | null;
  estimateMins: number | null;
  progress: number;
  checklist: ChecklistItem[];
  links: Link[];
  blockedReason: string;
  /** Who wrote the title, description, blocked reason and tags (lib/data/authors.ts); missing on older tasks. */
  titleBy?: import('./actors').TextAuthor;
  descriptionBy?: import('./actors').TextAuthor;
  blockedReasonBy?: import('./actors').TextAuthor;
  tagsBy?: import('./actors').TextAuthor;
  dependsOn: string[];
  recurrence: Recurrence | null;
  nextRef: number | null;
  /** Slice 5: the kind of result, the last hand_in, the owner's send-back line and the review record. */
  resultKind?: import('./types').ResultKind | null;
  handIn?: Omit<import('./types').HandIn, 'at'> & { at: Date };
  sentBack?: { line: string; by: string; at: Date };
  review?: { sentBack: number; outcome?: 'accepted_first_time' | 'accepted_after_send_back'; at?: Date };
  archived: boolean;
  createdBy: Actor;
  /** The session or key that made it (the "for you" line does not tell a session about its own items). */
  src?: string;
  createdAt: Date;
  updatedAt: Date;
  doneAt: Date | null;
  doneOn: string | null;
  doneBy: Actor | null;
  source?: TaskSource;
  /** Dispatcher (docs/dispatcher.md). Set only by the UI actions and the dispatcher itself, never by a task write from MCP or Discord. */
  claude?: ClaudeMark | null;
  /** Subtasks (docs/subtasks.md): the parent's id, with its ref and title copied for the rows (kept in step on rename). */
  parentId?: string | null;
  parentRef?: number;
  parentTitle?: string;
  /** On a parent: its subtasks done and counted, recomputed with its progress whenever one changes. */
  subtaskCount?: import('./types').SubtaskCount;
  /** The open Need on this task, if any (lib/data/needs.ts keeps it in step; rows show it instead of the percent). */
  need?: import('./types').TaskNeed;
};

/** A task a person gave to Claude. */
export type ClaudeMark = {
  state: 'queued' | 'running' | 'finished' | 'stopped' | 'failed';
  markedAt: Date;
  markedBy: 'user';
  /** The signed-in person who gave it to Claude: only their own computers claim it (docs/auth.md). */
  markedByUserId?: string;
  markedByOrgId?: string;
  /** Which linked folder, when the project has more than one (a workerFolders _id). */
  folderKey?: string;
  sessionId?: string;
  deviceId?: string;
  claimedAt?: Date;
  endedAt?: Date;
  /** Why it stopped or failed. */
  note?: string;
  /** Status to restore on failed / requeue. */
  prevStatus?: Status;
  /** Times the reconciler rolled a claim back (3 is the limit). */
  attempts?: number;
  /** H15: 1 once a session that ended on its own was started again (once per mark: the second time the giver chooses, a Need). */
  revived?: number;
};

/**
 * One row of the change feed. A task row carries taskId (and moves with its task: placeTasks, setProjectPlacement, the
 * trash). Every other row carries `subject` and the subject's own placement, copied when it is written, and moves with
 * it: rows with a taskId (a task's note) with the task; rows without one with their project (setProjectPlacement, by
 * projectId) or, for Needs, with the Need (restampTaskNeeds). listActivity also drops any row whose subject the reader
 * cannot read now (readableRows in lib/data/tasks.ts).
 */
export type ActivityDoc = Placed & {
  _id: string;
  taskId?: string;
  taskRef?: number;
  taskTitle?: string;
  /** Rows without a taskId: the project they belong to (their placement follows it). */
  projectId?: string;
  subject?: import('./types').ActivitySubject;
  /** The author of `note` when it is not the actor (a user id). */
  textBy?: string;
  /** The author of the subject's title (a renamed project: of its old name) when it is not the actor (a user id). */
  titleBy?: string;
  at: Date;
  actor: Actor;
  type: ActivityType;
  changes?: Record<string, FieldChange>;
  note?: string;
  /** Only `feedback` and `session_ended` rows (H10). */
  feedback?: import('./types').FeedbackInfo;
  /** Claude Code session / repo headers (lib/request-context.ts). */
  session?: string;
  repo?: string;
};

export type ProjectDoc = Placed & {
  _id: string;
  name: string;
  nameLower: string;
  client: string;
  description: string;
  status: ProjectStatus;
  /** Where its code lives: git remotes (owner/name, optional subdir/branch) or folder paths. */
  code?: CodeLocation[];
  /** The member who last named it (created or renamed it; lib/data/authors.ts). Missing on older projects. */
  nameBy?: string;
  /** Who last set its code locations (turbo mode trusts a clone only when the PC's owner did; missing = its owner). */
  codeBy?: string;
  /** Whether a code remote is public on GitHub, from one anonymous check (lib/data/repo-visibility.ts); cleared when `code` changes. */
  /** true public, false private, null unknown (GitHub did not answer); see lib/data/repo-visibility.ts for how long each is kept. */
  repoPublic?: boolean | null;
  repoPublicAt?: Date;
  /** What counts as this project's production for the Work OS hook (lib/data/production.ts); unset = the default from `code`. Set in the app only. */
  production?: { remotes: string[]; branches: string[]; targets: string[]; off?: boolean };
  /** Nudges (lib/data/nudges.ts): false = Work OS does not nudge sessions of this project (the turn-end check, the idle nudge, the Declutter nudge). Unset = on. Set in the app only. */
  nudges?: boolean;
  /** Context warning (lib/data/context-warn.ts): the line in k tokens (150 or 200) after which the pre-tool hook tells an agent of this project to write a code-map note and stop. Unset = off. Set in the app only. */
  contextWarn?: 150 | 200;
  /** Discord channel (lib/discord/issues.ts): where this project's posts and tracked messages are. `everyPost`: each post is an issue. `after` is the last message id read (the catch-up starts there); `backfilledAt` is set once the first 7 days were recorded. Set in the app only. */
  discordChannel?: { channelId: string; name: string; everyPost: boolean; after?: string; backfilledAt?: Date; setBy: string; setAt: Date };
  /** Who last set `production`. */
  productionBy?: string;
  /** The Delpat OS project it was imported from (lib/delpat-os.ts); unique per organization among shared projects, per owner among private ones. */
  delpatOsId?: string;
  createdAt: Date;
  updatedAt: Date;
};

/** A person's link to Delpat OS: tokens sealed with AES-256-GCM (lib/delpat-os.ts). _id `<orgId>:<userId>`. */
export type DelpatOsLinkDoc = { _id: string; orgId: string; userId: string; refresh: string; access: string | null; accessExpiresAt: Date | null; createdAt: Date; updatedAt: Date; /** Lease: a refresh is in progress until then (lib/delpat-os.ts). */ refreshingUntil?: Date | null };
/** A link in progress: the state (hashed) with its sealed PKCE verifier; deleted when used, expires after 10 minutes. */
export type DelpatOsAuthDoc = { _id: string; orgId: string; userId: string; verifier: string; expiresAt: Date };
/** Connect Mailloom in progress (lib/mail/connect.ts): _id sha256(state), bound to the person, organization and session; PKCE verifier sealed; single use; 10 minutes. */
export type MailConnectAuthDoc = { _id: string; orgId: string; userId: string; sessionId: string; verifier: string; expiresAt: Date };

/** Reviews from before phase 3 kept their answers as fields (shipped, slipped, …); lib/data/reviews.ts reads both. */
export type ReviewDoc = Omit<WeeklyReview, 'id' | 'answers'> & { _id: string; orgId: string; ownerId: string; answers?: WeeklyReview['answers'] } & Record<string, unknown>;
/** A day's routine log. `bidsPlaced` is the count's name from before phase 3. */
export type RitualDoc = Omit<RoutineLog, 'id' | 'count'> & { _id: string; orgId: string; ownerId: string; count?: number; bidsPlaced?: number };
/** _id `<name>:<orgId>` (task and Claude item numbers per organization). */
export type CounterDoc = { _id: string; seq: number; orgId: string };
/**
 * One ask to one person (docs/flows/plan-1-3.md slice 4). Stamped with its project's placement like a task (the door
 * filters by the document's own ownerId / visibility / sharedWith) and moved with the project (setProjectPlacement).
 */
export type NeedKind = 'decide' | 'approve' | 'review' | 'do' | 'chase';
export type NeedWord = 'person' | 'chat' | 'agent';
export type NeedStatus = 'open' | 'answered' | 'withdrawn' | 'replaced';
export type NeedOption = { id: string; label: string; means: string };
export type NeedDoc = Placed & {
  _id: string;
  /** The Discord DM for a Need that waited over a day was sent (once; lib/alerts.ts dmOldNeeds). */
  discordDmAt?: Date;
  /** Per organization, like a task number. */
  ref: number;
  projectId: string;
  taskId: string | null;
  taskRef: number | null;
  /** The one person asked (a user id). */
  to: string;
  /** Who asked: the actor, the trust word (set by the server from how the call came in) and the session's own label. */
  from: { actor: Actor; word: NeedWord; session?: string; /** The API key or OAuth client behind the ask (a later call without a session id is matched by it). */ keyId?: string; label?: string };
  kind: NeedKind;
  ask: string;
  example?: string;
  options: NeedOption[];
  status: NeedStatus;
  /** Answered in the app only (production, money, credentials): never from Discord. */
  appOnly: boolean;
  answer?: { option: string; text?: string; by: string; via: 'app' | 'phone' | 'discord' | 'chat'; at: Date };
  createdAt: Date;
  /** When it was answered; with waitedMs, how long the person took (the scorecard reads them). */
  answeredAt: Date | null;
  waitedMs?: number;
  closedAt?: Date | null;
  replacedBy?: string;
  /** start_work handed the answer to the asker's session (so a later brief does not repeat it). */
  briefedAt?: Date;
  /** The asking session was off when the answer came: the answer went to this session of the same person (the Now holder, or the one whose start_work listed it). */
  handedTo?: string;
  /** A review Need: what the agent handed in (hand_in), or just its summary. */
  result?: import('./types').HandInResult;
  /** Accept and file what is left: the numbers of the tasks made from the left lines. */
  filed?: number[];
  /** Closed by the system, not by a person: 'moved' (its task moved where the addressee cannot read it) or 'access' (they lost access). */
  withdrawnReason?: string;
  /** When an alert for this Need (or the one it replaced) was last queued: a replacement within 10 minutes of it sends none. */
  alertedAt?: Date;
  /** No alert was queued for it (a proposal of Orders). Older review Needs made past an hourly alert limit carry it too. */
  noAlert?: boolean;
  /** Part of the owner's Monday digest (H12): a Need that waits for it and never reaches the phone. Server-only; set by propose_order and declutter. */
  batch?: 'monday';
  /** A correction a person gave twice (H12 counts it among Om's repeats). Server-only. */
  repeat?: true;
  /** A review Need made because an agent wanted to drop or archive the task: what Accept then does (default: close it as Done). */
  closing?: 'Dropped' | 'archived';
  /**
   * A proposed change of Orders (propose_order, lib/data/orders.ts proposeOrder): Accept writes `new` over `old` (or appends it)
   * as the holder, one version, once. `applied` is set by the Accept: the version it made, or why it could not.
   */
  order?: { noteId: string; layer: 'org' | 'project'; base: number; old?: string; new: string; why: string; incident?: string; repeat?: boolean; applied?: { v: number } | { error: string } };
  /** A release Need (an approve Need made with release: true): Yes or Yes for 24 hours opens production on the project until releaseUntil. */
  release?: true;
  releaseUntil?: Date;
  /** H15: a dispatcher Need ("Claude stopped on #ref": give it to Claude again, or take it back): the task it is about. The answer acts as the giver, whose Need it is. */
  dispatch?: { taskId: string; result?: string };
  /** A declutter Need (an approve Need with fixed options, lib/data/declutter.ts): the proposed changes, what the session will do on disk after Yes, what the person unticked and what the server did. */
  declutter?: DeclutterNeed;
};
export type DeclutterNeed = { items: import('./declutter-core').DeclutterItem[]; disk: string[]; skip?: string[]; result?: { applied: string[]; failed: string[] } };

export type ClaudeItemDoc = Placed & Omit<import('./types').ClaudeItem, 'id' | 'ownerId' | 'createdAt' | 'updatedAt' | 'doneAt' | 'claimedBy' | 'log'> & {
  _id: string;
  createdAt: Date;
  updatedAt: Date;
  doneAt: Date | null;
  claimedBy: { session: string; at: Date } | null;
  log: { at: Date; actor: Actor; session?: string; text: string }[];
  /** Claude Code key that created it (for the per-day cap). */
  keyId?: string;
  /** Set when a Declutter moved the item: "#123" (a task) or "later:l_..." (a Later line). */
  movedTo?: string;
  /** The project's "Small fixes and checks" item (not counted toward the cap; title/kind fixed). */
  group?: true;
};
export type NoteDoc = Placed & {
  _id: string;
  title: string;
  /** Editor blocks (source of truth). Missing on notes written before the block editor; derived from body then. */
  blocks?: unknown[];
  body: string; // markdown, derived from blocks (search, previews, Claude)
  /** Sub-page: the note this page lives in. */
  parentId?: string | null;
  /** Standing rules served to every AI that starts work (lib/data/orders.ts): which layer this note is, if any. Set in the app only. */
  orders?: 'org' | 'project' | 'person';
  /** Who set the Orders flag (the holder of the layer). A person-layer note is served only when this equals its owner and the reader. */
  ordersBy?: string;
  /** Version of an Orders page (lib/data/orders.ts); absent reads as 1: the text found at the time versions began is the base. */
  ordersV?: number;
  /** Earlier versions of an Orders page, newest last, at most 20. Never read by list or search reads, never output raw. */
  ordersLog?: OrdersVersion[];
  taskId: string | null; // task note (at most one live per task)
  projectId: string | null; // project note (when taskId is null)
  archived: boolean;
  /** Which shelf a top-level project note sits on (lib/notes-shelves.ts shelfOf gives the default). Never set on a task's note or a sub-page. */
  shelf?: 'overview' | 'designs' | 'runbooks' | 'handovers';
  /** Set on a handover (lib/data/handovers.ts): the note a session leaves for the next one. */
  handover?: HandoverMeta;
  createdBy: Actor;
  createdAt: Date;
  updatedBy: Actor;
  updatedAt: Date;
  deletedAt: Date | null;
  deletedBy?: Actor;
};

/**
 * One change of an Orders page: v is the version it made, `before` the whole text it replaced (for undo), removed and
 * added the changed rule lines (for readers). A person's autosaves within ten minutes fold into one entry.
 */
export type OrdersVersion = {
  v: number;
  at: Date;
  by: Actor;
  session?: string;
  label?: string;
  why?: string;
  before: string;
  removed: string[];
  added: string[];
  /** The Need whose Accept made this version. */
  need?: number;
  /** This version undid version N. */
  undoOf?: number;
  /** A session was told of this version (brief, delivery or its ack): a later autosave starts the next version instead of folding into it. */
  delivered?: boolean;
};

/** What a session leaves when it stops (end_work): the fields the writer gave, each capped (lib/data/handovers.ts). */
export type HandoverFields = { step: string; in_flight?: string[]; tried?: string[]; rules?: string[]; check?: string[] };
/**
 * A handover's own record. `by` = the writer's user id; `for` = a user id or 'anyone'; `session` = the writing session.
 * `pickedUp` = the first session that was shown it (start_work).
 */
export type HandoverMeta = {
  by: string;
  for: string;
  session?: string;
  label?: string;
  /** When its writer wrote (or rewrote) it: the pick-up hold limit counts from here, never from the note's updatedAt (a reader's edit or the pick-up line moves that). Rows from before: the note's createdAt. */
  at?: Date;
  fields: HandoverFields;
  pickedUp?: { session: string; label?: string; at: Date; by: string };
};

/** A line of a project's State (Next, Later): `by` is who wrote it (a user id), shown labelled to everyone else. */
export type StateLine = {
  id: string; text: string; ref?: number; waitsOn?: string; by: string; src?: string; at: Date;
  /** Parked lines only: "bring back when". */
  when?: string;
  /** Lanes: the session that holds the line (key = presence row key); a hold from set_doing is derived at read from presence `doing`. */
  hold?: { key: string; at: Date };
  /** Lanes: set when a hold was released because its session left (label of the session, where it stood). */
  left?: { label: string; branch?: string; head?: string; log?: string; at: Date };
};
/** A Next or Later line taken off the State with its text kept (archive_line, a removed Later line, Declutter). `by`/`at` are the line's own; `archivedBy`/`archivedAt` say who took it off and when. */
export type ArchivedLine = { id: string; text: string; from: 'Next' | 'Later' | 'Parked'; waitsOn?: string; by: string; at: Date; archivedBy: string; archivedAt: Date; why?: string };
/** What the daily Declutter check found on a project (lib/data/declutter.ts); written without a version bump, like `where`. */
/** `reviewedAt` and the two counts: the last size review (declutter reviewed: true); size makes a project due again only after 10 more lines. */
export type DeclutterCache = { checkedAt: Date; reasons: string[]; quietUntil?: Date; needId?: string; needRef?: number; reviewedAt?: Date; reviewedLater?: number; reviewedNext?: number };
/** A decision recorded on a project (append-only). `by` = who decided (a user id), `via` = chat / code / app / discord. */
export type StateDecision = { id: string; at: Date; by: string; src?: string; via: string; text: string; archivedAt?: Date; /** The key that recorded it (the hourly limit counts per key). */ key?: string; /** The message it was applied from, who wrote that message and how it came in; `by` is who applied it. */ msg?: string; author?: string; word?: string };
/** One Parked line as its own row (collection `stateParked`), placed like its project. `at` is the line's own date; `parkedAt` is when it was parked (the sort key). */
export type StateParkedDoc = Placed & { _id: string; projectId: string; id: string; text: string; when?: string; ref?: number; waitsOn?: string; by: string; src?: string; at: Date; parkedAt: Date; /** The key that parked it, and the caller (user id) who did: the hourly limit counts by them. */ key?: string; parkedBy?: string };
/** One decision as its own row (collection `stateDecisions`), placed like its project. An archived decision keeps its row with `archivedAt`. */
export type StateDecisionDoc = Placed & StateDecision & { _id: string; projectId: string; archivedBy?: string };
/** Where the work is on one machine, as the agent reported it from git. */
export type StateWhere = { branch?: string; head?: string; dirty?: boolean; worktrees?: string[]; at: Date; by: string };
/** The project's live memory (docs/flows/step-1.md): one per project, `_id` = the project id, stamped with the project's placement. */
export type StateDoc = Placed & {
  _id: string;
  projectId: string;
  /** `holder` is the legacy form (read only); `hold` is the Now holder: key = presence row key. */
  now: { text: string; holder?: string; hold?: { key: string; label: string; at: Date }; by: string; at: Date } | null;
  next: StateLine[];
  later: StateLine[];
  /** Legacy: moved to `stateParked` rows on first touch (lib/state-lists-move.ts); never written. */
  parked?: StateLine[];
  /** Legacy: moved to `stateDecisions` rows on first touch; never written. */
  decisions?: StateDecision[];
  /** How many Parked rows and live (not archived) decision rows the project has; the rows hold the text. Missing on a State not moved yet. */
  parkedCount?: number;
  decisionsCount?: number;
  where: Record<string, StateWhere>;
  /** Lines taken off Next or Later, text kept, put back from the State card (the newest 300). */
  archived?: ArchivedLine[];
  declutter?: DeclutterCache;
  /** The last 200 ops with who made them (user, key, session): so a changed Now or a done Next line can be traced. Not shown to readers. */
  log?: { at: Date; by: string; key?: string; src?: string; via: string; op: string; id?: string }[];
  /** Bumped on every write. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
/**
 * A message to a project (docs/flows/step-1.md section 4), stamped with the project's placement: every reader of the
 * project can read it. `word` is how it came in, set by the server and never by the caller: person (the app), chat (the
 * claude.ai connector, which may be unattended), agent (a key).
 */
export type MessageDoc = Placed & {
  _id: string;
  /** Null: a message between two of one person's own sessions, one of which has no project (Identity step 6); it is placed private to that person. */
  projectId: string | null;
  /** A person the message is for (it shows under Messages for you on their Claude › Now; their sessions do not get it). Needs a project both read. */
  toUser?: string;
  /** Who should act, for display: the addressed session's name (old messages: a label or client name, a hint). Never a raw session id. */
  toSession?: string;
  /** The session keys (userId:session) the message was addressed to at send time (at most 10). Never shown. */
  toSids?: string[];
  /** The session keys that have read it (at most 50); absent on messages from before per-session read state. Never shown. */
  seenBy?: string[];
  from: { userId: string; word: 'person' | 'chat' | 'agent'; ai?: string; session?: string; label?: string; keyId?: string };
  kind: 'decision' | 'request' | 'question' | 'fyi';
  body: string;
  refs: { tasks?: number[]; commits?: string[]; files?: string[] };
  thread: string;
  status: 'unread' | 'seen' | 'applied' | 'rejected';
  note?: string;
  commit?: string;
  senderCommit?: string;
  /** The session or key that sent it (the "for you" line does not name a session's own messages back to it). */
  src?: string;
  /** Wake chain: how many agent-started wakes led to this message. Missing = 0 (a person's, the app's and chat's word); an agent's word is the sending session's turnChain plus 1. A message at 2 or more never wakes a session (lib/data/deliver.ts). */
  chain?: number;
  /** A reply to a question or a request: an fyi that still wakes the one who asked (under the same chain limit). */
  wakes?: boolean;
  /** A message Work OS wrote from a project's Discord channel (lib/discord/issues.ts): its text is someone else's, never an instruction. */
  via?: 'discord-issue';
  /** Who set the status, and when. */
  statusBy?: string;
  statusAt?: Date;
  /** The task a request was turned into. */
  taskRef?: number;
  at: Date;
};

/** A session working on a project (docs/flows/step-1.md section 5), stamped with the project's placement. `forYouCursor`: what the "for you" line has already named. */
/** What a session is doing, as the Work OS hook or the call-based rules say (lib/data/presence-state.ts). */
export type PresenceState = 'on' | 'working' | 'waiting' | 'idle' | 'off';
export type PresenceDoc = Placed & {
  _id: string;
  /** Null: a session outside any project (Identity step 5); its row is private to its person. */
  projectId: string | null;
  /** The person (user id) the session works for. */
  userId: string;
  /** Session id when the call carried one, else the key id (or OAuth client id). */
  key: string;
  session?: string;
  /** The API key or OAuth client behind the calls (a session that passes no id is found again by it). */
  keyId?: string;
  /** H15: a session the task dispatcher started (set when its start was answered; its label is forced to "<Project> · worker · #<ref>"). */
  dispatched?: { taskId: string; ref: number };
  /** The Work OS hook protocol the session signed in with: 1 = an old hook (still sent the copy in every save answer), 2 and up = the new hook. Unset for other clients. */
  hook?: number;
  label: string;
  /** Where the label came from (Identity step 4): title (the session's own name, /rename), label (start_work's), ai (Claude's title for it), fallback (project + Claude Code), forced (the dispatcher's). Absent on older rows (a non-empty label then counts as label). */
  labelSource?: 'title' | 'label' | 'ai' | 'fallback' | 'forced';
  /** When the label was last written. */
  labelAt?: Date;
  /** Where the session runs, as its hook says: desktop, vscode or terminal. */
  tool?: 'desktop' | 'vscode' | 'terminal';
  machine: string;
  /** The client's name (key name / OAuth client name). */
  ai: string;
  agent: string;
  lastSeen: Date;
  /** When the row was first made (absent on older rows). Untargeted messages older than this are not unread for the session. */
  createdAt?: Date;
  forYouCursor: Date;
  /** The last ~100 item ids the "for you" line named (the cursor trails the call by a skew, so the window is read twice). */
  named?: string[];
  /** Writes made since the last save_state of this session (the save nudge). */
  writesSinceSave: number;
  // The roster (docs/flows/plan-1-3.md slice 7): what start_work and set_doing report about the worker.
  model?: string;
  account?: string;
  /** The orchestrator's session id (for a builder). */
  parent?: string;
  /** The builder slot name (A, B, S ...). */
  slot?: string;
  /** The git branch it reported. */
  branch?: string;
  /** When machine resolved to one of the person's devices (machine is then its id): that device's name. */
  machineName?: string;
  /** The task the worker says it is on (set_doing): only its id. Its number and title are read through the scoped door when shown, so a viewer who cannot read the task sees nothing of it. */
  doing?: { taskId: string; at: Date };
  /** Lanes: the last result text a subagent of this session reported (own row only, 300 chars). */
  lastResult?: { text: string; at: Date };
  /** Lanes: sha1(machine + path) of the folder the session works in, never the path. */
  folderKey?: string;
  /** Lanes: the row this session's work moved to (pickup); followed at most 3 hops. */
  movedTo?: string;
  /** Lanes: set once the sweep has moved this off session's Needs and messages on. */
  swept?: Date;
  /** Nudges: when a prompt event last reached the server for this session (typed or not), the last idle nudge handed out, how many today (nudgeDay, UTC YYYY-MM-DD). Counters only. */
  promptAt?: Date;
  /** Last active (presence-state.ts lastActive): the last prompt, tool use or turn end the hook reported, or a fresh start. Never a resume, an idle wait or an idle notification. */
  activeAt?: Date;
  nudgeAt?: Date;
  nudgeCount?: number;
  nudgeDay?: string;
  /** The state the Claude Code hook last reported (POST /api/agent/event; the server decides it from the event). Absent for sessions with no hook token. */
  activity?: { state: PresenceState; at: Date; /** prompt: a permission prompt in its terminal; question: its turn ended asking its person something (`ask`, the question, cleaned, at most 200 characters). */ why?: 'prompt' | 'question'; ask?: string; /** A Bash or PowerShell call began (tool-start) and no later event came: keeps the session working (presenceState). */ open?: boolean };
  /** The last Stop the hook counted (H12, the Monday numbers): were the changed files saved to the State, and was the session reminded first. Last stop wins. Counts only, never text. */
  stopCheck?: { files: 'saved' | 'unsaved'; reminded?: true; at: Date };
  /** WORK-STATE.md hand edits of this session (H12): refused (by the hook or the server), and forwarded to the State. Counts only. */
  copyEdits?: { refused?: number; forwarded?: number; /** Per UTC day (YYYY-MM-DD), so a week can be counted without the session's earlier life. */ days?: Record<string, { refused?: number; forwarded?: number }> };
  /** What the server last offered this session's hook to print (lib/data/deliver.ts): kept until the hook acknowledges it (`ack`) or the lease runs out. */
  offered?: { ids: string[]; needs: string[]; /** Orders versions offered as `ord:<noteId>:<v>`. */ orders?: string[]; mode: 'turn' | 'stop' | 'wake'; chain: number; at: Date; first: Date; tries: number; /** The text of the organization Orders short form, when the offer carried one. */ short?: boolean };
  /** The Orders version of each page this session was last told (start_work, an acknowledged delivery), by note id. */
  ordersSeen?: Record<string, number>;
  /** Wake chain (lib/data/deliver.ts): the chain of the message that woke this session's current turn; -1 after a person's prompt. A message it sends carries this plus 1. */
  turnChain?: number;
  /** When the server last handed this session a wake (a message or an answered Need pushed to it while idle). */
  wokeAt?: Date;
  /** Claude Code's own session UUID, only for the join with the worker daemon's session list. Never shown to anyone. */
  ccSession?: string;
  /** Set by end_work: the session said it stopped. The roster shows it as gone. A later start_work clears it. */
  endedAt?: Date;
};
/** Heavy-slot leases on one machine (lib/data/slots.ts): at most `cap` (default 2) holders, each with a lease end. _id = org:machine. Organization-wide on purpose: the cap is per machine across every session on it. */
export type SlotDoc = { _id: string; orgId: string; machine: string; kind: 'heavy'; /** The person whose machine it is (the device's owner, or whoever named a plain-name machine). Only they write it. */ ownerId: string; /** Last write; a TTL index removes a document untouched for a day. */ touchedAt: Date; cap?: number; holds: { h: string; session: string; userId: string; until: Date }[] };

export type AlertKind = 'due_tomorrow' | 'due_today' | 'overdue' | 'stalled' | 'never_started' | 'unblocked' | 'assigned' | 'claude_finished' | 'claude_stopped' | 'claude_stuck' | 'need' | 'digest';
/** Kinds sent from the alertQueue (event alerts) rather than found by the scheduled check. */
export type QueuedAlertKind = 'unblocked' | 'assigned' | 'claude_finished' | 'claude_stopped' | 'need';
/** One row per alert sent (key encodes task + occasion), so each is sent once. */
export type AlertLogDoc = { _id: string; orgId: string; /** Who it was sent to. */ userId: string; kind: AlertKind; taskId?: string; sentAt: Date; /** digest rows: the digest had nothing to say (claimed for the day, never sent). */ empty?: boolean };
/** Event alerts waiting for the next send (queued inside the write's transaction). */
export type AlertQueueDoc = { _id: string; orgId: string; /** Who gets it: the task's recipient, or the person who gave it to Claude. */ userId: string; kind: QueuedAlertKind; taskId: string; byTaskId: string; createdAt: Date; sentAt: Date | null; /** Dispatcher outcomes: the reason; assigned: who assigned it. */ detail?: string; /** kind 'need': the Need (taskId is then the Need's task, or '' when it has none). */ needId?: string };

/** Inbox-only notices that are not scheduled alerts. */
export type NoticeKind = 'claude_code_changes' | 'claude_mail_sent';
/** Everything with an on/off switch in Settings → Notifications. */
export type NotifyKind = AlertKind | NoticeKind;
/** In-app inbox: every alert delivered (plus test notifications). */
export type NotificationDoc = { _id: string; orgId: string; /** The recipient. */ userId: string; kind: NotifyKind | 'claude_waiting' | 'test' | 'security'; title: string; body: string; url: string; createdAt: Date; readAt: Date | null };
/** Web Push subscriptions, keyed by endpoint (one per device/browser). */
export type PushSubDoc = { _id: string; orgId: string; /** The person signed in when this device turned push on. */ userId: string; keys: { p256dh: string; auth: string }; device: string; createdAt: Date; updatedAt: Date };

/** A deleted task with its history, kept 30 days so it can be restored. */
export type TrashDoc = Placed & {
  _id: string; // task id
  ref: number;
  title: string;
  task: TaskDoc;
  activity: ActivityDoc[];
  deletedAt: Date;
  deletedBy: Actor;
  reason: string;
  /** The task's note, soft-deleted alongside it. */
  noteIds?: string[];
  /** A subtask that went to the trash with its parent (the parent's id): it comes back when the parent does. */
  withParent?: string;
};
/** App settings, one doc per area. `discord.blockedIds` = channel/category/thread ids Work OS must never read. */
/**
 * Per-person and per-organization settings (lib/scope.ts): _id `<area>:<userId>` (notify, dispatcher, alerts, status)
 * or `<area>:<orgId>` (discord). The older single docs (_id 'notify', ...) are renamed by scripts/migrate-ownership.mjs.
 * 'indexes' and 'authMigration' stay global.
 */
export type SettingsDoc = {
  _id: string;
  area?: string;
  orgId?: string;
  userId?: string;
  blockedIds?: string[];
  updatedAt?: Date;
  /** _id 'alerts': last scheduled run */
  lastRunAt?: Date;
  lastResult?: string;
  /** _id 'authMigration' (scripts/migrate-auth.mjs): keys and computers from before sign-in by user, to re-create once. */
  oldKeys?: { name: string; prefix: string }[];
  oldDevices?: { name: string; prefix: string }[];
  dismissedAt?: Date | null;
  /** dispatcher:<userId>: the person's switch and limits for the task dispatcher (docs/dispatcher.md). */
  enabled?: boolean;
  maxConcurrent?: number;
  boilerplateNoteId?: string;
  /** dispatcher:<userId>: true once the person set the switch themselves, or it was switched on for them when their first computer connected (once). */
  autoOnDone?: boolean;
  /** notify:<userId>: where this person's alerts go. */
  notify?: { channels?: Partial<Record<'push' | 'discord', boolean>>; kinds?: Partial<Record<NotifyKind, boolean>> };
  /** status:<userId>: when their Claude connector and Discord were last used. */
  lastMcpAt?: Date;
  lastDiscordAt?: Date;
  /** profile:<userId> (lib/profile.ts): timezone, quiet hours, the linked Discord account and a pending link code. */
  timezone?: string;
  quietStart?: number;
  quietEnd?: number;
  /** The hour (0-23, their zone) their daily digest is sent; missing = 9. */
  digestHour?: number;
  discordId?: string | null;
  /** The one-time state of a Connect Discord in progress (lib/discord/connect.ts): sha256 of it, and when it stops working (10 minutes). */
  discordConnect?: { hash: string; expiresAt: Date } | null;
  /** profile:<userId>: the person hid the Connect Discord card on Today (lib/discord/connect.ts). */
  discordCardHidden?: boolean;
  /** profile:<userId>: the person hid the first-run checklist on Today. */
  checklistHidden?: boolean;
  /** profile:<userId> (lib/whats-new-seen.ts): ids from lib/whats-new.ts the person dismissed or opened. */
  whatsNewSeen?: string[];
  /** profile:<userId> (lib/data/claude-usage.ts): when their Claude plan's week starts over (weekday 0 = Sunday, time 'HH:MM' in `tz`). */
  claudePlanReset?: { weekday: number; time: string; tz: string };
  /** mail:<userId> (lib/mail/keys.ts): the person's own Mailloom agent key, sealed, with its visible prefix and the mailbox it opens. */
  mail?: { sealed: string; prefix: string; email: string; savedAt: Date; /** Granted at Connect (lib/mail/connect.ts); absent for a pasted key. */ scopes?: string[]; keyId?: string; via?: 'connect' | 'paste' } | null;
  /** quietFolders:<userId> (lib/data/quiet-folders.ts): folders on a computer the person said are not Work OS (path stored through normalizePath; a folder covers its subfolders). */
  items?: { machine: string; path: string; at: Date }[];
  /** discord:<orgId>: the organization's Discord server (set by the operator). */
  guildId?: string | null;
  /** discord:<orgId>: the id of the :wos: track emoji uploaded to the server (lib/discord/track.ts). */
  trackEmojiId?: string | null;
  /** schedule:<userId> (lib/schedule.ts): the person's week, routine, review questions and own help text. */
  schedule?: unknown;
  /** modes:<orgId> (lib/modes.ts): the organization's modes of work. */
  modes?: unknown;
};

// ── Session launcher (docs/launcher.md) ──
/** A machine running the worker. Only the SHA-256 of its key (wkr_…) is stored. */
export type DeviceHooks = { version: string | null; events: number; stale: boolean; signIn: 'worker' | 'key' | null };
/** A downloaded worker's self-update (worker/update.mjs): when it last installed a signed release and from which version, and the last refusal or failure ("update refused: bad signature"). */
export type DeviceSelfUpdate = { updatedAt: Date | null; from: string | null; problem: string | null };
export type DeviceDoc = { _id: string; name: string; /** The signed-in user who created it, and their organization (docs/auth.md). Missing on devices from before. */ ownerId?: string; orgId?: string; hash: string; prefix: string; createdAt: Date; lastSeenAt: Date | null; revokedAt: Date | null; /** Set each time Replace key made a new key for this computer (history: when, and how many times). */ keyReplacedAt?: Date; keyReplacements?: number; worker?: { version: string; os: string; /** First 12 hex of the sha256 of the downloaded worker bundle (absent when run from the repo). */ bundle?: string; /** The worker passes a first message to Claude (config allowPrompts). The dispatcher needs it. */ allowPrompts?: boolean; /** Turbo mode: this computer clones a project's repo when it is not there (config allowClone), and into projectsDir. */ allowClone?: boolean; projectsDir?: string; /** This PC's Claude Code hooks, as its worker reports them (version: first 12 hex of the hooks version, null when none are installed). */ hooks?: DeviceHooks; /** Present when the worker updates itself (a downloaded worker of version 0.5.0 or later). */ selfUpdate?: DeviceSelfUpdate }; /** Latest counts from the worker (numbers only). `at` is the server's receive time. */ activity?: DeviceActivity; /** Latest named session list from the worker (docs/launcher.md Activity counts). */ claudeSessions?: { at: Date; items: ReportedClaudeSession[] }; /** Sessions that were open before the PC restarted, as the worker remembers them (docs/launcher.md). Cleared when the worker reports none, or on Dismiss. */ reopen?: { at: Date; items: ReopenItem[] } };
/** Where a session was last used: the VS Code extension, a terminal, or something else (the SDK, a script). */
export type SessionOrigin = 'vscode' | 'cli' | 'desktop' | 'other';
export type ReportedClaudeSession = { sessionId: string; folder: string; title: string; lastActiveAt: Date; subagentsActive: number; startedByWorkOs: boolean; running: boolean; /** The computer has no evidence of this session's process: `running` is then true (older readers keep working) but the roster's daemon join says nothing. */ unknown?: true; origin?: SessionOrigin };
export type ReopenItem = { sessionId: string; folder: string; title: string; origin: SessionOrigin };
export type DeviceActivity = { sessions: number; sessionsWorkOs: number; sessionsOther: number; sessionsActive: number; subagents: number; at: Date };
/** A folder a worker reported. _id = deviceId:folderId. Never a path. */
/**
 * A Claude Code session token (lib/agent-sessions.ts): what the Work OS hook gets from POST /api/agent/start for one
 * session on one project, signed in with its PC's device key. `_id` is the session id (the first 32 hex of the token's
 * SHA-256); only the full SHA-256 is stored, never the token. `keyHash`: the hash of the device key it was made with
 * (the token is refused once the computer's key differs). TTL index on `expiresAt`.
 */
export type AgentSessionDoc = { _id: string; hash: string; keyHash: string; deviceId: string; orgId: string; ownerId: string; /** Null: a session outside any project (Identity step 5): its token opens only event and wait. */ projectId: string | null; /** Claude Code's session id, kept for a no-project token so filing the folder can end it. */ ccSession?: string; createdAt: Date; expiresAt: Date; /** H15: the task dispatcher started this session (the PC's own worker session row says so); only ever adds refusals. */ dispatched?: { taskId: string; ref: number } };
export type WorkerFolderDoc = { _id: string; /** The device's owner and organization. */ orgId: string; ownerId: string; deviceId: string; folderId: string; name: string; git: boolean; remote?: string; branch?: string; projectId: string | null; linkedAt: Date | null; seenAt: Date; missing: boolean };
export type WorkerJobDoc = { _id: string; orgId: string; ownerId: string; deviceId: string; kind: 'start' | 'resume' | 'stop' | 'vscode' | 'desktop' | 'reopen' | 'dismiss'; folderId?: string; projectId?: string; /** Not set for reopen and dismiss (they act on the worker's own remembered set). */ sessionId?: string; prompt?: string; /** Turbo mode: the repo is not on the computer; the worker clones it first (docs/launcher.md). No folderId then. */ clone?: { repo: string; trusted: boolean }; /** The task ref of a dispatcher-started run: the worker puts it in the claude process's environment (WORK_OS_DISPATCHED) so the hooks refuse Orders edits there. */ dispatched?: number; createdAt: Date; takenAt: Date | null; doneAt: Date | null; ok?: boolean; error?: string };
export type WorkerSessionDoc = { _id: string; orgId: string; ownerId: string; deviceId: string; /** '' while its repo is still being cloned (turbo mode). */ folderId: string; projectId: string | null; /** Turbo mode: still cloning `repo` (owner/name). */ cloning?: boolean; repo?: string; /** Turbo mode: cloned but not trusted automatically; Claude Code asks the person on first run. */ needsTrust?: boolean; state: 'starting' | 'running' | 'dead' | 'stopped' | 'failed'; startedAt: Date; updatedAt: Date; error?: string; /** Its owner removed it from the list; the doc is kept. */ hidden?: boolean; /** Started by the dispatcher for `taskId`. */ dispatched?: boolean; taskId?: string; /** The run's own Work OS key (lib/run-keys.ts): only its hash; one live key per run, replaced at every start or resume. */ runKey?: RunKeyDoc };
/** A dispatched run's key (lib/run-keys.ts). keyHash: the computer's device key hash when it was made (a key replace ends it). */
export type RunKeyDoc = { hash: string; keyHash: string; ref: number; at: Date; expiresAt: Date; /** The ended state this key's mint moved the row out of (to starting): a release (launch failed) puts it back. */ from?: 'stopped' | 'dead' };
/**
 * Claude usage (lib/data/claude-usage.ts, Work OS note a289ffec58): one row per computer, session, part (the main conversation or one
 * subagent), model and day, with that day's whole token counts as the worker read them from the transcript's usage records.
 * Never any message text. Owner only. `dayAt` (the day at UTC midnight) is what the 90 day TTL index goes by.
 */
export type ClaudeUsageDoc = { _id: string; orgId: string; ownerId: string; deviceId: string; sessionId: string; part: string; partName?: string; model: string; day: string; dayAt: Date; i: number; cw: number; cr: number; o: number; title: string; folder: string; origin: SessionOrigin; updatedAt: Date; /** The Claude account (a hash, lib/data/claude-usage.ts) the day was used under. */ acct?: string; /** The organization's Orders version when it was written. */ ov?: number };
/** Claude usage in 5-minute buckets (last 7 days; the plan of note e6036c777f): counts per computer, session, part, model and bucket start. Owner only; TTL 35 days on `at`. */
export type ClaudeUsageBucketDoc = { _id: string; orgId: string; ownerId: string; deviceId: string; sessionId: string; part: string; model: string; at: Date; acct: string; i: number; cw: number; cw1h: number; cr: number; o: number; n: number; /** The largest context one call carried in this bucket (input + cache read + cache write tokens). */ peakCtx?: number; ov: number; updatedAt: Date };
/** A limit hit or a compaction seen in a transcript (never its text). Written once (a repeat changes nothing). Owner only; TTL 120 days on `at`. */
export type ClaudeUsageEventDoc = { _id: string; orgId: string; ownerId: string; deviceId: string; sessionId: string; part: string; kind: 'limit' | 'compact'; at: Date; acct: string; which?: '5h' | 'weekly' | 'other'; resetAt?: Date | null; trigger?: string; pre?: number; post?: number; ov: number; createdAt: Date };
/** The label (the part of the email before @) of a Claude account id a worker reported. Owner only. */
export type ClaudeAccountDoc = { _id: string; orgId: string; ownerId: string; id: string; label: string; lastSeen: Date };
/** Policy counters for API keys (rate limit, trash limit). TTL index keeps 2 hours. */
export type PolicyEventDoc = { _id: string; keyId: string; kind: 'call' | 'trash' | 'worker' | 'mail_trash' | 'mail_send' | 'intake' | 'agent'; at: Date; n?: number; /** A call's session (its presence key: the session id it passed, else the key): the session's share and the top-3 line. */ sid?: string };
/**
 * One report sent in through an intake (lib/intake.ts): the sender's own id, so the same report sent again finds its task.
 * Unique on (source, reportId). taskId and ref are null while the task is being made (`claimedAt` says since when).
 * Holds no report text: only ids.
 */
export type IntakeDoc = { _id: string; source: 'mailloom'; reportId: string; orgId: string; projectId: string; taskId: string | null; ref: number | null; claimedAt: Date; createdAt: Date };

/** One email sent (for the hourly limits in lib/mail.ts). TTL index keeps 2 hours. */
export type MailLogDoc = { _id: string; kind: 'reset' | 'changed' | 'test' | 'invite'; at: Date; /** Hash of the recipient, for the per-address limit. */ to?: string };
/** Request log (lib/usage.ts, docs/usage-log.md): one doc per UTC hour, _id 'YYYY-MM-DDTHH'; `counts` keys are 'kind|caller|route'. TTL index keeps 35 days. */
export type RequestStatsDoc = { _id: string; at: Date; total: number; counts: Record<string, number> };

// ── Connection (cached across hot reloads and warm serverless invocations) ──

type Cache = { client?: Promise<MongoClient>; indexes?: Promise<void> };
const g = globalThis as unknown as { __workosMongo?: Cache };
const cache: Cache = (g.__workosMongo ??= {});

/** Env var names that look like a Mongo connection string (Vercel integrations may add a prefix). */
export function mongoEnvNames(): string[] {
  return Object.keys(process.env).filter(k => /MONGO/i.test(k)).sort();
}

function mongoUri(): string | undefined {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  const key = Object.keys(process.env).find(
    k => /(^|_)MONGODB_URI$|(^|_)MONGO_URL$|(^|_)MONGO_URI$/i.test(k) && process.env[k]?.startsWith('mongodb'),
  );
  return key ? process.env[key] : undefined;
}

export function getClient(): Promise<MongoClient> {
  const uri = mongoUri();
  if (!uri) throw new Error('MONGODB_URI is not set');
  if (!cache.client) {
    cache.client = new MongoClient(uri, { maxPoolSize: 5, appName: 'work-os' }).connect().catch(err => {
      cache.client = undefined;
      throw err;
    });
  }
  return cache.client;
}

export async function getDb(): Promise<Db> {
  const client = await getClient();
  const db = client.db(process.env.MONGODB_DB || 'workos');
  if (!cache.indexes) {
    cache.indexes = ensureIndexes(db).catch(err => {
      cache.indexes = undefined;
      throw err;
    });
  }
  await cache.indexes;
  return db;
}

/** Every index the app relies on. Changing this list changes INDEX_VERSION by itself. */
const INDEXES: [string, IndexDescription[]][] = [
    ['tasks', [
      { key: { orgId: 1, ref: 1 }, unique: true, name: 'org_ref_unique' },
      { key: { orgId: 1, status: 1, due: 1 }, name: 'org_status_due' },
      { key: { projectId: 1 }, name: 'project' },
      { key: { orgId: 1, ownerId: 1, status: 1 }, name: 'org_owner_status' },
      { key: { doneAt: -1 }, name: 'doneAt' },
      { key: { 'source.messageId': 1 }, name: 'source_message', sparse: true },
      { key: { 'source.replyId': 1 }, name: 'source_reply', sparse: true },
      { key: { 'claude.state': 1, 'claude.markedAt': 1 }, name: 'claude_state', sparse: true },
      // "Who waits on this task" (the task page, get_task, unblocked alerts): without it every task page read the whole organization.
      { key: { dependsOn: 1 }, name: 'depends_on' },
      // A parent's subtasks (rollup, the task page, list_tasks parent).
      { key: { parentId: 1 }, name: 'parent', sparse: true },
      // The heads of recurring series the alerts cron looks at every 15 minutes (spawnDueOccurrences): only repeating tasks are in it.
      { key: { orgId: 1, nextRef: 1, due: 1 }, name: 'recurring_heads', partialFilterExpression: { recurrence: { $type: 'object' } } },
      // Search (lib/search/tasks.ts): titles over every task (only matching keys' documents are read), the other fields among the most recently changed.
      { key: { orgId: 1, title: 1 }, name: 'org_title' },
      { key: { orgId: 1, updatedAt: -1 }, name: 'org_updated' },
    ]],
    ['activity', [
      { key: { taskId: 1, at: -1 }, name: 'task_at' },
      { key: { orgId: 1, at: -1 }, name: 'org_at' },
      // The project page's feed and the placement cascade (rows that are not about a task follow their project).
      { key: { orgId: 1, projectId: 1, at: -1 }, name: 'org_project_at', partialFilterExpression: { projectId: { $type: 'string' } } },
      // A subject's own rows (a Need restamped, a note purged, one note_edited row per editor per hour).
      { key: { 'subject.id': 1, at: -1 }, name: 'subject_at', partialFilterExpression: { 'subject.id': { $type: 'string' } } },
      // Search over comments (lib/search/tasks.ts): the most recent comments only, not every history row.
      { key: { orgId: 1, type: 1, at: -1 }, name: 'org_comments_at', partialFilterExpression: { type: 'comment' } },
    ]],
    ['projects', [
      // Names: one per organization among shared projects, one per owner among private ones (docs/multi-user.md).
      { key: { orgId: 1, nameLower: 1 }, unique: true, name: 'org_shared_name_unique', partialFilterExpression: { visibility: 'org' } },
      { key: { orgId: 1, ownerId: 1, nameLower: 1 }, unique: true, name: 'owner_private_name_unique', partialFilterExpression: { visibility: 'private' } },
      // The door's filter (orgId + visibility or owner) on every project read; the partial indexes above cannot serve it.
      { key: { orgId: 1 }, name: 'org' },
      // One import of a Delpat OS project per organization among shared projects, one per owner among private ones (lib/delpat-os.ts):
      // like names, a private import never blocks anyone else.
      { key: { orgId: 1, delpatOsId: 1 }, unique: true, name: 'org_shared_delpat_os_unique', partialFilterExpression: { visibility: 'org', delpatOsId: { $type: 'string' } } },
      { key: { orgId: 1, ownerId: 1, delpatOsId: 1 }, unique: true, name: 'owner_private_delpat_os_unique', partialFilterExpression: { visibility: 'private', delpatOsId: { $type: 'string' } } },
    ]],
    ['delpatOsLinks', [{ key: { userId: 1 }, name: 'user' }]],
    ['delpatOsAuth', [{ key: { expiresAt: 1 }, name: 'expires_ttl', expireAfterSeconds: 0 }]],
    ['mailConnectAuth', [{ key: { expiresAt: 1 }, name: 'expires_ttl', expireAfterSeconds: 0 }, { key: { orgId: 1, userId: 1 }, name: 'org_user' }]],
    ['ritualLogs', [{ key: { orgId: 1, ownerId: 1, date: 1 }, unique: true, name: 'owner_date_unique' }]],
    ['alertLog', [{ key: { taskId: 1 }, name: 'task' }, { key: { sentAt: 1 }, name: 'sentAt' }]],
    ['alertQueue', [{ key: { sentAt: 1 }, name: 'sentAt' }, { key: { orgId: 1, sentAt: 1 }, name: 'org_sentAt' }]],
    ['notifications', [{ key: { userId: 1, createdAt: -1 }, name: 'user_created' }, { key: { userId: 1, readAt: 1 }, name: 'user_read' }, { key: { createdAt: 1 }, name: 'created_at' }]],
    ['pushSubs', [{ key: { userId: 1 }, name: 'user' }]],
    ['notes', [
      { key: { taskId: 1, deletedAt: 1 }, name: 'one_live_note_per_task', unique: true, partialFilterExpression: { taskId: { $type: 'string' } } },
      { key: { projectId: 1, updatedAt: -1 }, name: 'project_updated' },
      { key: { orgId: 1, updatedAt: -1 }, name: 'org_updated' },
      { key: { parentId: 1 }, name: 'parent', sparse: true },
      // Search (lib/search/notes.ts): titles over every note.
      { key: { orgId: 1, title: 1 }, name: 'org_title' },
    ]],
    ['needs', [
      { key: { orgId: 1, ref: 1 }, unique: true, name: 'org_ref_unique' },
      { key: { projectId: 1, status: 1 }, name: 'project_status' },
      { key: { to: 1, status: 1 }, name: 'to_status' },
    ]],
    ['trash', [{ key: { deletedAt: -1 }, name: 'deletedAt' }, { key: { orgId: 1, ref: 1 }, name: 'org_ref' }]],
    ['claudeItems', [
      { key: { orgId: 1, ref: 1 }, unique: true, name: 'org_ref_unique' },
      { key: { orgId: 1, waitingOn: 1, state: 1 }, name: 'org_waiting' },
      { key: { projectId: 1, state: 1, order: 1 }, name: 'project_state_order' },
      { key: { blockedBy: 1 }, name: 'blockedBy' },
    ]],
    ['devices', [{ key: { hash: 1 }, unique: true, name: 'hash_unique' }, { key: { orgId: 1, ownerId: 1 }, name: 'org_owner' }]],
    ['agentSessions', [{ key: { hash: 1 }, unique: true, name: 'hash_unique' }, { key: { deviceId: 1, createdAt: -1 }, name: 'device_created' }, { key: { expiresAt: 1 }, name: 'expires_ttl', expireAfterSeconds: 0 }]],
    ['workerFolders', [{ key: { deviceId: 1, name: 1 }, name: 'device_name' }, { key: { projectId: 1 }, name: 'project' }, { key: { remote: 1 }, name: 'remote' }, { key: { orgId: 1, ownerId: 1 }, name: 'org_owner' }]],
    ['workerJobs', [{ key: { deviceId: 1, doneAt: 1, createdAt: 1 }, name: 'device_pending' }, { key: { createdAt: 1 }, name: 'created_ttl', expireAfterSeconds: 30 * 86_400 }]],
    ['workerSessions', [{ key: { projectId: 1, updatedAt: -1 }, name: 'project_updated' }, { key: { deviceId: 1, state: 1 }, name: 'device_state' }, { key: { 'runKey.hash': 1 }, unique: true, name: 'run_key_hash', partialFilterExpression: { 'runKey.hash': { $type: 'string' } } }]],
    ['claudeUsage', [{ key: { orgId: 1, ownerId: 1, day: -1 }, name: 'org_owner_day' }, { key: { dayAt: 1 }, name: 'day_ttl', expireAfterSeconds: 90 * 86_400 }]],
    ['claudeUsageBuckets', [{ key: { orgId: 1, ownerId: 1, at: -1 }, name: 'org_owner_at' }, { key: { at: 1 }, name: 'at_ttl', expireAfterSeconds: 35 * 86_400 }]],
    ['claudeUsageEvents', [{ key: { orgId: 1, ownerId: 1, at: -1 }, name: 'org_owner_at' }, { key: { at: 1 }, name: 'at_ttl', expireAfterSeconds: 120 * 86_400 }]],
    ['policyEvents', [{ key: { at: 1 }, name: 'at_ttl', expireAfterSeconds: 2 * 3600 }, { key: { keyId: 1, kind: 1, at: -1 }, name: 'key_kind_at' }]],
    ['intake', [{ key: { source: 1, reportId: 1 }, unique: true, name: 'source_report_unique' }]],
    ['mailLog', [{ key: { at: 1 }, name: 'at_ttl', expireAfterSeconds: 2 * 3600 }, { key: { kind: 1, at: -1 }, name: 'kind_at' }, { key: { kind: 1, to: 1, at: -1 }, name: 'kind_to_at' }]],
    ['requestStats', [{ key: { at: 1 }, name: 'at_ttl', expireAfterSeconds: 35 * 86_400 }]],
    // The calendar link (docs/calendar.md): one row per person per organization, found by the hash of its token.
    ['calendarFeeds', [{ key: { hash: 1 }, unique: true, name: 'hash_unique' }]],
    ['messages', [{ key: { orgId: 1, projectId: 1, at: -1 }, name: 'org_project_at' }, { key: { orgId: 1, thread: 1, at: 1 }, name: 'org_thread' }]],
    ['states', [{ key: { orgId: 1, projectId: 1 }, unique: true, name: 'org_project_unique' }]],
    // Parked lines and decisions: one row each, no cap (lib/state-lists-move.ts). The State keeps only the counts.
    ['stateParked', [{ key: { orgId: 1, projectId: 1, id: 1 }, unique: true, name: 'org_project_id' }, { key: { orgId: 1, projectId: 1, parkedAt: -1, id: -1 }, name: 'org_project_parked' }]],
    ['stateDecisions', [
      { key: { orgId: 1, projectId: 1, id: 1 }, unique: true, name: 'org_project_id' },
      { key: { orgId: 1, projectId: 1, archivedAt: 1, at: -1, id: -1 }, name: 'org_project_live_at' },
      { key: { orgId: 1, key: 1, at: -1 }, name: 'org_key_at', partialFilterExpression: { key: { $exists: true } } },
    ]],
    ['presence', [{ key: { orgId: 1, projectId: 1, lastSeen: -1 }, name: 'org_project_seen' }, { key: { lastSeen: 1 }, name: 'seen_ttl', expireAfterSeconds: 7 * 86_400 }]],
    ['slots', [{ key: { orgId: 1, machine: 1 }, name: 'org_machine' }, { key: { touchedAt: 1 }, name: 'touched_ttl', expireAfterSeconds: 86_400 }]],
    ['authLimits', [{ key: { at: 1 }, name: 'at_ttl', expireAfterSeconds: 3600 }, { key: { key: 1, at: -1 }, name: 'key_at' }]],
    // Better Auth's collections (lib/auth-server.ts): its MongoDB adapter creates no indexes. A session is read by its
    // token whenever the cookie cache runs out (every 2 minutes per person), a member on every role check, an API key on
    // every MCP call.
    ['session', [{ key: { token: 1 }, name: 'token' }, { key: { userId: 1 }, name: 'user' }]],
    ['member', [{ key: { organizationId: 1, userId: 1 }, name: 'org_user' }, { key: { userId: 1, createdAt: 1 }, name: 'user_created' }]],
    ['apikey', [{ key: { key: 1 }, name: 'key' }, { key: { referenceId: 1 }, name: 'reference' }]],
    ['user', [{ key: { email: 1 }, name: 'email' }]],
    ['account', [{ key: { userId: 1 }, name: 'user' }]],
    // Read by Today's checklist and Settings (who is invited, which apps are signed in) on every open.
    ['invitation', [{ key: { organizationId: 1 }, name: 'org' }]],
    ['oauthConsent', [{ key: { userId: 1 }, name: 'user' }]],
    ['oauthAccessToken', [{ key: { userId: 1, clientId: 1 }, name: 'user_client' }]],
    ['settings', [
      // One Work OS person per Discord account in an organization, and one organization per Discord server.
      { key: { area: 1, orgId: 1, discordId: 1 }, unique: true, name: 'discord_link_unique', partialFilterExpression: { discordId: { $type: 'string' } } },
      { key: { area: 1, guildId: 1 }, unique: true, name: 'discord_guild_unique', partialFilterExpression: { guildId: { $type: 'string' } } },
    ]],
  ];

/**
 * Indexes replaced by the per-organization ones above (phase 2): a global unique ref or name would refuse the second
 * organization's #1, and one name per organization would tell people the names of others' private projects. The app
 * drops them when the index list changes (ensureIndexes).
 */
const OBSOLETE: [string, string][] = [
  ['tasks', 'ref_unique'], ['tasks', 'status_due'], ['claudeItems', 'ref_unique'], ['projects', 'name_unique'], ['projects', 'org_name_unique'], ['projects', 'org_delpat_os_unique'], ['ritualLogs', 'date_unique'],
  ['activity', 'at'], ['notes', 'updated'], ['trash', 'ref'], ['notifications', 'created'], ['notifications', 'read'],
];

/** Hash of the index list: stored in settings so cold starts only create indexes when the list changed. */
const INDEX_VERSION = createHash('sha1').update(JSON.stringify([INDEXES, OBSOLETE])).digest('hex').slice(0, 12);

/** Once per process, and not at all when the database already holds this index set (one read instead of ~25 createIndexes). */
async function ensureIndexes(db: Db): Promise<void> {
  const settings = db.collection<{ _id: string; version?: string }>('settings');
  const marker = await settings.findOne({ _id: 'indexes' }, { projection: { version: 1 } });
  if (marker?.version === INDEX_VERSION) return;
  await Promise.all(OBSOLETE.map(([col, name]) => db.collection(col).dropIndex(name).catch(() => {})));
  await Promise.all(INDEXES.map(([name, specs]) => db.collection(name).createIndexes(specs)));
  await settings.updateOne({ _id: 'indexes' }, { $set: { version: INDEX_VERSION, at: new Date() } }, { upsert: true });
}

export async function collections() {
  const db = await getDb();
  const cols = {
    tasks: db.collection<TaskDoc>('tasks'),
    activity: db.collection<ActivityDoc>('activity'),
    projects: db.collection<ProjectDoc>('projects'),
    reviews: db.collection<ReviewDoc>('reviews'),
    ritualLogs: db.collection<RitualDoc>('ritualLogs'),
    counters: db.collection<CounterDoc>('counters'),
    settings: db.collection<SettingsDoc>('settings'),
    trash: db.collection<TrashDoc>('trash'),
    notes: db.collection<NoteDoc>('notes'),
    alertLog: db.collection<AlertLogDoc>('alertLog'),
    alertQueue: db.collection<AlertQueueDoc>('alertQueue'),
    notifications: db.collection<NotificationDoc>('notifications'),
    pushSubs: db.collection<PushSubDoc>('pushSubs'),
    mailLog: db.collection<MailLogDoc>('mailLog'),
    delpatOsLinks: db.collection<DelpatOsLinkDoc>('delpatOsLinks'),
    delpatOsAuth: db.collection<DelpatOsAuthDoc>('delpatOsAuth'),
    mailConnectAuth: db.collection<MailConnectAuthDoc>('mailConnectAuth'),
    requestStats: db.collection<RequestStatsDoc>('requestStats'),
    policyEvents: db.collection<PolicyEventDoc>('policyEvents'),
    intake: db.collection<IntakeDoc>('intake'),
    claudeItems: db.collection<ClaudeItemDoc>('claudeItems'),
    needs: db.collection<NeedDoc>('needs'),
    devices: db.collection<DeviceDoc>('devices'),
    agentSessions: db.collection<AgentSessionDoc>('agentSessions'),
    workerFolders: db.collection<WorkerFolderDoc>('workerFolders'),
    workerJobs: db.collection<WorkerJobDoc>('workerJobs'),
    workerSessions: db.collection<WorkerSessionDoc>('workerSessions'),
    claudeUsage: db.collection<ClaudeUsageDoc>('claudeUsage'),
    claudeUsageBuckets: db.collection<ClaudeUsageBucketDoc>('claudeUsageBuckets'),
    claudeUsageEvents: db.collection<ClaudeUsageEventDoc>('claudeUsageEvents'),
    claudeAccounts: db.collection<ClaudeAccountDoc>('claudeAccounts'),
    messages: db.collection<MessageDoc>('messages'),
    states: db.collection<StateDoc>('states'),
    stateParked: db.collection<StateParkedDoc>('stateParked'),
    stateDecisions: db.collection<StateDecisionDoc>('stateDecisions'),
    presence: db.collection<PresenceDoc>('presence'),
    slots: db.collection<SlotDoc>('slots'),
  };
  const session = txStore.getStore();
  return session ? (Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, withSession(v, session)])) as typeof cols) : cols;
}

// ── Transactions ────────────────────────────────────────────────────────────
// inTransaction(fn) runs fn with every collections() call bound to one session, so the
// whole batch commits or rolls back together. The data layer needs no session plumbing.

const txStore = new AsyncLocalStorage<ClientSession>();

/** Position of the options argument for collection methods the data layer uses. */
const OPTIONS_ARG: Record<string, number> = {
  find: 1, findOne: 1, countDocuments: 1, aggregate: 1, distinct: 2,
  insertOne: 1, insertMany: 1, updateOne: 2, updateMany: 2, replaceOne: 2,
  deleteOne: 1, deleteMany: 1, bulkWrite: 1, findOneAndUpdate: 2, findOneAndDelete: 1,
};

function withSession<C extends object>(col: C, session: ClientSession): C {
  return new Proxy(col, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      const i = typeof prop === 'string' ? OPTIONS_ARG[prop] : undefined;
      if (i === undefined) return v.bind(target);
      return (...args: unknown[]) => {
        const a = [...args];
        while (a.length < i) a.push(undefined);
        a[i] = { ...((a[i] as object | undefined) ?? {}), session };
        return v.apply(target, a);
      };
    },
  });
}

// Work to do once the transaction has committed (push hints, lib/live.ts): dropped when it aborts or is a dry run.
const afterCommits = new WeakMap<ClientSession, (() => void)[]>();

/** Runs fn now, or, inside inTransaction, once the transaction has committed (never if it rolls back). */
export function afterCommit(fn: () => void): void {
  const session = txStore.getStore();
  const list = session && afterCommits.get(session);
  if (list) list.push(fn);
  else fn();
}

export function inTransactionNow(): boolean {
  return !!txStore.getStore();
}

/** Run fn atomically. dryRun runs everything, then rolls back and returns fn's result. */
export async function inTransaction<T>(fn: () => Promise<T>, opts: { dryRun?: boolean } = {}): Promise<T> {
  if (txStore.getStore()) return fn(); // already inside one
  await getDb();
  const client = await getClient();
  const session = client.startSession();
  try {
    afterCommits.set(session, []);
    if (opts.dryRun) {
      session.startTransaction();
      try {
        return await txStore.run(session, fn);
      } finally {
        await session.abortTransaction().catch(() => {});
      }
    }
    let result!: T;
    await session.withTransaction(async () => {
      afterCommits.set(session, []); // a retried attempt starts over
      result = await txStore.run(session, fn);
    });
    for (const f of afterCommits.get(session) ?? []) {
      try {
        f();
      } catch (e) {
        console.error('[afterCommit]', e);
      }
    }
    return result;
  } finally {
    await session.endSession();
  }
}

export type Collections = Awaited<ReturnType<typeof collections>>;

export async function nextSeq(counters: Collection<CounterDoc>, name: string): Promise<number> {
  const res = await counters.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return res!.seq;
}

export function toActivity(d: ActivityDoc): Activity {
  return {
    id: d._id,
    ...(d.taskId ? { taskId: d.taskId, taskRef: d.taskRef, taskTitle: d.taskTitle } : {}),
    ...(d.projectId ? { projectId: d.projectId } : {}),
    ...(d.subject ? { subject: { kind: d.subject.kind, id: d.subject.id, ...(d.subject.ref ? { ref: d.subject.ref } : {}), title: d.subject.title } } : {}),
    ...(d.textBy ? { textBy: d.textBy } : {}),
    ...(d.titleBy ? { titleBy: d.titleBy } : {}),
    at: d.at.toISOString(),
    actor: asActor(d.actor),
    type: d.type,
    ...(d.changes ? { changes: d.changes } : {}),
    ...(d.note ? { note: d.note } : {}),
    ...(d.feedback ? { feedback: d.feedback } : {}),
    ...(d.session ? { session: d.session } : {}),
    ...(d.repo ? { repo: d.repo } : {}),
  };
}
