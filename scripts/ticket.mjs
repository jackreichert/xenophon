#!/usr/bin/env node
/**
 * Flat-file ticket tracker. Tickets are markdown notes in an Obsidian vault
 * and are the source of truth — edit them directly.
 *
 * This script only does the jobs that need consistency: allocating ids,
 * placing files, moving closed tickets to Archive/, and regenerating the index.
 *
 *   ticket.mjs new --title "..." [--type bug] [--priority 2] [--labels a,b]
 *                  [--external jira-X] [--blocked-by id1,id2] [--body-file -]
 *   ticket.mjs list [--status open|closed|all] [--ready] [--label x]
 *   ticket.mjs close <id> [--reason "..."]
 *   ticket.mjs reopen <id>
 *   ticket.mjs set <id> --priority 1 --status in-progress --labels a,b
 *   ticket.mjs set <id> --reviewed            # stamp today; --reviewed no clears
 *   ticket.mjs list --unreviewed              # what still needs a read
 *   ticket.mjs index
 *
 * Common flags: --vault <path> --project <name> --dry-run
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';

const DEFAULT_VAULT = process.env.VAULT_ROOT || '';
const TYPES = ['bug', 'task', 'feature', 'epic', 'chore'];
const STATUSES = ['open', 'in-progress', 'blocked', 'closed'];

const argv = process.argv.slice(2);
const cmd = argv[0];
const positional = argv.slice(1).filter((a) => !a.startsWith('--') && !isFlagValue(a));

function isFlagValue(a) {
    const i = argv.indexOf(a);
    return i > 0 && argv[i - 1].startsWith('--');
}
function arg(name, fallback = null) {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}
const has = (name) => argv.includes(`--${name}`);

const dryRun = has('dry-run');
const vault = arg('vault', DEFAULT_VAULT);
if (!vault) {
    console.error('Vault path is not set. Ask where the Obsidian vault lives, then set VAULT_ROOT or pass --vault <path>.');
    process.exit(1);
}

function repoName() {
    try {
        return basename(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
    } catch {
        return basename(process.cwd());
    }
}
const project = arg('project', repoName());
const ticketsDir = join(vault, 'Projects', project, 'Tickets');
const archiveDir = join(ticketsDir, 'Archive');

function ensureDirs() {
    if (dryRun) return;
    mkdirSync(ticketsDir, { recursive: true });
    mkdirSync(archiveDir, { recursive: true });
}

// ── Frontmatter ───────────────────────────────────────────────────────────────
function yamlStr(v) {
    if (v === null || v === undefined || v === '') return '';
    return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
const yamlList = (a) => (!a || !a.length ? '[]' : `[${a.map(yamlStr).join(', ')}]`);

function parseScalar(raw) {
    let v = raw.trim();
    if (v.startsWith('[') && v.endsWith(']')) {
        const inner = v.slice(1, -1).trim();
        if (!inner) return [];
        return inner.split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    }
    if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"');
    if (/^-?\d+$/.test(v)) return Number(v);
    // Without this, `reviewed: false` reads back as the string "false", which is truthy.
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
}

/** Minimal frontmatter reader — sufficient for the shape this script writes. */
function readTicket(path) {
    const raw = readFileSync(path, 'utf8');
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!m) return null;
    const fm = {};
    for (const line of m[1].split('\n')) {
        const idx = line.indexOf(':');
        if (idx === -1 || line.startsWith(' ')) continue;
        fm[line.slice(0, idx).trim()] = parseScalar(line.slice(idx + 1));
    }
    return { frontmatter: fm, body: raw.slice(m[0].length), path, raw };
}

function renderFrontmatter(fm) {
    return [
        '---',
        `id: ${yamlStr(fm.id)}`,
        `title: ${yamlStr(fm.title)}`,
        `status: ${yamlStr(fm.status)}`,
        `reviewed: ${fm.reviewed || false}`,
        `type: ${yamlStr(fm.type)}`,
        `priority: ${fm.priority}`,
        `labels: ${yamlList(fm.labels)}`,
        `blocked-by: ${yamlList(fm['blocked-by'])}`,
        fm.external ? `external: ${yamlStr(fm.external)}` : null,
        `created: ${fm.created}`,
        `updated: ${fm.updated}`,
        fm.closed ? `closed: ${fm.closed}` : null,
        '---',
    ].filter(Boolean).join('\n');
}

const today = () => new Date().toISOString().slice(0, 10);

function writeFile(path, content) {
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (existing === content) return 'unchanged';
    if (!dryRun) writeFileSync(path, content);
    return existing === null ? 'created' : 'updated';
}

// ── Loading ───────────────────────────────────────────────────────────────────
function allTickets() {
    const out = [];
    for (const dir of [ticketsDir, archiveDir]) {
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir)) {
            if (!f.endsWith('.md') || f === '_Index.md') continue;
            const t = readTicket(join(dir, f));
            if (t?.frontmatter?.id) out.push(t);
        }
    }
    return out.sort((a, b) => String(a.frontmatter.id).localeCompare(String(b.frontmatter.id)));
}

