// H13 "the folder decides the project" (docs/flows/agent-system.md section 11): a remote never decides; a path location
// does (longest wins, narrowed to one computer by `machine`); a session in a folder no project owns is "unfiled". Seed
// profile: none. Steps 1-4 of the plan (matcher, quiet list, link from a session, the device-key route) are checked here.
import { check, finish, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const pid = async name => (await rawDb.collection('projects').findOne({ name }))._id;
try {
  const cc = await mkKey({ agent: 'claude-code', name: 'H13 cc' });

  // ── 1. The matcher: only a path location decides; a remote only ranks the suggestions
  await must(cc, 'add_project', { name: 'H13 Alpha', code: [{ remote: 'acme/h13-alpha', subdir: 'web', branch: 'main' }, { path: 'C:/h13/alpha', machine: 'PC-One' }] });
  await must(cc, 'add_project', { name: 'H13 Sub', code: [{ path: 'C:/h13/alpha/sub' }] });
  await must(cc, 'add_project', { name: 'H13 Twin', code: [{ remote: 'acme/h13-alpha' }] });
  await must(cc, 'add_project', { name: 'H13 Other', code: [{ remote: 'acme/h13-other' }] });
  const A = await pid('H13 Alpha');
  const S = await pid('H13 Sub');
  const stored = (await rawDb.collection('projects').findOne({ _id: A })).code;
  check('H13 matcher: machine is stored lowercase on a path location, and not on a remote', stored.find(l => l.path)?.machine === 'pc-one' && !stored.find(l => l.remote)?.machine, JSON.stringify(stored));
  const badMachine = await mcpH(cc, 'update_project', { project: 'H13 Other', code: [{ path: 'C:/x', machine: 'bad name!' }] });
  check('H13 matcher: a bad machine name is refused', badMachine.isError, badMachine.text.slice(0, 160));

  const gp = a => mcpH(cc, 'get_project', a);
  const byPath = await gp({ path: 'C:/h13/alpha/web', machine: 'pc-one', depth: 'project' });
  check('H13 matcher: a folder inside a path location on that machine finds the project (how: path)', byPath.json?.project?.id === A && byPath.json?.matchedBy?.how === 'path', byPath.text.slice(0, 200));
  const otherPc = await gp({ path: 'C:/h13/alpha/web', machine: 'pc-two', depth: 'project' });
  check('H13 matcher: the same folder on another computer does not match a location written for pc-one', otherPc.json?.unmatched === true, otherPc.text.slice(0, 200));
  const noMachine = await gp({ path: 'C:/h13/alpha/web', depth: 'project' });
  check('H13 matcher: a query without machine does not match a machine location', noMachine.json?.unmatched === true);
  const deepest = await gp({ path: 'C:/h13/alpha/sub/deep', machine: 'pc-one', depth: 'project' });
  check('H13 matcher: the longest path wins, and a location without machine matches on any computer', deepest.json?.project?.id === S, deepest.text.slice(0, 200));
  const otherSub = await gp({ path: 'c:\\h13\\alpha\\sub', machine: 'whatever', depth: 'project' });
  check('H13 matcher: a Windows path with backslashes and another case matches', otherSub.json?.project?.id === S, otherSub.text.slice(0, 200));

  const rem = await gp({ remote: 'https://github.com/acme/h13-alpha.git', subdir: 'web', branch: 'main' });
  check('H13 matcher: get_project with only a remote (even subdir and branch of a location) is unmatched', rem.json?.unmatched === true && !rem.json?.project, rem.text.slice(0, 200));
  const same = (rem.json?.candidates ?? []).filter(c => c.why === 'same remote').map(c => c.name).sort();
  check('H13 matcher: candidates with the same remote come first, with why "same remote"', same.join() === 'H13 Alpha,H13 Twin' && (rem.json.candidates ?? []).slice(0, 2).every(c => c.why === 'same remote') && !rem.json.candidates.some(c => c.name === 'H13 Other' && c.why), JSON.stringify(rem.json?.candidates));
  const swRem = await mcpH(cc, 'start_work', { remote: 'git@github.com:acme/h13-alpha.git', branch: 'main', machine: 'pc-one' });
  check('H13 matcher: start_work with only a remote is unmatched, registers nobody, and the hint teaches link and not_work_os', swRem.json?.unmatched === true && (await rawDb.collection('presence').countDocuments({})) === 0 && /link/.test(swRem.json.hint) && /not_work_os/.test(swRem.json.hint) && swRem.json.candidates[0]?.why === 'same remote', swRem.text.slice(0, 300));
  const swPath = await mcpH(cc, 'start_work', { path: 'C:/h13/alpha/web', remote: 'acme/h13-other', machine: 'pc-one', label: 'h13' });
  check('H13 matcher: start_work with a path and a remote of another project: the path decides', !swPath.isError && swPath.json?.project?.id === A && swPath.json?.project?.matchedBy?.how === 'path', swPath.text.slice(0, 200));

} catch (e) {
  check('flow-h13 threw', false, String(e?.stack || e));
}
await finish();
