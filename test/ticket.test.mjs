import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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
    const runWith = (env, ...a) => spawnSync('node', [SCRIPT, ...a, '--vault', vault, '--project', 'demo'], { encoding: 'utf8', env: { ...clean, ...env } });
    const file = (id, archived = false) => join(vault, 'Projects', 'demo', 'Tickets', archived ? 'Archive' : '', `${id}.md`);
    const read = (id, archived) => readFileSync(file(id, archived), 'utf8');
    return { vault, run, runWith, file, read };
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