function findTicket(id) {
    const t = allTickets().find((x) => x.frontmatter.id === id);
    if (!t) { console.error(`No such ticket: ${id}`); process.exit(1); }
    return t;
}

function nextId() {
    const nums = allTickets()
        .map((t) => String(t.frontmatter.id).match(/-(\d+)$/))
        .filter(Boolean)
        .map((m) => Number(m[1]));
    const next = (nums.length ? Math.max(...nums) : 0) + 1;
    return `${project}-${String(next).padStart(3, '0')}`;
}

function readStdin() {
    try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

// ── Commands ──────────────────────────────────────────────────────────────────
function cmdNew() {
    ensureDirs();
    const title = arg('title') || positional.join(' ');
    if (!title) { console.error('A --title is required.'); process.exit(1); }

    const type = arg('type', 'task');
    if (!TYPES.includes(type)) { console.error(`type must be one of: ${TYPES.join(', ')}`); process.exit(1); }

    const priority = Number(arg('priority', '2'));
    if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
        console.error('priority must be an integer 0-4 (0 critical, 4 backlog).');
        process.exit(1);
    }

    const bodyFile = arg('body-file');
    const body = bodyFile === '-' ? readStdin() : bodyFile ? readFileSync(bodyFile, 'utf8') : '';

    const fm = {
        id: arg('id') || nextId(),
        title,
        status: 'open',
        reviewed: false,
        type,
        priority,
        labels: (arg('labels') || '').split(',').map((s) => s.trim()).filter(Boolean),
        'blocked-by': (arg('blocked-by') || '').split(',').map((s) => s.trim()).filter(Boolean),
        external: arg('external'),
        created: today(),
        updated: today(),
    };

    const tags = fm.labels.map((l) => `#${l}`).join(' ');
    const meta = [
        `**Status** \`${fm.status}\``,
        `**Priority** \`P${fm.priority}\``,
        `**Type** \`${fm.type}\``,
        fm.reviewed ? `**Reviewed** \`${fm.reviewed}\`` : '**Reviewed** `not yet`',
        fm.external ? `**External** \`${fm.external}\`` : null,
    ].filter(Boolean).join(' · ');

    const content = [
        renderFrontmatter(fm), '',
        `# ${fm.id} — ${fm.title}`, '',
        meta,
        tags ? `\n${tags}` : '',
        '',
        body.trim() || '## Description\n\n_TBD_',
        '',
    ].join('\n');

    const path = join(ticketsDir, `${fm.id}.md`);
    console.log(`${writeFile(path, content)}  ${path}`);
    rebuildIndex();
    console.log(`\n${fm.id}`);
}

function cmdClose() {
    const id = positional[0];
    if (!id) { console.error('Usage: ticket.mjs close <id>'); process.exit(1); }
    ensureDirs();
    const t = findTicket(id);

    t.frontmatter.status = 'closed';
    t.frontmatter.closed = today();
    t.frontmatter.updated = today();

    const reason = arg('reason');
    const body = reason ? `${t.body.trimEnd()}\n\n## Resolution\n\n${reason}\n` : t.body;
    const content = `${renderFrontmatter(t.frontmatter)}\n${body}`;

    const dest = join(archiveDir, `${id}.md`);
    console.log(`${writeFile(dest, content)}  ${dest}`);
    if (t.path !== dest && !dryRun) rmSync(t.path);
    rebuildIndex();
}

function cmdReopen() {
    const id = positional[0];
    if (!id) { console.error('Usage: ticket.mjs reopen <id>'); process.exit(1); }
    ensureDirs();
    const t = findTicket(id);

    t.frontmatter.status = 'open';
    delete t.frontmatter.closed;
    t.frontmatter.updated = today();

    const dest = join(ticketsDir, `${id}.md`);
    console.log(`${writeFile(dest, `${renderFrontmatter(t.frontmatter)}\n${t.body}`)}  ${dest}`);
    if (t.path !== dest && !dryRun) rmSync(t.path);
    rebuildIndex();
}

