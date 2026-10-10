import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ticket.mjs');

function setup() {
    const vault = mkdtempSync(join(tmpdir(), 'xenophon-'));
    const clean = { ...process.env };
    delete clean.XENOPHON_DECIDER;
    delete clean.XENOPHON_CONFIG;
    const run = (...a) => runWith({}, ...a);
    const runIn = (proj, ...a) => spawnSync('node', [SCRIPT, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8', env: clean });
    const runWith = (env, ...a) => spawnSync('node', [SCRIPT, ...a, '--vault', vault, '--project', 'demo'], { encoding: 'utf8', env: { ...clean, ...env } });
    const file = (id, archived = false, proj = 'demo') => join(vault, 'Projects', proj, 'Tickets', archived ? 'Archive' : '', `${id}.md`);
    const read = (id, archived, proj) => readFileSync(file(id, archived, proj), 'utf8');
    return { vault, run, runIn, runWith, file, read };
}

const BASE = ['new', '--title', 'Retry storm on checkout', '--problem', 'Retries fan out.', '--done', 'One retry per request.'];

// ── Template rendering ────────────────────────────────────────────────────────
test('new renders the template sections in order with defaults', () => {
    const { run, read } = setup();
    const r = run(...BASE, '--context', 'Seen in prod.', '--scope', 'cap retries', '--accept', 'unit test', '--out', 'backoff', '--points', '2',
        '--evidence', 'src/a.ts:10 - loop', '--link', 'PR 12');
    assert.equal(r.status, 0, r.stderr);
    const t = read('demo-001');
    const order = ['## Problem', '## Context', '## Scope', '## What done looks like', '## Acceptance criteria', '## Out of scope',
        '## Estimate', '## Decisions needed', '## Evidence / file:line', '## Links', '## Log'].map((h) => t.indexOf(h));
    assert.ok(order.every((i) => i >= 0), `missing section: ${order}`);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.match(t, /- \[ \] unit test/);
    assert.match(t, /2 story points/);
    assert.match(t, /decision_needed: false/);
    assert.match(t, /\*\*Decision needed\*\* `no` · \*\*Status\*\*/);
    assert.match(t, /## Decisions needed\n\n> Internal[^\n]*\n\nNone/);
    assert.match(t, new RegExp(`- ${new Date().toISOString().slice(0, 10)}: Filed\\.`));
});

test('--decision renders options, recommendation and stakes and flips the flag', () => {
    const { run, read } = setup();
    const r = run(...BASE, '--decision', 'Cap at 3? | 3 or 5 | 3 | pages on-call if wrong');
    assert.equal(r.status, 0, r.stderr);
    const t = read('demo-001');
    assert.match(t, /decision_needed: true/);
    assert.match(t, /\*\*Decision needed\*\* `yes`/);
    assert.match(t, /1\. \*\*Cap at 3\?\*\*\n {3}- Options: 3 or 5\n {3}- Recommendation: 3\n {3}- Stakes: pages on-call if wrong/);
});

test('incomplete --decision, missing --done, bad --points and mixed --body-file are rejected', () => {
    const { run, vault } = setup();
    assert.notEqual(run(...BASE, '--decision', 'only | three | parts').status, 0);
    assert.notEqual(run('new', '--title', 'x', '--problem', 'p').status, 0);
    assert.notEqual(run(...BASE, '--points', '8').status, 0);
    assert.notEqual(run(...BASE, '--body-file', '-').status, 0);
    assert.equal(existsSync(join(vault, 'Projects', 'demo', 'Tickets', 'demo-001.md')), false);
});

test('--body-file keeps the legacy shape (no template, no decision_needed)', () => {
    const s = setup();
    const out = spawnSync('node', [SCRIPT, 'new', '--title', 'Old style', '--body-file', '-', '--vault', s.vault, '--project', 'demo'],
        { encoding: 'utf8', input: '## Description\n\nhand written\n' });
    assert.equal(out.status, 0, out.stderr);
    const t = s.read('demo-001');
    assert.match(t, /## Description\n\nhand written/);
    assert.doesNotMatch(t, /decision_needed|Decision needed|## Problem/);
});

// ── Browsing ──────────────────────────────────────────────────────────────────
test('list --decisions shows only tickets awaiting a decision; old tickets are unaffected', () => {
    const { run, file, read } = setup();
    run(...BASE);
    run('new', '--title', 'Needs a call', '--problem', 'p', '--done', 'd', '--decision', 'A? | x or y | x | cost');
    mkdirSync(dirname(file('demo-900')), { recursive: true });
    writeFileSync(file('demo-900'), '---\nid: "demo-900"\ntitle: "Pre-template"\nstatus: "open"\nreviewed: false\ntype: "task"\npriority: 2\nlabels: []\nblocked-by: []\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# demo-900\n\n## Description\n\nold\n');
    const dec = run('list', '--decisions').stdout;
    assert.match(dec, /demo-002/);
    assert.doesNotMatch(dec, /demo-001|demo-900/);
    assert.match(dec, /decision needed/);
    assert.match(run('list').stdout, /demo-900/);
    // rewriting an old ticket must not invent decision_needed
    run('set', 'demo-900', '--priority', '1');
    assert.doesNotMatch(read('demo-900'), /decision_needed/);
});

// ── decide / log ──────────────────────────────────────────────────────────────
test('decide replaces "None", numbers further decisions, and syncs frontmatter and header', () => {
    const { run, read } = setup();
    run(...BASE);
    assert.equal(run('decide', 'demo-001', '--decision', 'Ship now? | yes or wait | wait | revenue').status, 0);
    let t = read('demo-001');
    assert.match(t, /decision_needed: true/);
    assert.match(t, /\*\*Decision needed\*\* `yes` · \*\*Status\*\*/);
    assert.doesNotMatch(t, /\nNone\n/);
    assert.match(t, /1\. \*\*Ship now\?\*\*/);
    run('decide', 'demo-001', '--decision', 'Who owns it? | A or B | A | delay');
    t = read('demo-001');
    assert.match(t, /2\. \*\*Who owns it\?\*\*/);
    assert.ok(t.indexOf('2. **Who owns') < t.indexOf('## Evidence'), 'appended inside the decisions section');
    run('decide', 'demo-001', '--clear');
    t = read('demo-001');
    assert.match(t, /decision_needed: false/);
    assert.match(t, /\*\*Decision needed\*\* `no`/);
    assert.match(t, /1\. \*\*Ship now\?\*\*/, 'clear keeps the record');
    assert.notEqual(run('decide', 'demo-001').status, 0);
});

test('log appends a dated line inside the Log section and creates it on old tickets', () => {
    const { run, file, read } = setup();
    run(...BASE);
    run('log', 'demo-001', 'Reproduced on', 'stg');
    const t = read('demo-001');
    assert.match(t, new RegExp(`- ${new Date().toISOString().slice(0, 10)}: Reproduced on stg\\n$`));
    mkdirSync(dirname(file('demo-900')), { recursive: true });
    writeFileSync(file('demo-900'), '---\nid: "demo-900"\ntitle: "Old"\nstatus: "open"\nreviewed: false\ntype: "task"\npriority: 2\nlabels: []\nblocked-by: []\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# demo-900 — Old\n\n**Status** `open`\n\n## Description\n\nbody\n');
    assert.equal(run('log', 'demo-900', 'poked it').status, 0);
    assert.match(read('demo-900'), /## Description\n\nbody\n\n## Log\n\n- \d{4}-\d\d-\d\d: poked it\n$/);
    assert.equal(run('decide', 'demo-900', '--decision', 'Q? | a or b | a | s').status, 0);
    const o = read('demo-900');
    assert.match(o, /\*\*Decision needed\*\* `yes` · \*\*Status\*\*/);
    assert.ok(o.indexOf('## Decisions needed') < o.indexOf('## Log'), 'decisions inserted before the log');
});

// ── promote ───────────────────────────────────────────────────────────────────
test('promote prints tracker-ready markdown without internal sections or vault references', () => {
    const { run, vault } = setup();
    mkdirSync(join(vault, 'Projects', 'other'), { recursive: true });
    run(...BASE, '--context', 'Mirrors demo-007 and [[2026-10-02-review]]; see [[demo-003|the retry note]]. PR #12, src/a.ts:10.',
        '--points', '3', '--decision', 'Cap? | 3 or 5 | 3 | on-call', '--evidence', 'src/a.ts:10 - loop', '--link', 'demo-002 and ledger zawg');
    run('log', 'demo-001', 'secret internal note');
    const r = run('promote', 'demo-001');
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout;
    assert.match(out, /^# Retry storm on checkout\n\n## Problem/);
    for (const keep of ['## What done looks like', '## Estimate', '3 story points', 'PR #12, src/a.ts:10', 'the retry note']) assert.ok(out.includes(keep), keep);
    for (const gone of ['Decisions needed', 'Evidence', '## Links', '## Log', 'zawg', 'secret internal note', 'demo-007', 'demo-001', '[[', 'Internal', '**Status**', 'Decision needed']) {
        assert.ok(!out.includes(gone), `leaked: ${gone}`);
    }
    assert.match(r.stderr, /removed 3 vault reference/);
});

test('promote is read-only and handles legacy tickets', () => {
    const { run, file, read } = setup();
    mkdirSync(dirname(file('demo-900')), { recursive: true });
    const legacy = '---\nid: "demo-900"\ntitle: "Old"\nstatus: "open"\nreviewed: false\ntype: "task"\npriority: 2\nlabels: []\nblocked-by: []\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# demo-900 — Old\n\n**Status** `open` · **Priority** `P2`\n\n#a #b\n\n## Description\n\nbody\n\n## Decision (Jack, 2026-10-01)\n\nship it\n';
    writeFileSync(file('demo-900'), legacy);
    const r = run('promote', 'demo-900');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '# Old\n\n## Description\n\nbody\n');
    assert.match(r.stderr, /What done looks like/);
    assert.equal(read('demo-900'), legacy, 'promote must not write');
});

test('promote emits only allowlisted headings and only the title from the preamble', () => {
    const { run, file } = setup();
    mkdirSync(dirname(file('demo-901')), { recursive: true });
    const body = '---\nid: "demo-901"\ntitle: "T"\nstatus: "open"\nreviewed: false\ntype: "task"\npriority: 2\nlabels: ["area/x"]\nblocked-by: []\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# demo-901 — T\n\n**Status** `open`\n\n#area/x #v1.2\n\n## Problem\n\np\n\n## What done looks like\n\nd\n\n## Decisions made\n\nsecret choice\n\n## Related notes\n\nprivate\n\n## Log\n\n- x\n';
    writeFileSync(file('demo-901'), body);
    const r = run('promote', 'demo-901');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '# T\n\n## Problem\n\np\n\n## What done looks like\n\nd\n');
    assert.match(r.stderr, /dropped non-public section\(s\): Related notes/);
});

test('promote strips embeds without a stray "!" and keeps the label of obsidian:// links', () => {
    const { run, file } = setup();
    mkdirSync(dirname(file('demo-902')), { recursive: true });
    writeFileSync(file('demo-902'), '---\nid: "demo-902"\ntitle: "T"\nstatus: "open"\nreviewed: false\ntype: "task"\npriority: 2\nlabels: []\nblocked-by: []\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# demo-902 — T\n\n## Problem\n\nSee ![[shot.png]] and [the note](obsidian://open?vault=v&file=n) then [[a]].\n');
    const r = run('promote', 'demo-902');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '# T\n\n## Problem\n\nSee  and the note then .\n');
});

// ── Configurable decider ──────────────────────────────────────────────────────
test('heading is generic by default and takes the decider from env or the config file (env wins)', () => {
    const { vault, run, runWith, read } = setup();
    run(...BASE);
    assert.match(read('demo-001'), /\n## Decisions needed\n/);
    runWith({ XENOPHON_DECIDER: 'Sam' }, ...BASE);
    assert.match(read('demo-002'), /\n## Decisions needed \(for Sam\)\n/);
    writeFileSync(join(vault, 'xenophon-config.md'), '# cfg\n\n```xenophon-config\ndecider: Jack   # comment\n```\n');
    run(...BASE);
    assert.match(read('demo-003'), /\n## Decisions needed \(for Jack\)\n/);
    runWith({ XENOPHON_DECIDER: 'Sam' }, ...BASE);
    assert.match(read('demo-004'), /\(for Sam\)/);
    runWith({ XENOPHON_CONFIG: join(vault, 'missing.md') }, ...BASE);
    assert.match(read('demo-005'), /\n## Decisions needed\n/);
});

test('decide and promote find the section under any configured name, old "(for Jack)" tickets included', () => {
    const { run, runWith, read } = setup();
    runWith({ XENOPHON_DECIDER: 'Jack' }, ...BASE);
    // config changed since filing: heading on disk no longer matches the configured one
    assert.equal(runWith({ XENOPHON_DECIDER: 'Sam' }, 'decide', 'demo-001', '--decision', 'Q? | a or b | a | s').status, 0);
    const t = read('demo-001');
    assert.equal((t.match(/## Decisions needed/g) || []).length, 1);
    assert.match(t, /## Decisions needed \(for Jack\)[\s\S]*1\. \*\*Q\?\*\*/);
    const out = runWith({ XENOPHON_DECIDER: 'Sam' }, 'promote', 'demo-001').stdout;
    assert.ok(!out.includes('Decisions needed') && !out.includes('Q?'));
    assert.equal(run('promote', 'demo-001').stdout, out);
});

// ── Strict flags ──────────────────────────────────────────────────────────────
test('new --body fails loudly, names the flag, suggests --body-file and writes nothing', () => {
    const { run, file } = setup();
    const r = run('new', '--title', 'T', '--body', 'text');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown flag --body for 'new' \(did you mean --body-file\?\)/);
    assert.equal(existsSync(file('demo-001')), false);
});

test('every subcommand rejects an unknown flag before writing', () => {
    const { run, read } = setup();
    assert.equal(run(...BASE).status, 0);
    const before = read('demo-001');
    for (const c of [['list'], ['close', 'demo-001'], ['reopen', 'demo-001'], ['set', 'demo-001'], ['decide', 'demo-001'],
        ['log', 'demo-001', 'note'], ['promote', 'demo-001'], ['index']]) {
        const r = run(...c, '--bogus');
        assert.equal(r.status, 1, `${c[0]}: ${r.stderr}`);
        assert.match(r.stderr, /unknown flag --bogus/);
    }
    assert.equal(read('demo-001'), before);
});

test('a flag valid for one command is rejected on another, and --flag=value is not silently ignored', () => {
    const { run, read } = setup();
    assert.equal(run(...BASE).status, 0);
    assert.match(run('close', 'demo-001', '--priority', '1').stderr, /unknown flag --priority for 'close'/);
    assert.match(run('set', 'demo-001', '--priority=1').stderr, /unknown flag --priority=1/);
    assert.match(read('demo-001'), /priority: 2/);
});

test('known flags and --body-file - on stdin still work', () => {
    const { vault, run, read } = setup();
    assert.equal(run(...BASE, '--priority', '1', '--labels', 'a').status, 0);
    assert.equal(run('set', 'demo-001', '--priority', '3').status, 0);
    assert.match(read('demo-001'), /priority: 3/);
    const r = spawnSync('node', [SCRIPT, 'new', '--title', 'Legacy', '--body-file', '-', '--vault', vault, '--project', 'demo'], { input: 'Hand written.', encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(read('demo-002'), /Hand written\./);
});

// ── Parents ───────────────────────────────────────────────────────────────────
const PARENT = ['new', '--type', 'epic', '--title', 'Checkout overhaul', '--problem', 'Too many parts.', '--done', 'All parts shipped.'];
const CHILD = ['new', '--title', 'Child work', '--problem', 'p', '--done', 'd'];

test('new --parent and set --parent write a parent field; set --parent none clears it', () => {
    const { run, read } = setup();
    run(...PARENT);
    assert.equal(run(...CHILD, '--parent', 'demo-001').status, 0);
    assert.match(read('demo-002'), /blocked-by: \[\]\nparent: "demo-001"\ncreated:/);
    run(...CHILD);
    assert.doesNotMatch(read('demo-003'), /parent:/);
    assert.equal(run('set', 'demo-003', '--parent', 'demo-001').status, 0);
    assert.match(read('demo-003'), /parent: "demo-001"/);
    assert.equal(run('set', 'demo-002', '--priority', '1').status, 0);
    assert.match(read('demo-002'), /parent: "demo-001"/, 'other edits keep the parent');
    assert.equal(run('set', 'demo-003', '--parent', 'none').status, 0);
    assert.doesNotMatch(read('demo-003'), /parent:/);
});

test('any ticket may be a parent and nesting is not limited', () => {
    const { run, read } = setup();
    run(...CHILD);
    assert.equal(run(...CHILD, '--parent', 'demo-001').status, 0, 'a task as parent');
    assert.equal(run(...PARENT, '--parent', 'demo-002').status, 0, 'an epic under a task');
    assert.equal(run(...CHILD, '--parent', 'demo-003').status, 0);
    assert.match(read('demo-004'), /parent: "demo-003"/);
});

test('parent refusals: missing, self, unsafe id, cycle (with its path); nothing is written', () => {
    const { run, file, read } = setup();
    run(...CHILD);
    run(...CHILD, '--parent', 'demo-001');
    run(...CHILD, '--parent', 'demo-002');
    const before = read('demo-001');
    const cases = [
        [['set', 'demo-001', '--parent', 'demo-099'], /No such parent ticket: demo-099/],
        [['set', 'demo-001', '--parent', 'demo-001'], /own parent/],
        [['set', 'demo-001', '--parent', '../etc/x-1'], /invalid parent id/],
        [['set', 'demo-001', '--parent', 'demo-003'], /cycle: demo-001 -> demo-003 -> demo-002 -> demo-001/],
        [['new', ...CHILD.slice(1), '--parent', 'demo-099'], /No such parent/],
    ];
    for (const [c, re] of cases) {
        const r = run(...c);
        assert.equal(r.status, 1, c.join(' '));
        assert.match(r.stderr, re);
    }
    assert.equal(read('demo-001'), before);
    assert.equal(existsSync(file('demo-004')), false, 'a refused new writes nothing');
});

test('a child in another project resolves its parent by id; an unknown project is refused', () => {
    const { run, runIn, read } = setup();
    run(...PARENT);
    const r = runIn('other', ...CHILD, '--parent', 'demo-001');
    assert.equal(r.status, 0, r.stderr);
    assert.match(read('other-001', false, 'other'), /parent: "demo-001"/);
    const bad = runIn('other', ...CHILD, '--parent', 'nowhere-001');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /No such parent ticket: nowhere-001/);
    assert.equal(runIn('other', 'set', 'other-001', '--parent', 'none').status, 0);
});

// ── Tree, rollup, list --under / --tree ───────────────────────────────────────
/** Write a minimal ticket straight to disk (fast path for big fixtures). */
function put(vault, proj, id, { parent, status = 'open', type = 'task', priority = 2, points } = {}) {
    const dir = join(vault, 'Projects', proj, 'Tickets', status === 'closed' ? 'Archive' : '');
    mkdirSync(dir, { recursive: true });
    const fm = ['---', `id: "${id}"`, `title: "T ${id}"`, `status: "${status}"`, 'reviewed: false', `type: "${type}"`, `priority: ${priority}`,
        'labels: []', 'blocked-by: []', ...(parent ? [`parent: "${parent}"`] : []), 'created: 2026-01-01', 'updated: 2026-01-01', '---', '', `# ${id}`, ''];
    const est = points ? ['## Estimate', '', `${points} story points`, ''] : [];
    writeFileSync(join(dir, `${id}.md`), [...fm, ...est].join('\n'));
}

function sampleTree() {
    const s = setup();
    put(s.vault, 'demo', 'demo-001', { type: 'epic' });
    put(s.vault, 'demo', 'demo-002', { parent: 'demo-001', status: 'closed', points: 3 });
    put(s.vault, 'demo', 'demo-003', { parent: 'demo-001', status: 'blocked', points: 2 });
    put(s.vault, 'demo', 'demo-004', { parent: 'demo-003', status: 'closed', points: 5 });
    put(s.vault, 'demo', 'demo-005', { parent: 'demo-003' });
    put(s.vault, 'demo', 'demo-006');
    return s;
}

test('rollup is recursive over every descendant, shown only on tickets with children, and never stored', () => {
    const { vault, run, read } = sampleTree();
    const out = run('list').stdout;
    assert.match(out, /demo-001 .*▣ 2\/4 closed \(2 direct\), 1 blocked, 8\/10 pts/);
    assert.match(out, /demo-003 .*▣ 1\/2 closed, 5\/5 pts/);
    assert.doesNotMatch(out.split('\n').find((l) => l.includes('demo-005')), /▣/);
    assert.doesNotMatch(out.split('\n').find((l) => l.includes('demo-006')), /▣|↑/);
    assert.match(out.split('\n').find((l) => l.includes('demo-005')), /↑ demo-003/);
    run('index');
    const idx = readFileSync(join(vault, 'Projects', 'demo', 'Tickets', '_Index.md'), 'utf8');
    assert.match(idx, /demo-001\|T demo-001\]\].*▣ 2\/4 closed \(2 direct\), 1 blocked, 8\/10 pts/);
    assert.match(idx, /demo-005\|T demo-005\]\].*↑ \[\[demo-003\]\]/);
    assert.doesNotMatch(read('demo-001'), /2\/4 closed|▣/, 'its own rollup is not written into the note');
});

test('list --under (alias --epic) lists descendants, --depth limits levels, other projects included', () => {
    const { vault, run, runIn } = sampleTree();
    put(vault, 'other', 'other-001', { parent: 'demo-005' });
    const all = run('list', '--under', 'demo-001', '--status', 'all').stdout;
    for (const id of ['demo-002', 'demo-003', 'demo-004', 'demo-005', 'other-001']) assert.match(all, new RegExp(id));
    assert.doesNotMatch(all, /demo-006|^P2  demo-001 /m);
    const one = run('list', '--epic', 'demo-001', '--depth', '1', '--status', 'all').stdout;
    assert.match(one, /demo-002/);
    assert.match(one, /demo-003/);
    assert.doesNotMatch(one, /demo-004|demo-005|other-001/);
    assert.match(runIn('other', 'list', '--under', 'demo-003').stdout, /demo-005/);
    assert.equal(run('list', '--under', 'demo-999').status, 1);
    assert.equal(run('list', '--depth', '2').status, 1);
    assert.equal(run('list', '--tree', '--depth', '0').status, 1);
});

test('list --tree draws an ASCII tree; closed nodes stay when open work is below them', () => {
    const { run } = sampleTree();
    const t = run('list', '--tree').stdout;
    assert.equal(t, [
        'demo-001 [epic] open P2  T demo-001  ▣ 2/4 closed (2 direct), 1 blocked, 8/10 pts',
        '└─ demo-003 [task] blocked P2 2pt  T demo-003  ▣ 1/2 closed, 5/5 pts',
        '   └─ demo-005 [task] open P2  T demo-005',
        'demo-006 [task] open P2  T demo-006',
        '', '4 ticket(s)', ''].join('\n'));
    const full = run('list', '--tree', '--under', 'demo-001', '--status', 'all').stdout.split('\n').slice(0, 5);
    assert.deepEqual(full.map((l) => l.replace(/  ▣.*/, '')), [
        'demo-001 [epic] open P2  T demo-001',
        '├─ demo-002 [task] closed P2 3pt  T demo-002',
        '└─ demo-003 [task] blocked P2 2pt  T demo-003',
        '   ├─ demo-004 [task] closed P2 5pt  T demo-004',
        '   └─ demo-005 [task] open P2  T demo-005']);
});

test('with no parents anywhere nothing changes: no rollup, no arrows, same index', () => {
    const { run, vault } = setup();
    run(...BASE);
    run(...BASE);
    const idx = readFileSync(join(vault, 'Projects', 'demo', 'Tickets', '_Index.md'), 'utf8');
    assert.doesNotMatch(idx, /▣|↑/);
    assert.doesNotMatch(run('list').stdout, /▣|↑/);
    assert.equal(run('list', '--tree').stdout.split('\n').filter((l) => l.startsWith('demo-')).length, 2);
});

test('a deep chain and a wide tree list well under a second and roll up fully', () => {
    const { vault, run, runIn } = setup();
    put(vault, 'demo', 'demo-0001', { points: 1 });
    for (let i = 2; i <= 201; i++) put(vault, 'demo', `demo-${String(i).padStart(4, '0')}`, { parent: `demo-${String(i - 1).padStart(4, '0')}` });
    for (let i = 0; i < 30; i++) {
        put(vault, 'wide', `wide-${i}`);
        for (let j = 0; j < 100; j++) put(vault, 'wide', `wideleaf-${i * 100 + j}`, { parent: `wide-${i}` });
    }
    const t0 = Date.now();
    const chain = run('list', '--tree', '--under', 'demo-0001');
    assert.equal(chain.status, 0, chain.stderr);
    assert.match(chain.stdout, /demo-0001 .*▣ 0\/200 closed \(1 direct\)/);
    assert.equal(chain.stdout.split('\n').filter((l) => /demo-\d{4}/.test(l)).length, 201);
    const wide = runIn('wide', 'list', '--tree');
    assert.equal(wide.status, 0, wide.stderr);
    assert.match(wide.stdout, /wide-29 .*▣ 0\/100 closed/);
    assert.ok(Date.now() - t0 < 2000, `two tree listings of ~3200 tickets took ${Date.now() - t0}ms`);
});

test('a hand-edited cycle is reported and its closing edge ignored; nothing hangs or crashes', () => {
    const { vault, run } = setup();
    put(vault, 'demo', 'demo-001', { parent: 'demo-003' });
    put(vault, 'demo', 'demo-002', { parent: 'demo-001' });
    put(vault, 'demo', 'demo-003', { parent: 'demo-002' });
    put(vault, 'demo', 'demo-004', { parent: 'demo-004' });
    for (const cmd of [['list'], ['list', '--tree'], ['index']]) {
        const r = run(...cmd);
        assert.equal(r.status, 0, `${cmd}: ${r.stderr}`);
        assert.match(r.stderr, /warning: parent cycle demo-001 -> demo-003 -> demo-002 -> demo-001; ignoring the parent of demo-002/);
    }
    assert.match(run('list', '--tree').stdout, /demo-002 .*▣ 0\/2 closed \(1 direct\)/);
});

// ── Children table and show ───────────────────────────────────────────────────
test('show prints direct children with their own rollups and writes a marked table into the note', () => {
    const { vault, run, read } = sampleTree();
    put(vault, 'other', 'other-001', { parent: 'demo-001', points: 1 });
    const r = run('show', 'demo-001');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^demo-001 \[epic\] open P2/);
    assert.match(r.stdout, /rollup: 2\/5 closed \(3 direct\), 1 blocked, 8\/11 pts/);
    const note = read('demo-001');
    const block = note.slice(note.indexOf('<!-- xenophon:children -->'), note.indexOf('<!-- /xenophon:children -->'));
    assert.match(block, /\| \[\[demo-003\]\] \| blocked \| task \| 2 \| T demo-003 \| 1\/2 closed, 5\/5 pts \|/);
    assert.match(block, /\| \[\[other-001\]\] \| open \| task \| 1 \| T other-001 \| {2}\|/);
    assert.doesNotMatch(block, /demo-004|demo-005/, 'direct children only');
    assert.match(note, /^---\nid: "demo-001"/);
    assert.match(run('show', 'demo-006').stdout, /^demo-006 \[task\] open P2/);
    assert.doesNotMatch(run('show', 'demo-006').stdout, /\|/);
    assert.equal(run('show', 'demo-999').status, 1);
});

test('the children table is idempotent and everything outside the markers is preserved', () => {
    const { vault, run, file, read } = sampleTree();
    run('show', 'demo-001');
    const first = read('demo-001');
    assert.doesNotMatch(run('show', 'demo-001').stdout, /updated|created/);
    assert.equal(read('demo-001'), first);
    writeFileSync(file('demo-001'), `${first.replace('# demo-001', '# demo-001\n\nhand written intro')}\n\n## Notes\n\nkept\n`);
    put(vault, 'demo', 'demo-007', { parent: 'demo-001' });
    run('index');
    const after = read('demo-001');
    assert.match(after, /hand written intro/);
    assert.match(after, /## Notes\n\nkept\n$/);
    assert.match(after, /\[\[demo-007\]\]/, 'index refreshes the table');
    assert.equal(after.split('<!-- xenophon:children -->').length, 2, 'one block only');
});

test('index refreshes the table of a parent in another project when a child changes', () => {
    const { run, runIn, read } = setup();
    run(...PARENT);
    runIn('other', ...CHILD, '--parent', 'demo-001', '--points', '2');
    assert.match(read('demo-001'), /\[\[other-001\]\] \| open/);
    runIn('other', 'close', 'other-001');
    assert.match(read('demo-001'), /\[\[other-001\]\] \| closed/);
});

test('promote drops the Children section without a warning', () => {
    const { run } = sampleTree();
    run('show', 'demo-001');
    const r = run('promote', 'demo-001');
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /Children|xenophon:children|\|/);
    assert.doesNotMatch(r.stderr, /Children/);
});

// ── Closing a parent ──────────────────────────────────────────────────────────
test('close refuses a ticket with open descendants (any depth, any project) unless --force', () => {
    const { vault, run, runIn, file, read } = sampleTree();
    put(vault, 'other', 'other-001', { parent: 'demo-005' });
    const r = run('close', 'demo-001');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /demo-001 has 3 open descendant\(s\): demo-003, demo-005, other-001/);
    assert.match(r.stderr, /--force/);
    assert.equal(existsSync(file('demo-001')), true, 'nothing moved');
    assert.doesNotMatch(read('demo-001'), /status: "closed"/);
    const f = run('close', 'demo-001', '--force');
    assert.equal(f.status, 0, f.stderr);
    assert.match(f.stderr, /3 open descendant/);
    assert.match(read('demo-001', true), /status: "closed"/);
    assert.equal(runIn('other', 'close', 'other-001').status, 0, 'a leaf closes without --force');
});

test('close needs no --force when every descendant is already closed', () => {
    const { run } = sampleTree();
    assert.equal(run('close', 'demo-005').status, 0);
    assert.equal(run('close', 'demo-003').status, 0);
    const r = run('close', 'demo-001');
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /warning/);
});

// ── Supporting docs: attach ───────────────────────────────────────────────────
function note(vault, rel, text) {
    const path = join(vault, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
}
const PLAN = 'Projects/demo/Plans/rollout.md';

test('attach stamps ticket and kind into a note that has frontmatter, keeping every other line and the body', () => {
    const { vault, run } = sampleTree();
    const text = '---\ntitle: "Rollout: phase 1"\nstatus: draft\ncustom-key: [a, b]\nupdated: 2026-10-01\n---\n# Rollout\n\nBody with --- and `code`.\n';
    const path = note(vault, PLAN, text);
    const r = run('attach', PLAN, '--ticket', 'demo-003', '--kind', 'plan');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^updated /);
    assert.equal(readFileSync(path, 'utf8'),
        '---\ntitle: "Rollout: phase 1"\nstatus: draft\ncustom-key: [a, b]\nupdated: 2026-10-01\nticket: "demo-003"\nkind: plan\n---\n# Rollout\n\nBody with --- and `code`.\n');
});

test('attach is idempotent: a second run reports unchanged and leaves the bytes alone', () => {
    const { vault, run } = sampleTree();
    const path = note(vault, PLAN, '---\ntitle: X\n---\nbody\n');
    run('attach', PLAN, '--ticket', 'demo-001', '--kind', 'plan');
    const once = readFileSync(path, 'utf8');
    const again = run('attach', PLAN, '--ticket', 'demo-001', '--kind', 'plan');
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^unchanged /);
    assert.equal(readFileSync(path, 'utf8'), once);
});

test('attaching a second ticket turns ticket into tickets and appends to tickets afterwards', () => {
    const { vault, run } = sampleTree();
    const path = note(vault, PLAN, '---\nticket: demo-001\ntitle: X\n---\nbody\n');
    run('attach', PLAN, '--ticket', 'demo-003');
    assert.equal(readFileSync(path, 'utf8'), '---\ntickets: ["demo-001", "demo-003"]\ntitle: X\n---\nbody\n');
    run('attach', PLAN, '--ticket', 'demo-005');
    assert.match(readFileSync(path, 'utf8'), /^---\ntickets: \["demo-001", "demo-003", "demo-005"\]\ntitle: X\n---\n/);
    assert.match(run('attach', PLAN, '--ticket', 'demo-003').stdout, /^unchanged /);
});

test('attach merges into a block-style tickets list and replaces ticket: none', () => {
    const { vault, run } = sampleTree();
    const block = note(vault, PLAN, '---\ntickets:\n  - demo-001\n  - "demo-002"\nkind: runbook\n---\nbody\n');
    run('attach', PLAN, '--ticket', 'demo-003');
    assert.equal(readFileSync(block, 'utf8'), '---\ntickets: ["demo-001", "demo-002", "demo-003"]\nkind: runbook\n---\nbody\n');
    const none = note(vault, 'Projects/demo/Research/r.md', '---\nticket: none\n---\nbody\n');
    run('attach', 'Projects/demo/Research/r.md', '--ticket', 'demo-001');
    assert.equal(readFileSync(none, 'utf8'), '---\nticket: "demo-001"\n---\nbody\n');
});

test('attach changes an existing kind only when --kind is given, and creates frontmatter when there is none', () => {
    const { vault, run } = sampleTree();
    const path = note(vault, PLAN, '---\nkind: research\n---\nbody\n');
    run('attach', PLAN, '--ticket', 'demo-001');
    assert.match(readFileSync(path, 'utf8'), /^---\nkind: research\nticket: "demo-001"\n---\n/);
    run('attach', PLAN, '--ticket', 'demo-001', '--kind', 'review');
    assert.match(readFileSync(path, 'utf8'), /^---\nkind: review\nticket: "demo-001"\n---\n/);
    const bare = note(vault, 'Projects/demo/Plans/bare.md', '# Bare\n\ntext\n');
    run('attach', 'Projects/demo/Plans/bare.md', '--ticket', 'demo-001');
    assert.equal(readFileSync(bare, 'utf8'), '---\nticket: "demo-001"\n---\n# Bare\n\ntext\n');
});

test('attach accepts an absolute path and --dry-run writes nothing', () => {
    const { vault, run } = sampleTree();
    const path = note(vault, PLAN, '# Plain\n');
    assert.match(run('attach', path, '--ticket', 'demo-001', '--dry-run').stdout, /^updated /);
    assert.equal(readFileSync(path, 'utf8'), '# Plain\n');
    assert.equal(run('attach', path, '--ticket', 'demo-001').status, 0);
    assert.match(readFileSync(path, 'utf8'), /ticket: "demo-001"/);
});

test('attach refuses an unknown ticket, a bad kind, a missing flag and unknown flags, writing nothing', () => {
    const { vault, run } = sampleTree();
    const path = note(vault, PLAN, '# Plain\n');
    const missing = run('attach', PLAN, '--ticket', 'demo-999');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /No such ticket: demo-999/);
    assert.equal(run('attach', PLAN, '--ticket', 'demo-001', '--kind', 'memo').status, 1);
    assert.equal(run('attach', PLAN).status, 1);
    assert.equal(run('attach', PLAN, '--ticket', 'demo-001', '--bogus', 'x').status, 1);
    assert.equal(readFileSync(path, 'utf8'), '# Plain\n');
});

test('attach accepts the positional <ticket> <note> form and rejects a wrong shape with usage', () => {
    const { vault, run } = sampleTree();
    const path = note(vault, PLAN, '---\ntitle: P\n---\nbody\n');
    const r = run('attach', 'demo-003', PLAN, '--kind', 'plan');
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(path, 'utf8'), /ticket: "demo-003"\nkind: plan/);
    assert.match(run('attach', 'demo-003', PLAN, '--kind', 'plan').stdout, /^unchanged /);
    for (const args of [['demo-003'], [PLAN, 'demo-003', 'x'], ['demo-003', PLAN, '--ticket', 'demo-001']]) {
        const bad = run('attach', ...args);
        assert.equal(bad.status, 1, args.join(' '));
        assert.match(bad.stderr, /Usage: ticket\.mjs attach <ticket> <note/);
    }
    assert.equal(run('attach', 'demo-999', PLAN).status, 1);
});

test('attach refuses paths outside Projects, ticket notes, non-markdown, secret names, missing notes and symlinks', () => {
    const { vault, run } = sampleTree();
    note(vault, 'outside.md', '# no\n');
    note(vault, 'Projects/demo/Plans/.env', 'SECRET=1\n');
    note(vault, 'Projects/demo/Plans/data.json', '{}\n');
    note(vault, 'Projects/demo/Plans/real.md', '# real\n');
    symlinkSync(join(vault, 'Projects/demo/Plans/real.md'), join(vault, 'Projects/demo/Plans/link.md'));
    symlinkSync(join(vault, 'Projects/demo/Plans'), join(vault, 'Projects/demo/Linked'));
    const bad = ['outside.md', 'Projects/../outside.md', 'Projects/demo/Tickets/demo-001.md', 'Projects/demo/Plans/.env',
        'Projects/demo/Plans/data.json', 'Projects/demo/Plans/nope.md', 'Projects/demo/Plans/link.md', 'Projects/demo/Linked/real.md'];
    for (const rel of bad) {
        const r = run('attach', rel, '--ticket', 'demo-001');
        assert.equal(r.status, 1, `${rel} should be refused`);
        assert.match(r.stderr, new RegExp(rel.replace(/[.]/g, '\\.')));
    }
    assert.equal(readFileSync(join(vault, 'outside.md'), 'utf8'), '# no\n');
    assert.equal(readFileSync(join(vault, 'Projects/demo/Plans/real.md'), 'utf8'), '# real\n');
    assert.doesNotMatch(readFileSync(join(vault, 'Projects/demo/Tickets/demo-001.md'), 'utf8'), /ticket:/, 'ticket note untouched');
});

// ── Supporting docs: docs ─────────────────────────────────────────────────────
function docsFixture() {
    const s = sampleTree();
    put(s.vault, 'other', 'other-001', { parent: 'demo-005' });
    note(s.vault, 'Projects/demo/Plans/rollout.md', '---\ntitle: "Rollout plan"\nticket: demo-001\nupdated: 2026-10-02\n---\n# x\n');
    note(s.vault, 'Projects/demo/Research/probe.md', '---\ntickets: [demo-006, demo-004]\ntype: research\nlast-updated: 2026-09-20\n---\n# Probe notes\n');
    note(s.vault, 'Projects/other/Runbooks/cutover.md', '---\nticket: other-001\nkind: uat\nupdated: 2026-10-05\n---\nbody\n');
    note(s.vault, 'Projects/demo/Notes/loose.md', '---\nepic: demo-003\n---\n# Loose note\n');
    note(s.vault, 'Projects/demo/Plans/elsewhere.md', '---\nticket: demo-006\nupdated: 2026-10-06\n---\n# Not ours\n');
    note(s.vault, 'Projects/demo/Plans/project-level.md', '---\nticket: none\n---\n# Project level\n');
    note(s.vault, 'Projects/demo/Plans/unmarked.md', '# No frontmatter\n');
    return s;
}

test('docs lists notes for the epic and every descendant, across projects, grouped by kind with title, date and path', () => {
    const { run } = docsFixture();
    const r = run('docs', 'demo-001');
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split('\n');
    const at = (re) => lines.findIndex((l) => re.test(l));
    assert.ok(at(/^plan \(1\)/) < at(/^uat \(1\)/) && at(/^uat \(1\)/) < at(/^research \(1\)/) && at(/^research \(1\)/) < at(/^other \(1\)/), r.stdout);
    assert.match(r.stdout, /2026-10-02 {2}Rollout plan {2}Projects\/demo\/Plans\/rollout\.md/);
    assert.match(r.stdout, /2026-10-05 {2}cutover {2}Projects\/other\/Runbooks\/cutover\.md/, 'doc on a grandchild in another project; title falls back to the filename');
    assert.match(r.stdout, /2026-09-20 {2}Probe notes {2}Projects\/demo\/Research\/probe\.md/, 'type: research, last-updated, tickets list');
    assert.match(r.stdout, /undated +Loose note {2}Projects\/demo\/Notes\/loose\.md/, 'epic: alias, no kind, no date');
    assert.doesNotMatch(r.stdout, /elsewhere|project-level|unmarked/);
    assert.match(r.stdout, /4 doc\(s\)/);
});

test('docs is scoped by subtree: a child ticket sees only its own docs', () => {
    const { run } = docsFixture();
    const r = run('docs', 'demo-003');
    assert.match(r.stdout, /cutover/);
    assert.match(r.stdout, /Loose note/);
    assert.doesNotMatch(r.stdout, /Rollout plan/);
});

test('docs --json carries kind, title, updated, path per item in group order', () => {
    const { run } = docsFixture();
    const j = JSON.parse(run('docs', 'demo-001', '--json').stdout);
    assert.equal(j.epic, 'demo-001');
    assert.deepEqual(j.groups.map((g) => g.kind), ['plan', 'uat', 'research', 'other']);
    assert.deepEqual(j.groups[0].items, [{ title: 'Rollout plan', kind: 'plan', updated: '2026-10-02', path: 'Projects/demo/Plans/rollout.md', tickets: ['demo-001'] }]);
    assert.equal(j.groups[3].items[0].updated, null);
});

test('docs infers kind from the folder when neither kind nor type say, and sees notes attached by attach', () => {
    const { vault, run } = docsFixture();
    note(vault, 'Projects/demo/Reviews/r1.md', '# Review one\n');
    assert.equal(run('attach', 'Projects/demo/Reviews/r1.md', '--ticket', 'demo-005').status, 0);
    const j = JSON.parse(run('docs', 'demo-001', '--json').stdout);
    assert.equal(j.groups.find((g) => g.kind === 'review').items[0].path, 'Projects/demo/Reviews/r1.md');
});

test('docs reports a leaf with a doc, none, an unknown ticket, and ignores symlinks, ticket notes and secret names', () => {
    const { vault, run } = docsFixture();
    assert.match(run('docs', 'demo-006').stdout, /elsewhere/);
    assert.match(run('docs', 'demo-002').stdout, /No docs attributed/);
    const unknown = run('docs', 'demo-999');
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /No such ticket: demo-999/);
    note(vault, 'Projects/demo/Plans/.env', '---\nticket: demo-002\n---\n');
    symlinkSync(join(vault, 'Projects/demo/Plans/rollout.md'), join(vault, 'Projects/demo/Plans/alias.md'));
    assert.match(run('docs', 'demo-002').stdout, /No docs attributed/);
    assert.doesNotMatch(run('docs', 'demo-001').stdout, /alias\.md/);
    assert.equal(run('docs').status, 1);
});

// ── Supporting docs: brief ────────────────────────────────────────────────────
const BRIEF = 'Projects/demo/Briefs/demo-001.md';
const TODAY = new Date().toISOString().slice(0, 10);

/** Rewrite the brief's written-at date so tickets touched "today" count as later. */
function backdate(vault, date) {
    const p = join(vault, BRIEF);
    writeFileSync(p, readFileSync(p, 'utf8').replace(/^updated: .*$/m, `updated: ${date}`));
}

test('brief with no flag says missing and writes nothing; --init scaffolds it from the template with a snapshot', () => {
    const { vault, run } = sampleTree();
    const missing = run('brief', 'demo-001');
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stdout, /demo-001 brief: missing/);
    assert.match(missing.stdout, /brief demo-001 --init/);
    assert.equal(existsSync(join(vault, BRIEF)), false);

    const r = run('brief', 'demo-001', '--init');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^created +${join(vault, BRIEF).replace(/[.\\/]/g, '\\$&')}`));
    const t = readFileSync(join(vault, BRIEF), 'utf8');
    assert.match(t, new RegExp(`^---\\nkind: brief\\nepic: "demo-001"\\ntitle: "T demo-001"\\nupdated: ${TODAY}\\nbasis: "closed 2 of 4 · blocked 1 · points 8 of 10 · open"\\n`));
    const headings = ['Goal', 'Why', 'Status', 'What done looks like', 'Key decisions', 'Risks', 'Owners', 'Important links', 'Open questions'];
    const at = headings.map((h) => t.indexOf(`## ${h}\n`));
    assert.ok(at.every((i) => i >= 0), `missing heading: ${at}`);
    assert.deepEqual(at, [...at].sort((a, b) => a - b));
});

