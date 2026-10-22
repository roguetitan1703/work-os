import { CopyBox } from '@/components/copy-box';
import { Disclosure, Field, Section, code } from '../settings/ui';
import { getDispatcherSettings, listNotePicks, MAX_CAP } from '@/lib/data/dispatcher';
import { Computers } from './computers';
import { DispatcherSetup } from './dispatcher-setup';
import { ClaudeCodeKeys } from './keys';
import { requireScope } from '@/lib/caller';

/** Claude › Setup: computers that run sessions, and keys that let Claude Code use Work OS. */
export async function SetupTab({ url }: { url: string }) {
  const s = await requireScope();
  const [settings, notes] = await Promise.all([getDispatcherSettings(s), listNotePicks(s)]);
  return (
    <div className="space-y-5 md:max-w-3xl">
      <Computers />
      <DispatcherSetup initial={settings} notes={notes} maxCap={MAX_CAP} />
      <Section title="Keys">
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Keys let Claude Code on a computer read and update Work OS.</p>
          <ClaudeCodeKeys url={url} />
          <Disclosure title="Connect this PC" hint="Run once in a terminal">
            <Field label="Create a key above, then run (replace <key> with it)">
              <CopyBox text={`claude mcp add --scope user --transport http work-os ${url} --header "Authorization: Bearer <key>"`} multiline />
            </Field>
            <p>
              Then run <code className={code}>/mcp</code> inside Claude Code and check that <b>work-os</b> shows as connected.
            </p>
          </Disclosure>
          <Disclosure title="How sessions find their project" hint="Git remote, branch and path">
            <p>
              A session calls <code className={code}>get_project</code> with its git remote, branch and path. The links live on each project page under <b>Code locations</b>.
            </p>
          </Disclosure>
        </div>
      </Section>
    </div>
  );
}
