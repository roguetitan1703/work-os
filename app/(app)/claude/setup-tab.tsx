import { Check, Lock } from 'lucide-react';
import { CopyBox } from '@/components/copy-box';
import { urlTokenAllowed } from '@/lib/auth';
import { requireCaller } from '@/lib/caller';
import { getDispatcherSettings, listNotePicks, MAX_CAP } from '@/lib/data/dispatcher';
import { listDevices } from '@/lib/devices';
import { setupState } from '@/lib/get-started';
import { instructions, TOOLS } from '@/lib/mcp/docs';
import { getOrgModes } from '@/lib/org-modes';
import { listAuthorizedApps } from '@/lib/oauth';
import { cn } from '@/lib/utils';
import { BRIEF_PROMPT, GROUPS, PROJECT_INSTRUCTIONS } from '../settings/data';
import { Disclosure, Field, code } from '../settings/ui';
import { AdvancedFold } from './advanced-fold';
import { Computers } from './computers';
import { ConnectStep } from './connect-claude';
import { DispatcherProvider, DispatcherStep, StandingNote } from './dispatcher-setup';
import { ClaudeCodeKeys } from './keys';
import { ReferenceTab } from './reference-tab';

type StepState = 'done' | 'todo' | 'locked';

/**
 * Claude › Set up: three steps in order, each with Done / Not done, later steps greyed until the one above is done.
 *   1 Connect Claude (required), 2 Let Claude work on your PC (optional), 3 Give tasks to Claude (optional).
 * Raw keys, the standing-instructions note and the reference live in Advanced at the bottom. Reads only this person's own
 * keys, apps, computers and settings; every change goes through the same actions (and re-auth) as before.
 */
export async function SetupTab({ url }: { url: string }) {
  const me = await requireCaller();
  const [state, devices, settings, notes, apps, modes] = await Promise.all([
    setupState(me),
    listDevices(me).catch(() => []),
    getDispatcherSettings(me),
    listNotePicks(me),
    listAuthorizedApps(me).catch(() => []),
    getOrgModes(me.orgId),
  ]);
  const s1: StepState = state.step1.done ? 'done' : 'todo';
  const s2: StepState = !state.step1.done ? 'locked' : state.step2.done ? 'done' : 'todo';
  const s3: StepState = !state.step2.done || !state.step1.done ? 'locked' : state.step3.done ? 'done' : 'todo';
  const count = [s1, s2, s3].filter(x => x === 'done').length;
  const urlFallback = urlTokenAllowed();

  return (
    <DispatcherProvider initial={settings} notes={notes} maxCap={MAX_CAP}>
      <div className="space-y-5 md:max-w-3xl" data-setup>
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">Set up Claude, in 3 steps</h2>
          <span data-setup-count className="text-[13px] text-muted-foreground tabular-nums shrink-0">
            {count} of 3 done
          </span>
        </div>

        <ol className="space-y-3">
          <Step n={1} state={s1} title="Connect Claude" why="So Claude can see and update your tasks.">
            <ConnectStep url={url} done={state.step1.done} lastUsedAt={state.step1.lastUsedAt} apps={apps} />
          </Step>
          <Step
            n={2}
            state={s2}
            optional
            title="Let Claude work on your PC"
            why="Optional: only if you want Claude to work on your own computer. Claude can open a Claude Code window on your PC and work through tasks while you are away."
            after="Do step 1 first."
          >
            <Computers initial={devices} />
          </Step>
          <Step n={3} state={s3} optional title="Give tasks to Claude" why="Optional. Tasks you give to Claude start on their own." after={state.step1.done ? 'Do step 2 first.' : 'Do step 1 first.'}>
            <DispatcherStep ready={state.step2.done} />
          </Step>
        </ol>

        <AdvancedFold>
          <section className="space-y-2" data-advanced-keys>
            <h3 className="text-sm font-medium text-foreground">Access keys</h3>
            <p className="text-[13px] text-muted-foreground">
              Only needed if you connect something by hand or from a script. Signing in (step 1) is safer: a key is a long password you copy once, and anyone who has it can act as you until you remove it.
            </p>
            <div className="space-y-2">
              <p className="text-[13px] font-medium text-foreground">For Claude on claude.ai</p>
              <ClaudeCodeKeys url={url} agent="claude" urlKey={urlFallback} />
              <p className="px-1 text-xs text-muted-foreground">
                Server address <code className={code}>{url}</code>; header <code className={code}>Authorization: Bearer {'<key>'}</code> (or <code className={code}>X-API-Key</code>). For a client with no header or
                sign-in option, set <code className={code}>MCP_ALLOW_URL_TOKEN=1</code> on the server and use{' '}
                <code className={code}>
                  {url}/{'<key>'}
                </code>{' '}
                (the key then lives in the URL, so treat the URL as a password). Currently: <b>{urlFallback ? 'enabled' : 'disabled'}</b>.
              </p>
            </div>
            <div className="space-y-2 pt-2">
              <p className="text-[13px] font-medium text-foreground">For Claude Code on a PC</p>
              <ClaudeCodeKeys url={url} />
              <Disclosure title="Connect this PC with a key" hint="Run once in a terminal">
                <Field label="Make a key above, then run (replace <key> with it)">
                  <CopyBox text={`claude mcp add --scope user --transport http work-os ${url} --header "Authorization: Bearer <key>"`} multiline />
                </Field>
                <p>
                  Then run <code className={code}>/mcp</code> inside Claude Code and check that <b>work-os</b> shows as connected.
                </p>
              </Disclosure>
            </div>
          </section>

          <section className="space-y-2" data-advanced-note>
            <StandingNote />
          </section>

          <section className="space-y-2">
            <Disclosure title="How Claude finds the right project" hint="Git remote, branch and path">
              <p>
                A session calls <code className={code}>get_project</code> with its git remote, branch and path. The links live on each project page under <b>Code locations</b>.
              </p>
            </Disclosure>
            <Disclosure title="What a PC can do" hint="Limits and safety">
              <p>
                A computer key (<code>wkr_…</code>) only opens the worker endpoints: report folder names, read Start / Resume / Stop jobs for that device, report session status. It can&apos;t read or change tasks,
                notes or projects. The worker only starts <code>claude</code> in folders you linked, in normal permission mode; you give instructions from the Claude app. Remove the PC in step 2, or set{' '}
                <code>enabled: false</code> in the worker&apos;s config, to stop it.
              </p>
            </Disclosure>
            <Disclosure title="Prompts for Claude chat" hint="Project instructions and morning brief">
              <Field label="Tell Claude how you use it (paste into a Claude Project's instructions, or Settings → Profile → personal preferences)">
                <CopyBox text={PROJECT_INSTRUCTIONS} multiline />
              </Field>
              <Field label="Add to the morning brief (the prompt of your weekday 8am brief, alongside Calendar, Gmail and Vercel)">
                <CopyBox text={BRIEF_PROMPT} multiline />
              </Field>
            </Disclosure>
            <Disclosure title="What Claude can do here" hint="Every tool, with an example">
              <ReferenceTab
                url={url}
                instructions={instructions({ name: me.name, modes: modes.map(m => m.name) })}
                groups={GROUPS.map(g => ({
                  title: g.title,
                  tools: g.tools.map(name => ({ name, writes: TOOLS[name].writes, description: TOOLS[name].description, example: TOOLS[name].example })),
                }))}
              />
            </Disclosure>
          </section>
        </AdvancedFold>
      </div>
    </DispatcherProvider>
  );
}