test('brief --init never overwrites an existing brief', () => {
    const { vault, run } = sampleTree();
    run('brief', 'demo-001', '--init');
    const p = join(vault, BRIEF);
    writeFileSync(p, `${readFileSync(p, 'utf8')}\nHand-written status.\n`);
    const before = readFileSync(p, 'utf8');
    const again = run('brief', 'demo-001', '--init');
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^exists /);
    assert.equal(readFileSync(p, 'utf8'), before);
});

test('a brief is fresh when nothing changed since it was written', () => {
    const { run } = sampleTree();
    run('brief', 'demo-001', '--init');
    const r = run('brief', 'demo-001');
    assert.match(r.stdout, new RegExp(`demo-001 brief: fresh \\(written ${TODAY}\\)`));
    assert.doesNotMatch(r.stdout, / - /);
});

test('a brief goes stale when a child ticket is updated after it was written, and names the ticket', () => {
    const { vault, run } = sampleTree();
    run('brief', 'demo-001', '--init');
    backdate(vault, '2026-02-01');
    assert.match(run('brief', 'demo-001').stdout, /brief: fresh/, 'tickets last touched 2026-01-01 are older');
    run('log', 'demo-005', 'something happened');
    const r = run('brief', 'demo-001');
    assert.match(r.stdout, /brief: stale \(written 2026-02-01\)/);
    assert.match(r.stdout, /1 ticket\(s\) updated after 2026-02-01: demo-005/);
    assert.doesNotMatch(r.stdout, /numbers changed/, 'a log line does not change the numbers');
});

