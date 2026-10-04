#!/usr/bin/env node
/**
 * Session-start check: is this skill's own checkout behind its origin?
 *
 *   update-check.mjs [--repo <path>]
 *
 * Fetches, then prints one line only when the checkout is not current
 * (behind / ahead / diverged / dirty). Silent and exit 0 when current.
 *
 * Config key `auto_pull` (env XENOPHON_AUTO_PULL wins; default off). When on, a
 * clean checkout that is purely behind is fast-forwarded with `git merge --ff-only`.
 * Nothing else is ever changed: no rebase, no reset, no merge commit.
 */
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from './config.mjs';

const TRUTHY = ['true', 'on', 'yes', '1'];

function git(repo, ...args) {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function autoPullEnabled() {
    const raw = process.env.XENOPHON_AUTO_PULL || readConfig(process.env.VAULT_ROOT || '').auto_pull || '';
    return TRUTHY.includes(String(raw).trim().toLowerCase());
}

/** The one-line report, or '' when the checkout is current. */
export function checkForUpdates(repo, autoPull) {
    let upstream;
    try {
        upstream = git(repo, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
    } catch {
        return 'xenophon: cannot check for updates (no upstream branch)';
    }
    try {
        git(repo, 'fetch', '--quiet');
    } catch (e) {
        return `xenophon: cannot check for updates (fetch failed: ${String(e.stderr || e.message).trim().split('\n')[0]})`;
    }
    const [ahead, behind] = git(repo, 'rev-list', '--left-right', '--count', 'HEAD...@{u}').split(/\s+/).map(Number);
    const dirty = git(repo, 'status', '--porcelain', '--untracked-files=no') !== '';
    if (!ahead && !behind && !dirty) return '';

    if (behind && !ahead && !dirty && autoPull) {
        try {
            git(repo, 'merge', '--ff-only', '@{u}');
            return `xenophon: fast-forwarded ${behind} commit${behind === 1 ? '' : 's'} from ${upstream}`;
        } catch (e) {
            return `xenophon: ${behind} behind ${upstream}; fast-forward failed (${String(e.stderr || e.message).trim().split('\n')[0]})`;
        }
    }

    const state = ahead && behind ? `diverged from ${upstream} (${ahead} ahead, ${behind} behind)`
        : behind ? `${behind} behind ${upstream}`
            : ahead ? `${ahead} ahead of ${upstream}` : `in sync with ${upstream}`;
    const notes = [dirty ? 'uncommitted changes' : '', behind && !autoPull ? 'auto_pull off' : ''].filter(Boolean);
    return `xenophon: ${state}${notes.length ? `; ${notes.join(', ')}` : ''}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const known = args[0] === '--repo' && args.length === 2;
    if (args.length && !known) {
        console.error(`unknown arguments: ${args.join(' ')} (usage: update-check.mjs [--repo <path>])`);
        process.exit(1);
    }
    const repo = known ? args[1] : dirname(dirname(fileURLToPath(import.meta.url)));
    const line = checkForUpdates(repo, autoPullEnabled());
    if (line) console.log(line);
}