function cmdSet() {
    const id = positional[0];
    if (!id) { console.error('Usage: ticket.mjs set <id> --priority N --status S --labels a,b'); process.exit(1); }
    const t = findTicket(id);

    if (arg('priority') !== null) t.frontmatter.priority = Number(arg('priority'));
    if (arg('labels') !== null) t.frontmatter.labels = arg('labels').split(',').map((s) => s.trim()).filter(Boolean);
    if (arg('blocked-by') !== null) t.frontmatter['blocked-by'] = arg('blocked-by').split(',').map((s) => s.trim()).filter(Boolean);
    if (arg('external') !== null) t.frontmatter.external = arg('external');
    if (arg('title') !== null) t.frontmatter.title = arg('title');
    // --reviewed with no value stamps today; 'no'/'false' clears it; anything
    // else is stored verbatim so a specific date can be backdated.
    if (arg('reviewed') !== null) {
        const v = String(arg('reviewed')).trim().toLowerCase();
        if (v === '' || v === 'yes' || v === 'true') t.frontmatter.reviewed = today();
        else if (v === 'no' || v === 'false') t.frontmatter.reviewed = false;
        else t.frontmatter.reviewed = arg('reviewed');
    }
    if (arg('status') !== null) {
        const s = arg('status');
        if (!STATUSES.includes(s)) { console.error(`status must be one of: ${STATUSES.join(', ')}`); process.exit(1); }
        t.frontmatter.status = s;
    }
    t.frontmatter.updated = today();

    console.log(`${writeFile(t.path, `${renderFrontmatter(t.frontmatter)}\n${t.body}`)}  ${t.path}`);
    rebuildIndex();
}

function cmdList() {
    // Default view is "active work": everything not closed. Filtering on the
    // literal string 'open' would hide a ticket the moment it went in-progress.
    const status = arg('status', 'active');
    const label = arg('label');
    const tickets = allTickets();
    const openIds = new Set(tickets.filter((t) => t.frontmatter.status !== 'closed').map((t) => t.frontmatter.id));

    let rows = tickets.filter((t) => {
        const fm = t.frontmatter;
        if (status === 'active' && fm.status === 'closed') return false;
        if (status !== 'all' && status !== 'active' && fm.status !== status) return false;
        if (label && !(fm.labels || []).includes(label)) return false;
        // --ready hides anything still waiting on an unclosed blocker.
        if (has('ready') && (fm['blocked-by'] || []).some((b) => openIds.has(b))) return false;
        if (has('unreviewed') && fm.reviewed) return false;
        return true;
    });

    rows.sort((a, b) => (a.frontmatter.priority - b.frontmatter.priority)
        || String(a.frontmatter.id).localeCompare(String(b.frontmatter.id)));

    if (!rows.length) { console.log('No matching tickets.'); return; }
    for (const t of rows) {
        const fm = t.frontmatter;
        const blockers = (fm['blocked-by'] || []).filter((b) => openIds.has(b));
        console.log(
            `P${fm.priority}  ${String(fm.id).padEnd(20)} [${String(fm.type).padEnd(7)}] ${fm.status.padEnd(11)} ${fm.title}`
            + (fm.reviewed ? '' : '  ● unreviewed')
            + (blockers.length ? `  ⛔ blocked by ${blockers.join(', ')}` : '')
        );
    }
    console.log(`\n${rows.length} ticket(s)`);
}

function rebuildIndex() {
    ensureDirs();
    const tickets = allTickets();
    const open = tickets.filter((t) => t.frontmatter.status !== 'closed');
    const closed = tickets.filter((t) => t.frontmatter.status === 'closed');
    const openIds = new Set(open.map((t) => t.frontmatter.id));

    const lines = [
        '---',
        `project: ${yamlStr(project)}`,
        `updated: ${today()}`,
        '---',
        '',
        `# ${project} — Tickets`,
        '',
        `${open.length} open · ${closed.length} closed`,
        '',
    ];

    const byPriority = new Map();
    for (const t of open) {
        const k = `P${t.frontmatter.priority}`;
        if (!byPriority.has(k)) byPriority.set(k, []);
        byPriority.get(k).push(t);
    }

    if (!open.length) lines.push('_No open tickets._', '');
    for (const k of [...byPriority.keys()].sort()) {
        lines.push(`## ${k}`, '');
        for (const t of byPriority.get(k)) {
            const fm = t.frontmatter;
            const tags = (fm.labels || []).map((l) => `#${l}`).join(' ');
            const blockers = (fm['blocked-by'] || []).filter((b) => openIds.has(b));
            lines.push(`- [[${fm.id}|${fm.title}]] · \`${fm.type}\` · \`${fm.status}\``
                + (fm.reviewed ? '' : ' · **unreviewed**')
                + (tags ? ` · ${tags}` : '')
                + (blockers.length ? ` · ⛔ ${blockers.map((b) => `[[${b}]]`).join(', ')}` : ''));
        }
        lines.push('');
    }

    if (closed.length) {
        lines.push('## Closed', '');
        for (const t of closed) lines.push(`- [[Archive/${t.frontmatter.id}|${t.frontmatter.title}]]`);
        lines.push('');
    }

    const path = join(ticketsDir, '_Index.md');
    console.log(`${writeFile(path, lines.join('\n'))}  ${path}`);
}

const commands = { new: cmdNew, list: cmdList, close: cmdClose, reopen: cmdReopen, set: cmdSet, index: rebuildIndex };
if (!commands[cmd]) {
    console.error(`Usage: ticket.mjs <new|list|close|reopen|set|index> [...]`);
    process.exit(1);
}
commands[cmd]();
