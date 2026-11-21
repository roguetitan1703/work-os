// H13 "the folder decides the project" (docs/flows/agent-system.md section 11): a remote never decides; a path location
// does (longest wins, narrowed to one computer by `machine`); a session in a folder no project owns is "unfiled". Seed
// profile: none. Steps 1-4 of the plan (matcher, quiet list, link from a session, the device-key route) are checked here.
import { B, ME, check, finish, makeUser, mkDevice, mkKey, rawDb } from './lib.mjs';
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

  // ── 2. The quiet list: "not Work OS", per person, on the server
  const T = await makeUser({ email: 'h13-tess@example.test', name: 'Tess', orgId: ME.orgId, role: 'member' });
  const X = await makeUser({ email: 'h13-xavier@example.test', name: 'Xavier', orgName: 'H13 Other Org' });
  const kT = await mkKey({ agent: 'claude-code', userId: T.userId, name: 'Tess cc' });
  const kX = await mkKey({ agent: 'claude-code', userId: X.userId, orgId: X.orgId, name: 'Xavier cc' });
  const quiet = userId => rawDb.collection('settings').findOne({ _id: `quietFolders:${userId}` });
  const presenceBefore = await rawDb.collection('presence').countDocuments({});
  const nw = await mcpH(cc, 'start_work', { path: 'D:\\Scratch\\Thing', machine: 'PC-One', not_work_os: true });
  check('H13 quiet: not_work_os answers quiet with a message and no brief, no presence', !nw.isError && nw.json?.quiet === true && !nw.json?.project && typeof nw.json?.message === 'string' && (await rawDb.collection('presence').countDocuments({})) === presenceBefore, nw.text.slice(0, 300));
  const q1 = await quiet(ME.userId);
  check('H13 quiet: stored on the caller\'s own settings doc, path normalised, machine lowercase', q1?.userId === ME.userId && q1.orgId === ME.orgId && q1.items.length === 1 && q1.items[0].path === 'd:/scratch/thing' && q1.items[0].machine === 'pc-one', JSON.stringify(q1));
  await mcpH(cc, 'start_work', { path: 'd:/scratch/thing/', machine: 'pc-one', not_work_os: true });
  check('H13 quiet: the same folder twice is one entry', (await quiet(ME.userId)).items.length === 1);
  await mcpH(cc, 'start_work', { path: 'd:/scratch/other', machine: "Om's PC", not_work_os: true });
  check('H13 quiet: a machine name with odd characters is cleaned, not refused', (await quiet(ME.userId)).items.some(i => i.machine === 'om-s-pc' && i.path === 'd:/scratch/other'));
  for (const [what, args] of [['no path', { machine: 'pc-one', not_work_os: true }], ['no machine', { path: 'D:/x', not_work_os: true }]]) {
    const r = await mcpH(cc, 'start_work', args);
    check(`H13 quiet: ${what} is refused`, r.isError, r.text.slice(0, 160));
  }
  const tq = await quiet(T.userId);
  const xq = await quiet(X.userId);
  check('H13 quiet: another person (same organization) and another organization have no entry from it', !tq && !xq);
  await mcpH(kX, 'start_work', { path: 'D:/Scratch/Thing', machine: 'pc-one', not_work_os: true });
  check('H13 quiet: another organization marks its own; the first list is unchanged', (await quiet(X.userId))?.orgId === X.orgId && (await quiet(ME.userId)).items.length === 2);
  // The cap: at most 200, the oldest dropped
  await rawDb.collection('settings').updateOne({ _id: `quietFolders:${T.userId}` }, { $set: { area: 'quietFolders', orgId: T.orgId ?? ME.orgId, userId: T.userId, items: Array.from({ length: 200 }, (_, i) => ({ machine: 'pc-one', path: `d:/many/f${i}`, at: new Date(2020, 0, 1, 0, 0, i) })) } }, { upsert: true });
  await mcpH(kT, 'start_work', { path: 'D:/Many/New', machine: 'pc-one', not_work_os: true });
  const capped = (await quiet(T.userId)).items;
  check('H13 quiet: 200 is the cap; the 201st drops the oldest', capped.length === 200 && capped.some(i => i.path === 'd:/many/new') && !capped.some(i => i.path === 'd:/many/f0') && capped.some(i => i.path === 'd:/many/f1'), String(capped.length));

  // ── 3. Link from a session: start_work with project + link (+ folder, or path and machine); onThisPc in unmatched
  const own = async (who, name) => {
    const d = await mkDevice(name);
    await rawDb.collection('devices').updateOne({ _id: d.id }, { $set: { ownerId: who.userId, orgId: who.orgId } });
    return d;
  };
  const fold = (dev, who, fid, projectId = null) => ({ _id: `${dev.id}:${fid}`, deviceId: dev.id, folderId: fid, name: `code/${fid}`, git: true, projectId, linkedAt: projectId ? new Date() : null, seenAt: new Date(), missing: false, orgId: who.orgId, ownerId: who.userId });
  const OTHER = await pid('H13 Other');
  const pc1 = await own(ME, 'h13-pc-1');
  const pc2 = await own(ME, 'h13-pc-2');
  const tPc = await own(T, 'h13-tess-pc');
  const xPc = await own(X, 'h13-xav-pc');
  await rawDb.collection('workerFolders').insertMany([
    fold(pc1, ME, 'h13fa'), fold(pc1, ME, 'h13fb'), fold(pc1, ME, 'h13taken', OTHER), fold(pc1, ME, 'h13dup'), fold(pc2, ME, 'h13dup'),
    fold(tPc, T, 'h13tess'), fold(xPc, X, 'h13xav'),
  ]);
  const row = fid => rawDb.collection('workerFolders').findOne({ folderId: fid, deviceId: { $in: [pc1.id, tPc.id, xPc.id] } });
  const l1 = await mcpH(cc, 'start_work', { project: 'H13 Alpha', folder: 'h13fa', link: true, machine: 'pc-one', label: 'h13 link' });
  check('H13 link: project + folder + link files the caller\'s own folder and answers the brief with filed.how folder', !l1.isError && l1.json?.project?.id === A && l1.json?.filed?.how === 'folder' && (await row('h13fa')).projectId === A, l1.text.slice(0, 300));
  const missing = await mcpH(cc, 'start_work', { project: 'H13 Alpha', folder: 'h13nosuch', link: true });
  const tessF = await mcpH(cc, 'start_work', { project: 'H13 Alpha', folder: 'h13tess', link: true });
  const xavF = await mcpH(cc, 'start_work', { project: 'H13 Alpha', folder: 'h13xav', link: true });
  check('H13 link: another member\'s folder and another organization\'s folder are "not found", worded as a folder that does not exist, and nothing linked', missing.isError && tessF.isError && xavF.isError && tessF.text === missing.text && xavF.text === missing.text && /not found/i.test(missing.text) && (await row('h13tess')).projectId === null && (await row('h13xav')).projectId === null, `${missing.text} | ${tessF.text} | ${xavF.text}`);
  const taken = await mcpH(cc, 'start_work', { project: 'H13 Alpha', folder: 'h13taken', link: true });
  check('H13 link: a folder already linked to another project is refused and stays', taken.isError && /linked to another project/.test(taken.text) && (await row('h13taken')).projectId === OTHER, taken.text.slice(0, 200));
  const dup = await mcpH(cc, 'start_work', { project: 'H13 Alpha', folder: 'h13dup', link: true });
  check('H13 link: an id two of the caller\'s computers both report is "not found"', dup.isError && dup.text === missing.text, dup.text.slice(0, 160));
  const tLink = await mcpH(kT, 'start_work', { project: 'H13 Alpha', folder: 'h13fb', link: true });
  check('H13 link: a member cannot link the owner\'s folder (not found)', tLink.isError && tLink.text === missing.text && (await row('h13fb')).projectId === null, tLink.text.slice(0, 160));
  const noProj = await mcpH(cc, 'start_work', { folder: 'h13fb', link: true });
  const noWhere = await mcpH(cc, 'start_work', { project: 'H13 Alpha', link: true });
  check('H13 link: link without project, and link with neither folder nor path and machine, are refused', noProj.isError && noWhere.isError, `${noProj.text.slice(0, 100)} | ${noWhere.text.slice(0, 100)}`);
  await must(cc, 'add_project', { name: 'H13 Private', visibility: 'private' });
  const priv = await mcpH(kT, 'start_work', { project: 'H13 Private', folder: 'h13tess', link: true });
  const nope = await mcpH(kT, 'start_work', { project: 'H13 No Such Project', folder: 'h13tess', link: true });
  check('H13 link: a project the caller cannot read is "not found", like one that does not exist, and the folder stays unlinked', priv.isError && nope.isError && priv.text.replace('H13 Private', 'X') === nope.text.replace('H13 No Such Project', 'X') && (await row('h13tess')).projectId === null, `${priv.text} | ${nope.text}`);

  await must(cc, 'add_project', { name: 'H13 Pathy' });
  const PA = await pid('H13 Pathy');
  const codeByBefore = (await rawDb.collection('projects').findOne({ _id: PA })).codeBy;
  const p1 = await mcpH(kT, 'start_work', { project: 'H13 Pathy', path: 'C:/H13/Pathy', machine: 'Tess-PC', link: true });
  const pdoc = await rawDb.collection('projects').findOne({ _id: PA });
  check('H13 link by path: adds one {path, machine} location, answers filed.how path', !p1.isError && p1.json?.filed?.how === 'path' && pdoc.code?.length === 1 && pdoc.code[0].path === 'C:/H13/Pathy' && pdoc.code[0].machine === 'tess-pc', p1.text.slice(0, 300) + JSON.stringify(pdoc.code));
  check('H13 link by path: codeBy (who set the repo, which turbo cloning trusts) does not change to the linker', pdoc.codeBy === codeByBefore && pdoc.codeBy !== T.userId, `${codeByBefore} -> ${pdoc.codeBy}`);
  const again = await mcpH(kT, 'start_work', { project: 'H13 Pathy', path: 'c:\\h13\\pathy\\', machine: 'tess-pc', link: true });
  check('H13 link by path: filing the same folder again adds nothing', !again.isError && /already filed/.test(again.json?.filed?.how ?? '') && (await rawDb.collection('projects').findOne({ _id: PA })).code.length === 1, again.text.slice(0, 200));
  const clash = await mcpH(kT, 'start_work', { project: 'H13 Alpha', path: 'C:/h13/pathy', machine: 'tess-pc', link: true });
  check('H13 link by path: the same folder on the same computer under another project is refused, naming the owner project', clash.isError && /already filed under H13 Pathy/.test(clash.text) && !(await rawDb.collection('projects').findOne({ _id: A })).code.some(l => l.path === 'C:/h13/pathy'), clash.text.slice(0, 200));
  const sub = await mcpH(kT, 'start_work', { path: 'C:/h13/pathy/deep/er', machine: 'TESS-PC', label: 'h13' });
  const subOther = await mcpH(kT, 'start_work', { path: 'C:/h13/pathy/deep/er', machine: 'another-pc', label: 'h13' });
  check('H13 link by path: a session below the linked folder, on that computer, checks in; on another computer it does not', sub.json?.project?.id === PA && sub.json?.project?.matchedBy?.how === 'path' && subOther.json?.unmatched === true, sub.text.slice(0, 160));

  const un1 = await mcpH(cc, 'start_work', { path: 'C:/h13/zzz-none', machine: 'pc-one', folder: 'h13fb' });
  check('H13 onThisPc: an unmatched answer with the caller\'s folder lists the projects linked on that computer by project and folder name', un1.json?.unmatched === true && un1.json.onThisPc?.some(x => x.project === 'H13 Other' && x.folder === 'code/h13taken') && un1.json.onThisPc?.some(x => x.project === 'H13 Alpha'), un1.text.slice(0, 400));
  const un2 = await mcpH(kT, 'start_work', { path: 'C:/h13/zzz-none', machine: 'pc-one', folder: 'h13fb' });
  const un3 = await mcpH(kX, 'start_work', { path: 'C:/h13/zzz-none', machine: 'pc-one', folder: 'h13fb' });
  const un4 = await mcpH(cc, 'start_work', { path: 'C:/h13/zzz-none', machine: 'pc-one' });
  check('H13 onThisPc: another member, another organization, and a call without folder get no onThisPc, and no error', [un2, un3, un4].every(r => !r.isError && r.json?.unmatched === true && !('onThisPc' in r.json)), [un2, un3, un4].map(r => r.text.slice(0, 120)).join(' | '));
  const gp2 = await mcpH(cc, 'get_project', { path: 'C:/h13/zzz-none' });
  check('H13 get_project: stays read-only (no link, no quiet, no onThisPc)', gp2.json?.unmatched === true && !('onThisPc' in gp2.json), gp2.text.slice(0, 200));

  // ── 4. The device-key route: the folder ids decide the project; unfiled and quiet answers
  const post = async (cred, body = {}) => {
    const r = await fetch(`${B}/api/agent/start`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', authorization: `Bearer ${cred}` }, body: JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, text, json };
  };
  await must(cc, 'add_project', { name: 'H13 Route A', code: [{ remote: 'acme/h13-route' }] });
  await must(cc, 'add_project', { name: 'H13 Route B' });
  const RA = await pid('H13 Route A');
  const RB = await pid('H13 Route B');
  await rawDb.collection('workerFolders').insertMany([
    fold(pc1, ME, 'rtparent', RA), fold(pc1, ME, 'rtchild', RB), fold(pc1, ME, 'rtfree'), { ...fold(pc1, ME, 'rtgone', RA), missing: true }, fold(pc2, ME, 'rtother', RA),
    fold(tPc, T, 'rttess'),
  ]);
  const at = (folders, extra = {}) => ({ folders, remote: 'https://github.com/acme/h13-route.git', branch: 'main', path: 'C:/h13/rt', machine: 'rt-pc', label: 'Claude Code', ...extra });
  const r1 = await post(pc1.key, at(['rtchild', 'rtparent']));
  check('H13 route: the first linked folder in the order given decides (the longest, a nested folder of another project)', r1.status === 200 && r1.json?.brief?.project?.id === RB && /^wst_/.test(r1.json?.token ?? ''), `${r1.status} ${r1.text.slice(0, 200)}`);
  const r2 = await post(pc1.key, at(['rtfree', 'rtparent']));
  check('H13 route: an unlinked folder first falls through to the linked folder above it', r2.status === 200 && r2.json?.brief?.project?.id === RA, `${r2.status} ${r2.text.slice(0, 200)}`);
  const r3 = await post(pc1.key, at(['rtfree']));
  check('H13 route: an unlinked folder whose remote is a linked project\'s remote gets 404 unfiled, not that project (the old hole)', r3.status === 404 && r3.json?.unfiled === true && !r3.json?.quiet && !/H13|Route/.test(r3.text), `${r3.status} ${r3.text}`);
  const r3b = await post(pc1.key, at([]));
  check('H13 route: no folder ids at all, with that remote: 404 unfiled as well', r3b.status === 404 && r3b.json?.unfiled === true, `${r3b.status} ${r3b.text}`);
  const r4 = await post(pc1.key, at(['rtgone']));
  const r5 = await post(pc1.key, at(['rtother']));
  const r6 = await post(pc1.key, at(['nosuchfolder']));
  check('H13 route: a missing folder, a folder linked on another computer, and an unknown id are all the same 404', [r4, r5, r6].every(r => r.status === 404 && r.text === r3.text), [r4, r5, r6].map(r => `${r.status} ${r.text.slice(0, 80)}`).join(' | '));
  const r7 = await post(tPc.key, at(['rtparent']));
  const r7b = await post(xPc.key, at(['rtparent']));
  check('H13 route: another member\'s and another organization\'s computer cannot use the owner\'s folder id (404)', r7.status === 404 && r7b.status === 404 && r7.text === r3.text, `${r7.status} ${r7b.status}`);
  const old = await post(pc1.key, { remote: 'https://github.com/acme/h13-route.git', branch: 'main', path: 'C:/h13/rt', machine: 'rt-pc', label: 'Claude Code' });
  check('H13 route (step 8): a body without folders (an old hook) finds no project, whatever its remote and path say', old.json?.unfiled === true && !old.json?.brief, `${old.status} ${old.text.slice(0, 200)}`);
  const T1 = r1.json?.token ?? '';
  const tOk = await post(T1, at(['rtchild']));
  const tOther = await post(T1, at(['rtparent']));
  check('H13 route: a session token at its own folder works; at a folder linked to another project it moves the same session there (same id, no 403)', tOk.status === 200 && tOther.status === 200 && tOther.json?.brief?.session === tOk.json?.brief?.session && tOther.json?.brief?.project?.id !== tOk.json?.brief?.project?.id, `${tOk.status} ${tOther.status}`);
  const bad = [['nine ids', at(Array.from({ length: 9 }, (_, i) => `rtfold${i}`))], ['a bad id', at(['a b!'])], ['too short', at(['ab'])], ['not an array', at('rtparent')]];
  for (const [what, b] of bad) check(`H13 route: folders with ${what} is a 400`, (await post(pc1.key, b)).status === 400);

  // Quiet: the person's "not Work OS" list, consulted only when no folder is linked
  const qa = await post(pc1.key, at(['rtfree'], { path: 'D:/Scratch/Thing/sub/deeper', machine: 'PC-One' }));
  check('H13 quiet route: a folder below one marked not Work OS gets 404 with quiet: true', qa.status === 404 && qa.json?.unfiled === true && qa.json?.quiet === true, `${qa.status} ${qa.text}`);
  const qb = await post(pc1.key, at(['rtfree'], { path: 'D:/Scratch/Thing/sub/deeper', machine: 'other-pc' }));
  const qc = await post(pc1.key, at(['rtfree'], { path: 'D:/Scratch/Thingy', machine: 'pc-one' }));
  check('H13 quiet route: the same path on another computer, or a sibling folder with the same prefix, is not quiet', !qb.json?.quiet && !qc.json?.quiet && qb.status === 404 && qc.status === 404, `${qb.text} ${qc.text}`);
  const qd = await post(pc1.key, at(['rtparent'], { path: 'D:/Scratch/Thing', machine: 'pc-one' }));
  check('H13 quiet route: a linked folder is never silenced by the list (still 200)', qd.status === 200 && qd.json?.brief?.project?.id === RA, `${qd.status} ${qd.text.slice(0, 160)}`);
  const qe = await post(tPc.key, at(['rttess'], { path: 'D:/Scratch/Thing/sub', machine: 'pc-one' }));
  check('H13 quiet route: another member\'s computer does not see the owner\'s list', qe.status === 404 && !qe.json?.quiet, `${qe.status} ${qe.text}`);

  // ── 8. A path link belongs to the person who made it: two people with a same-named computer and the same path do not collide
  await must(cc, 'add_project', { name: 'H13 Mine' });
  await must(kT, 'add_project', { name: 'H13 Tess Own' });
  const lk1 = await mcpH(cc, 'start_work', { project: 'H13 Mine', path: 'C:/h13/shared', machine: 'Same-PC', link: true });
  const stored8 = (await rawDb.collection('projects').findOne({ name: 'H13 Mine' })).code.find(l => l.path);
  check('H13 by: start_work link with a path stores the linking person on the location', !lk1.isError && stored8?.by === ME.userId && stored8?.machine === 'same-pc', JSON.stringify(stored8) + lk1.text.slice(0, 120));
  const mine8 = await mcpH(cc, 'start_work', { path: 'C:/h13/shared/sub', machine: 'same-pc', label: 'h13 by owner' });
  const hers8 = await mcpH(kT, 'start_work', { path: 'C:/h13/shared/sub', machine: 'same-pc', label: 'h13 by tess' });
  check('H13 by: the linking person matches their own link; a member with the same computer name and path gets no match', mine8.json?.project?.name === 'H13 Mine' && hers8.json?.unmatched === true && !hers8.json?.project, `${mine8.text.slice(0, 100)} | ${hers8.text.slice(0, 160)}`);
  const gp8 = await mcpH(kT, 'get_project', { path: 'C:/h13/shared', machine: 'same-pc', depth: 'project' });
  check('H13 by: get_project by that path is unmatched for the other member too', gp8.json?.unmatched === true, gp8.text.slice(0, 160));
  const lk2 = await mcpH(kT, 'start_work', { project: 'H13 Tess Own', path: 'C:/h13/shared', machine: 'Same-PC', link: true });
  check('H13 by: the other member can link the same path on a same-named computer (it is not "already filed")', !lk2.isError, lk2.text.slice(0, 200));
  const hers8b = await mcpH(kT, 'start_work', { path: 'C:/h13/shared/sub', machine: 'same-pc', label: 'h13 by tess 2' });
  const mine8b = await mcpH(cc, 'start_work', { path: 'C:/h13/shared/sub', machine: 'same-pc', label: 'h13 by owner 2' });
  check('H13 by: each person then finds their own project at the same path', hers8b.json?.project?.name === 'H13 Tess Own' && mine8b.json?.project?.name === 'H13 Mine', `${hers8b.text.slice(0, 100)} | ${mine8b.text.slice(0, 100)}`);
  const lk3 = await mcpH(cc, 'start_work', { project: 'H13 Other', path: 'C:/h13/shared', machine: 'Same-PC', link: true });
  check('H13 by: one person still cannot file the same folder under a second project', lk3.isError && /already filed/i.test(lk3.text), lk3.text.slice(0, 200));
} catch (e) {
  check('flow-h13 threw', false, String(e?.stack || e));
}
await finish();
