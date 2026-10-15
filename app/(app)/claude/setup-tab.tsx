import { CopyBox } from '@/components/copy-box';
import { Disclosure, Field, Section, code } from '../connect/ui';
import { Computers } from './computers';
import { ClaudeCodeKeys } from './keys';

/** Claude › Setup: computers that run sessions, and keys that let Claude Code use Work OS. */
export function SetupTab({ url }: { url: string }) {
  return (
    <div className="space-y-5 md:max-w-3xl">
      <Computers />
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
