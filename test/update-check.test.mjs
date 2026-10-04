import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'update-check.mjs');
const G = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
const git = (cwd, ...a) => execFileSync('git', [...G, ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A bare origin, a clone under test, and a second clone used to push new commits. */
function setup() {
    const root = mkdtempSync(join(tmpdir(), 'xen-upd-'));
    const origin = join(root, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    const seed = join(root, 'seed');
    execFileSync('git', ['clone', '-q', origin, seed], { stdio: 'ignore' });
    writeFileSync(join(seed, 'a.txt'), '1\n');
    git(seed, 'add', 'a.txt'); git(seed, 'commit', '-q', '-m', 'one'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
    const repo = join(root, 'repo');
    execFileSync('git', ['clone', '-q', origin, repo], { stdio: 'ignore' });
    const pushUpstream = (name) => {
        writeFileSync(join(seed, name), 'x\n');
        git(seed, 'add', name); git(seed, 'commit', '-q', '-m', name); git(seed, 'push', '-q', 'origin', 'HEAD:main');
    };
    const run = (env = {}) => spawnSync('node', [SCRIPT, '--repo', repo], {
        encoding: 'utf8', env: { ...process.env, VAULT_ROOT: '', XENOPHON_CONFIG: '', XENOPHON_AUTO_PULL: '', ...env },
    });
    return { root, repo, pushUpstream, run };
}

test('silent and exit 0 when current', () => {
    const { run } = setup();
    const r = run();
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
});

test('behind: one line, nothing changed while auto_pull is off', () => {
    const { repo, pushUpstream, run } = setup();
    pushUpstream('b.txt'); pushUpstream('c.txt');
    const head = git(repo, 'rev-parse', 'HEAD');
    const r = run();
    assert.equal(r.stdout.trim(), 'xenophon: 2 behind origin/main; auto_pull off');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});

test('auto_pull on fast-forwards a clean, purely-behind checkout', () => {
    const { repo, pushUpstream, run } = setup();
    pushUpstream('b.txt');
    const r = run({ XENOPHON_AUTO_PULL: 'true' });
    assert.equal(r.stdout.trim(), 'xenophon: fast-forwarded 1 commit from origin/main');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'origin/main'));
});

test('auto_pull is read from the xenophon-config block; the env var wins over it', () => {
    const { root, repo, pushUpstream, run } = setup();
    const cfg = join(root, 'cfg.md');
    writeFileSync(cfg, '```xenophon-config\nauto_pull: on\n```\n');
    pushUpstream('b.txt');
    const head = git(repo, 'rev-parse', 'HEAD');
    assert.match(run({ XENOPHON_CONFIG: cfg, XENOPHON_AUTO_PULL: 'false' }).stdout, /auto_pull off/);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
    assert.match(run({ XENOPHON_CONFIG: cfg }).stdout, /fast-forwarded 1 commit/);
});

test('auto_pull on never touches a dirty checkout', () => {
    const { repo, pushUpstream, run } = setup();
    pushUpstream('b.txt');
    writeFileSync(join(repo, 'a.txt'), 'edited\n');
    const head = git(repo, 'rev-parse', 'HEAD');
    const r = run({ XENOPHON_AUTO_PULL: 'true' });
    assert.equal(r.stdout.trim(), 'xenophon: 1 behind origin/main; uncommitted changes');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});

test('auto_pull on never touches a diverged checkout (no merge commit, no reset)', () => {
    const { repo, pushUpstream, run } = setup();
    writeFileSync(join(repo, 'local.txt'), 'l\n');
    git(repo, 'add', 'local.txt'); git(repo, 'commit', '-q', '-m', 'local');
    pushUpstream('b.txt');
    const head = git(repo, 'rev-parse', 'HEAD');
    const r = run({ XENOPHON_AUTO_PULL: 'true' });
    assert.equal(r.stdout.trim(), 'xenophon: diverged from origin/main (1 ahead, 1 behind)');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});

test('ahead only, and dirty only, are reported', () => {
    const { repo, run } = setup();
    writeFileSync(join(repo, 'a.txt'), 'edited\n');
    assert.equal(run().stdout.trim(), 'xenophon: in sync with origin/main; uncommitted changes');
    git(repo, 'commit', '-q', '-am', 'local');
    assert.equal(run().stdout.trim(), 'xenophon: 1 ahead of origin/main');
});

test('no upstream and unreachable remote are reported, not silent', () => {
    const { repo, root, run } = setup();
    git(repo, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
    assert.match(run().stdout, /cannot check for updates \(fetch failed/);
    git(repo, 'checkout', '-q', '-b', 'loose');
    assert.match(run().stdout, /no upstream branch/);
});

test('unknown arguments are rejected', () => {
    const r = spawnSync('node', [SCRIPT, '--bogus'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown arguments/);
});
