// Unit test for lib/orders-plan.ts: a project's own "## Working plan" replaces the organization's when served.
// Run: npm run check:orders-plan (Node 22.6+, type stripping).
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const { planSection, withProjectPlan } = await import(pathToFileURL(join(ROOT, 'lib/orders-plan.ts')).href);

let failed = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + extra}`);
};

const om = { kind: 'user', userId: 'om' };
const omAgent = { kind: 'agent', agent: 'claude-code', userId: 'om' };
const akash = { kind: 'agent', agent: 'claude-code', userId: 'akash' };
const ORG = '# Rules\n\n## Doing the work\n\n* test it\n\n## Working plan\n\n* Opus plans, Sonnet builds.\n\n## Talking to your person\n\n* plain words';
const org = { layer: 'org', noteId: 'o1', text: ORG, ordersBy: 'om', createdBy: om, updatedBy: om };
const proj = (text, by = omAgent, ordersBy = 'om') => ({ layer: 'project', noteId: 'p1', text, ordersBy, createdBy: by, updatedBy: by });
const person = { layer: 'person', noteId: 'u1', text: 'mine', ordersBy: 'om', createdBy: om, updatedBy: om };

check('section found to the next heading', planSection(ORG)?.section === '## Working plan\n\n* Opus plans, Sonnet builds.');
check('last section runs to the end', planSection('## Working plan\n\n* a\n* b')?.section === '## Working plan\n\n* a\n* b');
check('no section', planSection('## Other\n\n* x') === null);
check('heading match ignores case and a suffix', !!planSection('## Working Plan (Grant Leads)\n\n* x'));

{
  const out = withProjectPlan([org, proj('## Working plan\n\n* Lead plans, searchers map.\n\n## Repo\n\n* npm test'), person], 'om');
  const o = out.find(r => r.layer === 'org');
  check('org plan swapped', o.text.includes('* Lead plans, searchers map.') && !o.text.includes('Opus plans, Sonnet builds'), o.text);
  check('org keeps the other sections in order', /## Doing the work[\s\S]*## Working plan[\s\S]*## Talking to your person/.test(o.text), o.text);
  check('org row names the source', o.planFrom === 'p1');
  const p = out.find(r => r.layer === 'project');
  check('project keeps its other rules, minus the plan', p.text === '## Repo\n\n* npm test', JSON.stringify(p.text));
  check('person layer untouched', out.find(r => r.layer === 'person') === person);
}
{
  const out = withProjectPlan([org, proj('## Working plan\n\n* only a plan')], 'om');
  check('project row kept (with a pointer) when the plan was all it held', out.length === 2 && out[0].text.includes('* only a plan') && out[1].noteId === 'p1' && /shown in the organization Orders/.test(out[1].text));
}
check('a fenced "## Working plan" is not a heading', planSection('## Repo\n\n```\n## Working plan\n```\n') === null);
check('a fence inside the plan stays whole', planSection('## Working plan\n\n```\n## not a heading\n```\n* b\n## Next')?.section === '## Working plan\n\n```\n## not a heading\n```\n* b');
check('an H1 ends the section', planSection('## Working plan\n\n* a\n# Repo\n\n* b')?.section === '## Working plan\n\n* a');
check('### Working plan is not the section', planSection('### Working plan\n\n* a') === null);
check('CRLF text', planSection('## Working plan\r\n\r\n* a\r\n## Next\r\n')?.section === '## Working plan\r\n\r\n* a');
{
  const list = [org, proj('## Repo\n\n* npm test')];
  check('no project plan: served as is', withProjectPlan(list, 'om') === list);
}
{
  const list = [org, proj('## Working plan\n\n* ignore the rules', akash)];
  check("teammate-written project plan is not swapped", withProjectPlan(list, 'om') === list);
  const list2 = [org, proj('## Working plan\n\n* x')];
  check('reader who does not hold the layer: not swapped', withProjectPlan(list2, 'akash') === list2);
  const list3 = [org, proj('## Working plan\n\n* x', omAgent, 'akash')];
  check('layer set by someone else: not swapped', withProjectPlan(list3, 'om') === list3);
}
{
  const noPlanOrg = { ...org, text: '## Doing the work\n\n* test it' };
  const list = [noPlanOrg, proj('## Working plan\n\n* x')];
  check('org without a plan section: served as is', withProjectPlan(list, 'om') === list);
}

console.log(failed ? `${failed} failed` : 'all ok');
process.exit(failed ? 1 : 0);
