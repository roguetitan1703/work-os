import { CopyBox } from '@/components/copy-box';
import { ClaudeCodeKeys } from './claude-code-keys';
import { Disclosure, Field, Section, code } from './ui';

/** Claude Code: keys manager first, "Connect this PC" guide collapsed. */
export function CodeTab({ url }: { url: string }) {
  return (
    <div className="space-y-5">
      <Section title="Keys">
        <ClaudeCodeKeys url={url} />
      </Section>

      <Section title="Setup">
        <div className="space-y-3">
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