test('a same-day state change is stale through the numbers snapshot', () => {
    const { run } = sampleTree();
    run('brief', 'demo-001', '--init');
    run('close', 'demo-005');
    const r = run('brief', 'demo-001');
    assert.match(r.stdout, /brief: stale/);
    assert.match(r.stdout, /numbers changed: brief says "closed 2 of 4 · blocked 1 · points 8 of 10 · open", now "closed 3 of 4/);
});

test('a brief goes stale when an attributed doc is newer than it (an older doc does not)', () => {
    const { vault, run } = sampleTree();
    run('brief', 'demo-001', '--init');
    backdate(vault, '2026-02-01');
    note(vault, 'Projects/demo/Plans/late.md', '---\nticket: demo-004\nupdated: 2026-03-01\n---\n# Late\n');
    note(vault, 'Projects/demo/Plans/early.md', '---\nticket: demo-004\nupdated: 2026-01-15\n---\n# Early\n');
    const r = run('brief', 'demo-001');
    assert.match(r.stdout, /brief: stale/);
    assert.match(r.stdout, /1 doc\(s\) updated after 2026-02-01: Projects\/demo\/Plans\/late\.md/);
    assert.doesNotMatch(r.stdout, /early\.md/);
});

test('a doc dated in the future does not keep the brief stale, and --refresh leaves it fresh', () => {
    const { vault, run } = sampleTree();
    run('brief', 'demo-001', '--init');
    note(vault, 'Projects/demo/UAT/uat.md', '---\nticket: demo-004\nkind: uat\ndate: 2999-01-01\n---\n# UAT\n');
    assert.match(run('brief', 'demo-001').stdout, /brief: fresh/);
    run('brief', 'demo-001', '--refresh');
    assert.match(run('brief', 'demo-001').stdout, /brief: fresh/);
});

test('brief --refresh restamps updated and basis only, and the verdict is fresh again', () => {
    const { vault, run } = sampleTree();
    run('brief', 'demo-001', '--init');
    const p = join(vault, BRIEF);
    writeFileSync(p, readFileSync(p, 'utf8').replace('One paragraph, written for someone who has not looked in a week.', 'Hand-written status.'));
    backdate(vault, '2026-02-01');
    run('close', 'demo-005');
    assert.match(run('brief', 'demo-001').stdout, /stale/);
    const r = run('brief', 'demo-001', '--refresh');
    assert.equal(r.status, 0, r.stderr);
    const t = readFileSync(p, 'utf8');
    assert.match(t, new RegExp(`updated: ${TODAY}\\nbasis: "closed 3 of 4 `));
    assert.match(t, /Hand-written status\./);
    assert.match(run('brief', 'demo-001').stdout, /brief: fresh/);
    assert.equal(run('brief', 'demo-002', '--refresh').status, 0, 'refresh on a missing brief is a verdict, not a crash');
});

test('brief rejects an unknown ticket, a missing id, --init with --refresh, and unknown flags', () => {
    const { run } = sampleTree();
    const unknown = run('brief', 'demo-999');
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /No such ticket: demo-999/);
    assert.equal(run('brief').status, 1);
    assert.equal(run('brief', 'demo-001', '--init', '--refresh').status, 1);
    assert.equal(run('brief', 'demo-001', '--force').status, 1);
});

test('the brief lives in the epic\'s own project and shows up in docs as a brief', () => {
    const { vault, run, runIn } = sampleTree();
    put(vault, 'other', 'other-001', { parent: 'demo-001' });
    assert.equal(runIn('other', 'brief', 'other-001', '--init').status, 0);
    assert.equal(existsSync(join(vault, 'Projects/other/Briefs/other-001.md')), true);
    run('brief', 'demo-001', '--init');
    const j = JSON.parse(run('docs', 'demo-001', '--json').stdout);
    assert.equal(j.groups[0].kind, 'brief');
    assert.deepEqual(j.groups[0].items.map((i) => i.path).sort(), ['Projects/demo/Briefs/demo-001.md', 'Projects/other/Briefs/other-001.md']);
});