const CHIP: Record<StepState, string> = { done: 'Done', todo: 'Not done', locked: 'Locked' };

function Step({ n, state, title, why, optional, after, children }: { n: number; state: StepState; title: string; why: string; optional?: boolean; after?: string; children: React.ReactNode }) {
  const locked = state === 'locked';
  return (
    <li data-step={n} data-step-state={state} className={cn('rounded-2xl bg-card border border-border/70 overflow-hidden min-w-0', locked && 'opacity-60')}>
      <div className="flex items-start gap-3 px-4 pt-4">
        <span aria-hidden className={cn('w-7 h-7 shrink-0 rounded-full grid place-items-center text-[13px] font-semibold border', state === 'done' ? 'bg-foreground border-foreground text-background' : 'border-muted-foreground/40 text-foreground')}>
          {state === 'done' ? <Check size={15} strokeWidth={2.4} /> : n}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[16px] font-semibold text-foreground">
              {n}. {title}
            </h3>
            {optional && <span className="text-[12px] text-muted-foreground">Optional</span>}
          </div>
          <p className="text-[13px] text-muted-foreground leading-snug mt-0.5">{why}</p>
        </div>
        <span data-step-chip className={cn('shrink-0 inline-flex items-center gap-1 rounded-full px-2.5 h-6 text-[12px] font-medium', state === 'done' ? 'bg-muted text-foreground' : 'text-muted-foreground border border-border')}>
          {locked && <Lock size={11} aria-hidden />} {CHIP[state]}
        </span>
      </div>
      <div className="px-4 pb-4 pt-3 md:pl-14 min-w-0">
        {locked ? (
          <p className="text-[13px] text-muted-foreground" data-step-locked>
            {after}
          </p>
        ) : (
          children
        )}
      </div>
    </li>
  );
}
