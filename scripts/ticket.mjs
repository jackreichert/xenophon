#!/usr/bin/env node
/**
 * Flat-file ticket tracker. Tickets are markdown notes in an Obsidian vault
 * and are the source of truth — edit them directly.
 *
 * This script only does the jobs that need consistency: allocating ids,
 * placing files, moving closed tickets to Archive/, and regenerating the index.
 *
 *   ticket.mjs new --title "..." --problem "..." --done "..." [--context "..."]
 *                  [--scope "..."]... [--accept "..."]... [--out "..."]... [--points 3]
 *                  [--decision "what | options | recommendation | stakes"]...
 *                  [--evidence "file:line - note"]... [--link "..."]...
 *                  [--type bug] [--priority 2] [--labels a,b]
 *                  [--external jira-X] [--blocked-by id1,id2] [--parent <epic-id>]
 *   ticket.mjs new --title "..." --body-file -     # legacy: hand-written body
 *   ticket.mjs decide <id> --decision "what | options | recommendation | stakes"
 *   ticket.mjs decide <id> --clear            # decision made; stops listing as needed
 *   ticket.mjs log <id> "dated update"
 *   ticket.mjs promote <id>                   # print tracker-ready markdown; calls nothing
 *   ticket.mjs list [--status open|closed|all] [--ready] [--label x]
 *   ticket.mjs list --under <id> [--depth N]  # descendants of a ticket (--epic is an alias)
 *   ticket.mjs list --tree [--under <id>] [--depth N]   # ASCII tree with rollups
 *   ticket.mjs close <id> [--reason "..."] [--force]   # --force: close despite open descendants
 *   ticket.mjs reopen <id>
 *   ticket.mjs set <id> --priority 1 --status in-progress --labels a,b
 *   ticket.mjs set <id> --parent <epic-id|none>
 *   ticket.mjs set <id> --reviewed            # stamp today; --reviewed no clears
 *   ticket.mjs list --unreviewed              # what still needs a read
 *   ticket.mjs list --decisions               # tickets waiting on a decision
 *   ticket.mjs show <id>                      # parent, rollup and children table; refreshes the note
 *   ticket.mjs attach <note> --ticket <id> [--kind plan|research|review|runbook|uat|brief|decision|other]
 *   ticket.mjs docs <epic-id> [--json]        # docs attributed to an epic or anything under it, by kind
 *   ticket.mjs brief <epic-id> [--init | --refresh]   # per-epic brief: staleness verdict, scaffold, or restamp
 *   ticket.mjs index
 *
 * Common flags: --vault <path> --project <name> --dry-run
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { readConfig } from './config.mjs';

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
/** Every value of a repeatable flag, in order. */
function args(name) {
    const out = [];
    argv.forEach((a, i) => {
        if (a === `--${name}` && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out.push(argv[i + 1]);
    });
    return out;
}

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

const config = readConfig(vault);
/** Who the Decisions section is addressed to; empty means a generic heading. */
const DECIDER = (process.env.XENOPHON_DECIDER ?? config.decider ?? '').trim();
const DECISIONS_TITLE = DECIDER ? `Decisions needed (for ${DECIDER})` : 'Decisions needed';
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
        // Absent on tickets filed before the template; do not invent it on rewrite.
        typeof fm.decision_needed === 'boolean' ? `decision_needed: ${fm.decision_needed}` : null,
        `type: ${yamlStr(fm.type)}`,
        `priority: ${fm.priority}`,
        `labels: ${yamlList(fm.labels)}`,
        `blocked-by: ${yamlList(fm['blocked-by'])}`,
        fm.parent ? `parent: ${yamlStr(fm.parent)}` : null,
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
/** Every ticket (open and archived) in one project's Tickets folder. */
function loadTickets(dir) {
    const out = [];
    for (const d of [dir, join(dir, 'Archive')]) {
        if (!existsSync(d)) continue;
        for (const f of readdirSync(d)) {
            if (!f.endsWith('.md') || f === '_Index.md') continue;
            const t = readTicket(join(d, f));
            if (t?.frontmatter?.id) out.push(t);
        }
    }
    return out.sort((a, b) => String(a.frontmatter.id).localeCompare(String(b.frontmatter.id)));
}

const allTickets = () => loadTickets(ticketsDir);

function findTicket(id) {
    const t = allTickets().find((x) => x.frontmatter.id === id);
    if (!t) { console.error(`No such ticket: ${id}`); process.exit(1); }
    return t;
}

// ── Parents ───────────────────────────────────────────────────────────────────
// A ticket's `parent` names another ticket by id. Any ticket may be a parent and
// nesting has no depth limit. Ids are `{project}-NNN`, so a child may live in a
// different project of the same vault than its parent.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Every ticket of every project in the vault, one scan. */
function vaultTickets() {
    const root = join(vault, 'Projects');
    if (!existsSync(root)) return [];
    return readdirSync(root).flatMap((p) => loadTickets(join(root, p, 'Tickets')));
}

/** Why `childId` may not take `parentId` as its parent, or null if it may. */
function parentError(childId, parentId) {
    if (!SAFE_ID.test(parentId) || parentId.includes('..')) return `invalid parent id: ${parentId}`;
    if (parentId === childId) return `${childId} cannot be its own parent.`;
    const parentOf = new Map(vaultTickets().map((t) => [t.frontmatter.id, t.frontmatter.parent]));
    if (!parentOf.has(parentId)) return `No such parent ticket: ${parentId} (looked in the vault at ${vault}).`;
    const path = [childId, parentId];
    for (let up = parentOf.get(parentId); up && !path.includes(up); up = parentOf.get(up)) path.push(up);
    return parentOf.get(path.at(-1)) === childId ? `cycle: ${[...path, childId].join(' -> ')}` : null;
}

function requireValidParent(childId, parentId) {
    const err = parentError(childId, parentId);
    if (err) { console.error(err); process.exit(1); }
}

// ── Tree and rollup ───────────────────────────────────────────────────────────
// Built once per command from every ticket in the vault. Nothing here is stored:
// counts are recomputed from the notes' frontmatter each run.

/** Story points from the "## Estimate" section; 0 when absent. */
function pointsOf(t) {
    const m = t.body.match(/^## Estimate\s*\n+\s*(\d+) story points?/m);
    return m ? Number(m[1]) : 0;
}

const byPriorityThenId = (a, b) => (a.frontmatter.priority - b.frontmatter.priority)
    || String(a.frontmatter.id).localeCompare(String(b.frontmatter.id));

/** Drop, with a warning, the one edge per hand-edited loop that closes it (deterministic: ids visited in order). */
function breakParentCycles(parentOf) {
    const done = new Set();
    for (const start of [...parentOf.keys()].sort()) {
        const path = [];
        let cur = start;
        while (cur !== undefined && !done.has(cur) && !path.includes(cur)) { path.push(cur); cur = parentOf.get(cur); }
        if (cur !== undefined && !done.has(cur)) {
            const loop = path.slice(path.indexOf(cur));
            console.error(`warning: parent cycle ${[...loop, cur].join(' -> ')}; ignoring the parent of ${loop.at(-1)}.`);
            parentOf.delete(loop.at(-1));
        }
        path.forEach((id) => done.add(id));
    }
}

/** Descendant totals per ticket. `order` lists parents before children; it is walked backwards so each child is done first. */
function computeRollups(order, kids) {
    const rolls = new Map();
    for (const t of order.toReversed()) {
        const r = { total: 0, direct: 0, closed: 0, blocked: 0, ptsTotal: 0, ptsDone: 0 };
        for (const c of kids.get(t.frontmatter.id) ?? []) {
            const cr = rolls.get(c.frontmatter.id);
            const closed = c.frontmatter.status === 'closed';
            const pts = pointsOf(c);
            r.direct += 1;
            r.total += 1 + cr.total;
            r.closed += (closed ? 1 : 0) + cr.closed;
            r.blocked += (c.frontmatter.status === 'blocked' ? 1 : 0) + cr.blocked;
            r.ptsTotal += pts + cr.ptsTotal;
            r.ptsDone += (closed ? pts : 0) + cr.ptsDone;
        }
        rolls.set(t.frontmatter.id, r);
    }
    return rolls;
}

/**
 * Parent/child maps plus a recursive rollup for every ticket, all in one pass
 * (no per-node scan, no recursion, so depth and width are both cheap).
 * A parent that does not exist is treated as absent. A hand-edited cycle is
 * reported on stderr and its closing edge is ignored, so it can neither hang
 * nor crash anything.
 */
function buildForest(tickets) {
    const byId = new Map(tickets.map((t) => [t.frontmatter.id, t]));
    const parentOf = new Map();
    for (const [id, t] of byId) {
        const p = t.frontmatter.parent;
        if (p && p !== id && byId.has(p)) parentOf.set(id, p);
    }

    breakParentCycles(parentOf);

    const kids = new Map();
    for (const [id, p] of parentOf) {
        if (!kids.has(p)) kids.set(p, []);
        kids.get(p).push(byId.get(id));
    }
    for (const list of kids.values()) list.sort(byPriorityThenId);

    // Parents before children, so the reverse walk sees every child before its parent.
    const order = [...byId.values()].filter((t) => !parentOf.has(t.frontmatter.id));
    for (let i = 0; i < order.length; i++) order.push(...(kids.get(order[i].frontmatter.id) ?? []));
    const rolls = computeRollups(order, kids);

    return {
        byId,
        parentOf,
        children: (id) => kids.get(id) ?? [],
        roll: (id) => rolls.get(id),
        /** Pre-order [{t, depth, parent}] under `rootIds`, down to `maxDepth` levels below them. */
        walk(rootIds, maxDepth = Infinity) {
            const out = [];
            const stack = rootIds.map((id) => ({ t: byId.get(id), depth: 0, parent: -1 })).reverse();
            while (stack.length) {
                const e = stack.pop();
                const idx = out.push(e) - 1;
                if (e.depth < maxDepth) {
                    for (const c of this.children(e.t.frontmatter.id).toReversed()) stack.push({ t: c, depth: e.depth + 1, parent: idx });
                }
            }
            return out;
        },
    };
}

const CHILDREN_START = '<!-- xenophon:children -->';
const CHILDREN_END = '<!-- /xenophon:children -->';

/** Markdown table of a ticket's direct children, each with its own rollup. */
function childrenTable(forest, id) {
    const rows = forest.children(id).map((c) => {
        const fm = c.frontmatter;
        return `| [[${fm.id}]] | ${fm.status} | ${fm.type} | ${pointsOf(c) || ''} | ${String(fm.title).replace(/\|/g, '\\|')} | ${formatRollup(forest.roll(fm.id))} |`;
    });
    return rows.length ? ['| Ticket | Status | Type | Pts | Title | Progress |', '| --- | --- | --- | --- | --- | --- |', ...rows] : ['_No children._'];
}

/** Replace the generated block between the markers, or add a "Children" section holding it. Touches nothing else. */
function withChildrenBlock(body, lines) {
    const block = [CHILDREN_START, ...lines, CHILDREN_END].join('\n');
    const s = body.indexOf(CHILDREN_START);
    const e = body.indexOf(CHILDREN_END);
    if (s !== -1 && e > s) return body.slice(0, s) + block + body.slice(e + CHILDREN_END.length);
    return appendToSection(body, /^children\b/i, 'Children', block.split('\n'));
}

/**
 * Regenerate the children table in a ticket's own note. Only tickets that have
 * children, or already carry the markers, are touched; the frontmatter and every
 * byte outside the markers are kept as they are.
 */
function syncChildrenNote(forest, t) {
    const hasKids = forest.children(t.frontmatter.id).length > 0;
    if (!hasKids && !(t.body.includes(CHILDREN_START) && t.body.includes(CHILDREN_END))) return 'unchanged';
    const body = withChildrenBlock(t.body, childrenTable(forest, t.frontmatter.id));
    const status = writeFile(t.path, t.raw.slice(0, t.raw.length - t.body.length) + body);
    if (status !== 'unchanged') console.log(`${status}  ${t.path}`);
    return status;
}

/** "3/8 closed (3 direct), 2 blocked, 8/21 pts" for a ticket with descendants; '' for a leaf. */
function formatRollup(r) {
    if (!r || !r.total) return '';
    return [
        `${r.closed}/${r.total} closed${r.direct === r.total ? '' : ` (${r.direct} direct)`}`,
        r.blocked ? `${r.blocked} blocked` : null,
        r.ptsTotal ? `${r.ptsDone}/${r.ptsTotal} pts` : null,
    ].filter(Boolean).join(', ');
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

// ── Template ──────────────────────────────────────────────────────────────────
// Public sections mirror a typical tracker ticket (problem, context, scope,
// done state, acceptance, out of scope, estimate). Internal sections follow and
// are for the vault reader only.
const POINT_SCALE = (process.env.XENOPHON_POINTS || '1,2,3,5').split(',').map((n) => Number(n.trim()));
const DECISION_FIELDS = ['decision', 'options', 'recommendation', 'stakes'];

function templateSpec() {
    const spec = {
        problem: arg('problem'),
        context: arg('context'),
        scope: args('scope'),
        done: arg('done'),
        accept: args('accept'),
        out: args('out'),
        points: arg('points'),
        decisions: args('decision').map(parseDecision),
        evidence: args('evidence'),
        links: args('link'),
    };
    spec.provided = Boolean(spec.problem || spec.context || spec.done || spec.points || spec.scope.length
        || spec.accept.length || spec.out.length || spec.decisions.length || spec.evidence.length || spec.links.length);
    return spec;
}

/** "decision | options | recommendation | stakes" -> object; all four parts are required. */
function parseDecision(raw) {
    const parts = raw.split(/\s+\|\s+/).map((p) => p.trim());
    if (parts.length !== DECISION_FIELDS.length || parts.some((p) => !p)) {
        console.error(`--decision needs four parts separated by " | ": ${DECISION_FIELDS.join(' | ')}. Got: ${raw}`);
        process.exit(1);
    }
    return Object.fromEntries(DECISION_FIELDS.map((k, i) => [k, parts[i]]));
}

function validateSpec(spec) {
    const missing = [];
    if (!spec.problem) missing.push('--problem');
    if (!spec.done) missing.push('--done');
    if (missing.length) {
        console.error(`Missing ${missing.join(' and ')}. A ticket needs a problem and a "What done looks like"; ask if the done state is unclear. (Or pass --body-file for a hand-written body.)`);
        process.exit(1);
    }
    if (spec.points !== null) {
        const n = Number(spec.points);
        if (!POINT_SCALE.includes(n)) {
            console.error(`--points must be one of ${POINT_SCALE.join(', ')}; anything bigger should be split into smaller tickets.`);
            process.exit(1);
        }
    }
}

function renderDecision(n, d) {
    return [
        `${n}. **${d.decision}**`,
        `   - Options: ${d.options}`,
        `   - Recommendation: ${d.recommendation}`,
        `   - Stakes: ${d.stakes}`,
    ].join('\n');
}

const INTERNAL_NOTE = '> Internal. Stripped by `ticket.mjs promote`.';

function renderTemplate(spec) {
    const bullets = (a, prefix = '- ') => a.map((x) => `${prefix}${x}`).join('\n');
    const sections = [
        ['Problem', spec.problem],
        spec.context && ['Context', spec.context],
        spec.scope.length && ['Scope', bullets(spec.scope)],
        ['What done looks like', spec.done],
        spec.accept.length && ['Acceptance criteria', bullets(spec.accept, '- [ ] ')],
        spec.out.length && ['Out of scope', bullets(spec.out)],
        spec.points !== null && ['Estimate', `${Number(spec.points)} story point${Number(spec.points) === 1 ? '' : 's'}`],
        [DECISIONS_TITLE, `${INTERNAL_NOTE}\n\n${spec.decisions.length
            ? spec.decisions.map((d, i) => renderDecision(i + 1, d)).join('\n') : 'None'}`],
        ['Evidence / file:line', spec.evidence.length ? bullets(spec.evidence) : '_None yet_'],
        ['Links', spec.links.length ? bullets(spec.links) : '_None_'],
        ['Log', `- ${today()}: Filed.`],
    ].filter(Boolean);
    return sections.map(([h, b]) => `## ${h}\n\n${b}`).join('\n\n');
}

// ── Sections ──────────────────────────────────────────────────────────────────
/** Split a body into H2 sections; sections[0] is the preamble. Fence-aware. */
function splitSections(body) {
    const secs = [{ heading: null, line: null, lines: [] }];
    let fence = false;
    for (const l of body.split('\n')) {
        if (/^(```|~~~)/.test(l)) fence = !fence;
        const m = !fence && l.match(/^##\s+(.*\S)\s*$/);
        if (m) secs.push({ heading: m[1], line: l, lines: [] });
        else secs.at(-1).lines.push(l);
    }
    return secs;
}
const joinSections = (secs) => `${secs.flatMap((x) => (x.line === null ? x.lines : [x.line, ...x.lines])).join('\n').trimEnd()}\n`;

/**
 * The only headings `promote` lets out of the vault (allowlist; anything else is dropped).
 * "Description" is the legacy hand-written body heading.
 */
const PUBLIC_HEADING = /^(problem|context|scope|what done looks like|acceptance criteria|out of scope|estimate|description)\s*$/i;
const DECISIONS_HEADING = /^decisions needed/i;

function trimBlankEnd(lines) {
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    return lines;
}

/** Append lines to the first section matching `re`, creating `newHeading` (before any internal tail) if absent. */
function appendToSection(body, re, newHeading, add, { intro = [] } = {}) {
    const secs = splitSections(body);
    let sec = secs.find((x) => x.heading && re.test(x.heading));
    if (!sec) {
        sec = { heading: newHeading, line: `## ${newHeading}`, lines: ['', ...intro, ...(intro.length ? [''] : [])] };
        const tail = secs.findIndex((x) => x.heading && /^(evidence|links?\b|log\b)/i.test(x.heading));
        secs.splice(tail === -1 ? secs.length : tail, 0, sec);
    }
    trimBlankEnd(sec.lines);
    if (!sec.lines.length || sec.lines[0].trim()) sec.lines.unshift('');
    sec.lines.push(...add, '');
    return joinSections(secs);
}

/** Keep the one-line header (`**Decision needed** ...`) in step with the frontmatter. */
function syncDecisionHeader(body, needed) {
    const seg = `**Decision needed** \`${needed ? 'yes' : 'no'}\``;
    const lines = body.split('\n');
    const end = lines.findIndex((l) => /^##\s/.test(l));
    const head = lines.slice(0, end === -1 ? lines.length : end);
    let i = head.findIndex((l) => l.startsWith('**Decision needed**'));
    if (i !== -1) lines[i] = lines[i].replace(/\*\*Decision needed\*\* `[^`]*`/, seg);
    else if ((i = head.findIndex((l) => l.startsWith('**Status**'))) !== -1) lines[i] = `${seg} · ${lines[i]}`;
    return lines.join('\n');
}

function saveTicket(t, body) {
    t.frontmatter.updated = today();
    console.log(`${writeFile(t.path, `${renderFrontmatter(t.frontmatter)}\n${body}`)}  ${t.path}`);
    rebuildIndex();
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

    const id = arg('id') || nextId();
    const parent = arg('parent');
    if (parent) requireValidParent(id, parent);

    const bodyFile = arg('body-file');
    const spec = templateSpec();
    const legacy = Boolean(bodyFile);
    if (legacy && spec.provided) {
        console.error('--body-file replaces the template; do not combine it with --problem/--done/--scope/... flags.');
        process.exit(1);
    }
    if (!legacy) validateSpec(spec);
    const legacyBody = bodyFile === '-' ? readStdin() : bodyFile ? readFileSync(bodyFile, 'utf8') : '';

    const fm = {
        id,
        title,
        status: 'open',
        reviewed: false,
        ...(legacy ? {} : { decision_needed: spec.decisions.length > 0 }),
        type,
        priority,
        labels: (arg('labels') || '').split(',').map((s) => s.trim()).filter(Boolean),
        'blocked-by': (arg('blocked-by') || '').split(',').map((s) => s.trim()).filter(Boolean),
        external: arg('external'),
        parent,
        created: today(),
        updated: today(),
    };

    const tags = fm.labels.map((l) => `#${l}`).join(' ');
    const meta = [
        legacy ? null : `**Decision needed** \`${fm.decision_needed ? 'yes' : 'no'}\``,
        `**Status** \`${fm.status}\``,
        `**Priority** \`P${fm.priority}\``,
        `**Type** \`${fm.type}\``,
        fm.reviewed ? `**Reviewed** \`${fm.reviewed}\`` : '**Reviewed** `not yet`',
        fm.external ? `**External** \`${fm.external}\`` : null,
    ].filter(Boolean).join(' · ');

    const body = legacy ? (legacyBody.trim() || '## Description\n\n_TBD_') : renderTemplate(spec);
    const content = [
        renderFrontmatter(fm), '',
        `# ${fm.id} — ${fm.title}`, '',
        meta,
        tags ? `\n${tags}` : '',
        '',
        body,
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

    const forest = buildForest(vaultTickets());
    const openBelow = forest.walk([id]).slice(1).filter((e) => e.t.frontmatter.status !== 'closed').map((e) => e.t.frontmatter.id);
    if (openBelow.length) {
        const list = `${openBelow.slice(0, 5).join(', ')}${openBelow.length > 5 ? `, and ${openBelow.length - 5} more` : ''}`;
        console.error(`warning: ${id} has ${openBelow.length} open descendant(s): ${list}.`);
        if (!has('force')) { console.error('Close them first, or pass --force to close anyway.'); process.exit(1); }
    }

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
    if (arg('parent') !== null) {
        const p = arg('parent');
        if (p === 'none') delete t.frontmatter.parent;
        else { requireValidParent(id, p); t.frontmatter.parent = p; }
    }
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

function cmdDecide() {
    const id = positional[0];
    if (!id) { console.error('Usage: ticket.mjs decide <id> --decision "what | options | recommendation | stakes" | --clear'); process.exit(1); }
    const t = findTicket(id);
    let body = t.body;

    if (has('clear')) {
        t.frontmatter.decision_needed = false;
        body = syncDecisionHeader(body, false);
        saveTicket(t, body);
        return;
    }

    const decisions = args('decision').map(parseDecision);
    if (!decisions.length) { console.error('Pass --decision "what | options | recommendation | stakes" or --clear.'); process.exit(1); }

    const secs = splitSections(body);
    const sec = secs.find((x) => x.heading && DECISIONS_HEADING.test(x.heading));
    const existing = sec ? sec.lines.filter((l) => l.trim() && !l.startsWith('> Internal')) : [];
    const placeholder = existing.length === 1 && /^none\.?$/i.test(existing[0].trim());
    if (placeholder) {
        sec.lines = ['', INTERNAL_NOTE, ''];
        body = joinSections(secs);
    }
    const start = placeholder ? 0 : existing.filter((l) => /^\d+\. \*\*/.test(l)).length;
    body = appendToSection(body, DECISIONS_HEADING, DECISIONS_TITLE,
        decisions.map((d, i) => renderDecision(start + i + 1, d)), { intro: [INTERNAL_NOTE] });
    t.frontmatter.decision_needed = true;
    saveTicket(t, syncDecisionHeader(body, true));
}

function cmdLog() {
    const [id, ...rest] = positional;
    const msg = rest.join(' ').trim();
    if (!id || !msg) { console.error('Usage: ticket.mjs log <id> "update"'); process.exit(1); }
    const t = findTicket(id);
    saveTicket(t, appendToSection(t.body, /^log\b/i, 'Log', [`- ${today()}: ${msg}`]));
}

/** Print tracker-ready markdown: internal sections dropped, vault references stripped. Never calls a tracker. */
function cmdPromote() {
    const id = positional[0];
    if (!id) { console.error('Usage: ticket.mjs promote <id>'); process.exit(1); }
    const t = findTicket(id);
    const [pre, ...secs] = splitSections(t.body);

    // The preamble (id, status line, labels) is internal metadata; only the title is emitted.
    const kept = secs.filter((x) => PUBLIC_HEADING.test(x.heading));
    const dropped = secs.filter((x) => !PUBLIC_HEADING.test(x.heading) && !/^(decisions?\b|evidence|links?\b|log\b|resolution|internal|children\b)/i.test(x.heading));
    if (dropped.length) console.error(`warning: dropped non-public section(s): ${dropped.map((x) => x.heading).join(', ')}.`);
    if (!kept.some((x) => /^what done looks like/i.test(x.heading))) {
        console.error('warning: no "What done looks like" section; add one before filing.');
    }

    const projects = existsSync(join(vault, 'Projects')) ? readdirSync(join(vault, 'Projects')) : [];
    const idRe = projects.length
        ? new RegExp(`\\b(?:${projects.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})-\\d+\\b`, 'g')
        : null;
    let removed = 0;
    const strip = (text) => {
        const bump = (r) => { removed += 1; return r; };
        let out = text.replace(/\[([^\]]*)\]\(obsidian:\/\/[^)\s]*\)/g, (_, label) => bump(label))
            .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, (m, _t, alias) => bump(m.startsWith('!') ? '' : alias))
            .replace(/!?\[\[[^\]]*\]\]/g, () => bump(''))
            .replace(/obsidian:\/\/\S+/g, () => bump(''));
        if (idRe) out = out.replace(idRe, () => bump(''));
        return out;
    };

    const text = strip([`# ${t.frontmatter.title}`, '', ...kept.flatMap((x) => [x.line, ...x.lines])].join('\n'))
        .replace(/\n{3,}/g, '\n\n');
    if (removed) console.error(`warning: removed ${removed} vault reference(s); re-read the output for dangling sentences.`);
    process.stdout.write(`${text.trimEnd()}\n`);
}

function cmdList() {
    // Default view is "active work": everything not closed. Filtering on the
    // literal string 'open' would hide a ticket the moment it went in-progress.
    const status = arg('status', 'active');
    const label = arg('label');
    const forest = buildForest(vaultTickets());
    const under = arg('under') ?? arg('epic');
    const depth = arg('depth') === null ? Infinity : Number(arg('depth'));
    if (under && !forest.byId.has(under)) { console.error(`No such ticket: ${under}`); process.exit(1); }
    if (has('depth') && !(Number.isInteger(depth) && depth >= 1 && (under || has('tree')))) {
        console.error('--depth takes an integer >= 1 and goes with --under or --tree.');
        process.exit(1);
    }

    const projectTickets = allTickets();
    const subtree = under ? forest.walk([under], depth).slice(1).map((e) => e.t) : [];
    const tickets = under ? subtree : projectTickets;
    const openIds = new Set([...projectTickets, ...subtree].filter((t) => t.frontmatter.status !== 'closed').map((t) => t.frontmatter.id));

    const passes = (t) => {
        const fm = t.frontmatter;
        if (status === 'active' && fm.status === 'closed') return false;
        if (status !== 'all' && status !== 'active' && fm.status !== status) return false;
        if (label && !(fm.labels || []).includes(label)) return false;
        // --ready hides anything still waiting on an unclosed blocker.
        if (has('ready') && (fm['blocked-by'] || []).some((b) => openIds.has(b))) return false;
        if (has('unreviewed') && fm.reviewed) return false;
        if (has('decisions') && fm.decision_needed !== true) return false;
        return true;
    };

    if (has('tree')) { printTree(forest, under ? [under] : projectRoots(forest, projectTickets), depth, passes, Boolean(under)); return; }

    const rows = tickets.filter(passes).sort(byPriorityThenId);

    if (!rows.length) { console.log('No matching tickets.'); return; }
    for (const t of rows) {
        const fm = t.frontmatter;
        const blockers = (fm['blocked-by'] || []).filter((b) => openIds.has(b));
        const rollup = formatRollup(forest.roll(fm.id));
        console.log(
            `P${fm.priority}  ${String(fm.id).padEnd(20)} [${String(fm.type).padEnd(7)}] ${fm.status.padEnd(11)} ${fm.title}`
            + (fm.decision_needed === true ? '  ? decision needed' : '')
            + (fm.reviewed ? '' : '  ● unreviewed')
            + (blockers.length ? `  ⛔ blocked by ${blockers.join(', ')}` : '')
            + (forest.parentOf.has(fm.id) ? `  ↑ ${forest.parentOf.get(fm.id)}` : '')
            + (rollup ? `  ▣ ${rollup}` : '')
        );
    }
    console.log(`\n${rows.length} ticket(s)`);
}

/** Tree roots for a whole-project view: tickets of this project whose parent is not also in it. */
function projectRoots(forest, projectTickets) {
    const ids = new Set(projectTickets.map((t) => t.frontmatter.id));
    return projectTickets.filter((t) => !ids.has(forest.parentOf.get(t.frontmatter.id))).sort(byPriorityThenId)
        .map((t) => t.frontmatter.id);
}

/**
 * ASCII tree. A node shows when it passes the filters or something below it does,
 * so a closed parent with open work under it is not hidden. `keepRoot` always
 * shows the root of an --under tree.
 */
function printTree(forest, rootIds, depth, passes, keepRoot) {
    const entries = forest.walk(rootIds, depth);
    const visible = entries.map((e) => passes(e.t));
    if (keepRoot) visible[0] = true;
    for (let i = entries.length - 1; i > 0; i--) if (visible[i] && entries[i].parent >= 0) visible[entries[i].parent] = true;
    const kids = entries.map(() => []);
    entries.forEach((e, i) => { if (visible[i] && e.parent >= 0) kids[e.parent].push(i); });

    let shown = 0;
    const stack = entries.flatMap((e, i) => (e.parent < 0 && visible[i] ? [{ i, prefix: '', last: true }] : [])).reverse();
    if (!stack.length) { console.log('No matching tickets.'); return; }
    while (stack.length) {
        const { i, prefix, last } = stack.pop();
        const { t, depth: d } = entries[i];
        const fm = t.frontmatter;
        const pts = pointsOf(t);
        const rollup = formatRollup(forest.roll(fm.id));
        console.log(`${d === 0 ? '' : `${prefix}${last ? '└─ ' : '├─ '}`}${fm.id} [${fm.type}] ${fm.status} P${fm.priority}`
            + `${pts ? ` ${pts}pt` : ''}  ${fm.title}${rollup ? `  ▣ ${rollup}` : ''}`);
        shown += 1;
        const childPrefix = d === 0 ? '' : `${prefix}${last ? '   ' : '│  '}`;
        for (let n = kids[i].length - 1; n >= 0; n--) stack.push({ i: kids[i][n], prefix: childPrefix, last: n === kids[i].length - 1 });
    }
    console.log(`\n${shown} ticket(s)`);
}

function rebuildIndex() {
    ensureDirs();
    const tickets = allTickets();
    const open = tickets.filter((t) => t.frontmatter.status !== 'closed');
    const closed = tickets.filter((t) => t.frontmatter.status === 'closed');
    const openIds = new Set(open.map((t) => t.frontmatter.id));
    const forest = buildForest(vaultTickets());

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
                + (fm.decision_needed === true ? ' · **decision needed**' : '')
                + (fm.reviewed ? '' : ' · **unreviewed**')
                + (tags ? ` · ${tags}` : '')
                + (blockers.length ? ` · ⛔ ${blockers.map((b) => `[[${b}]]`).join(', ')}` : '')
                + (forest.parentOf.has(fm.id) ? ` · ↑ [[${forest.parentOf.get(fm.id)}]]` : '')
                + (forest.roll(fm.id)?.total ? ` · ▣ ${formatRollup(forest.roll(fm.id))}` : ''));
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

    // Children tables follow the tree, including notes in other projects whose
    // rollups just changed. Tickets with no children and no markers are skipped.
    for (const t of forest.byId.values()) syncChildrenNote(forest, t);
}

function cmdShow() {
    const id = positional[0];
    if (!id) { console.error('Usage: ticket.mjs show <id>'); process.exit(1); }
    const forest = buildForest(vaultTickets());
    const t = forest.byId.get(id);
    if (!t) { console.error(`No such ticket: ${id}`); process.exit(1); }
    const fm = t.frontmatter;
    const parent = forest.parentOf.get(id);
    const rollup = formatRollup(forest.roll(id));
    console.log(`${fm.id} [${fm.type}] ${fm.status} P${fm.priority}  ${fm.title}`);
    if (parent) console.log(`parent: ${parent}`);
    if (rollup) console.log(`rollup: ${rollup}`);
    if (forest.children(id).length) {
        console.log(`\n${childrenTable(forest, id).join('\n')}`);
        syncChildrenNote(forest, t);
    }
}

// ── Supporting docs ───────────────────────────────────────────────────────────
// A vault note names the ticket(s) it serves in its OWN frontmatter (`ticket:` or
// `tickets:`, plus an optional `kind:`). Tickets are never edited for this, because
// their frontmatter is rewritten from a fixed key list and anything extra is lost.
const DOC_KINDS = ['brief', 'plan', 'research', 'review', 'runbook', 'uat', 'decision', 'other'];
const SECRET_NAME = /^(\.env(\..*)?|ssm-.*\.json)$/i;

/** Split a note into frontmatter lines and the rest; `lines` is null when there is no frontmatter. */
function splitFrontmatter(raw) {
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!m) return { lines: null, tail: '', rest: raw };
    return { lines: m[1].split('\n'), tail: m[0].slice(4 + m[1].length), rest: raw.slice(m[0].length) };
}

/** Replace the `key:` line, or append one; every other line keeps its place. */
function setLine(lines, key, value) {
    const i = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (i === -1) lines.push(`${key}: ${value}`);
    else lines[i] = `${key}: ${value}`;
}

/** Ticket ids a note's frontmatter names (`ticket`, `tickets`, `epic`); `none` means project-level. */
const docTicketIds = (fm) => [fm.ticket, fm.tickets, fm.epic].flat()
    .filter((v) => typeof v === 'string' && v && v !== 'none');

/**
 * Where a note's ticket attribution sits: the ids it names, the line indexes that
 * hold them (`ticket:`, `tickets:` and the items of a block-style list) and the first of those.
 */
function readAttribution(lines) {
    const ti = lines.findIndex((l) => l.startsWith('ticket:'));
    const si = lines.findIndex((l) => l.startsWith('tickets:'));
    const at = [ti, si].filter((i) => i !== -1);
    const items = [];
    if (si !== -1 && !lines[si].slice('tickets:'.length).trim()) {
        for (let i = si + 1; /^\s+-\s/.test(lines[i] ?? ''); i++) items.push(i);
    }
    const fm = {
        ticket: ti === -1 ? undefined : parseScalar(lines[ti].slice('ticket:'.length)),
        tickets: si === -1 ? undefined : [parseScalar(lines[si].slice('tickets:'.length)), ...items.map((i) => parseScalar(lines[i].replace(/^\s+-\s+/, '')))].flat(),
    };
    return { ids: docTicketIds(fm), lines: new Set([...at, ...items]), anchor: at.length ? Math.min(...at) : -1 };
}

/**
 * The note's frontmatter lines with `id` added to the tickets it names and, when
 * given, `kind` set. A second ticket turns `ticket:` into `tickets:` in place.
 * Nothing else is touched, so a note that already says this comes back identical.
 */
function withAttribution(lines, id, kind) {
    const have = readAttribution(lines);
    let out = [...lines];
    if (!have.ids.includes(id)) {
        const all = [...have.ids, id];
        const value = all.length === 1 ? `ticket: ${yamlStr(id)}` : `tickets: ${yamlList(all)}`;
        out = out.flatMap((l, i) => (i === have.anchor ? [value] : []).concat(have.lines.has(i) ? [] : [l]));
        if (have.anchor === -1) out.push(value);
    }
    if (kind) setLine(out, 'kind', kind);
    return out;
}

/** Add the attribution to a note's text; creates frontmatter when there is none. */
function attributeNote(raw, id, kind) {
    const { lines, tail, rest } = splitFrontmatter(raw);
    if (!lines) return `---\n${withAttribution([], id, kind).join('\n')}\n---\n${raw}`;
    return `---\n${withAttribution(lines, id, kind).join('\n')}${tail}${rest}`;
}

/**
 * A note under Projects/, as { abs, rel }. Refuses anything that is not a regular
 * .md file reached without `..` or a symlink, a secret-looking name, and ticket
 * notes themselves (xenophon owns their frontmatter).
 */
function resolveNote(input) {
    const fail = (why) => { console.error(`${input}: ${why}`); process.exit(1); };
    const projects = join(vault, 'Projects');
    if (!existsSync(projects)) fail(`no Projects folder in the vault at ${vault}`);
    const abs = resolve(isAbsolute(input) ? input : join(vault, input));
    const rel = relative(resolve(projects), abs);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail('must be a note under Projects/ in the vault.');
    if (!abs.endsWith('.md') || SECRET_NAME.test(basename(abs))) fail('must be a markdown note.');
    if (rel.split(sep).includes('Tickets')) fail('ticket notes cannot be attached to; use new, set and log.');
    if (!existsSync(abs)) fail('no such note.');
    if (lstatSync(abs).isSymbolicLink() || realpathSync(abs) !== join(realpathSync(projects), rel)) fail('symlinks are not followed.');
    return { abs, rel: rel.split(sep).join('/') };
}

function cmdAttach() {
    const note = positional[0];
    const id = arg('ticket');
    const kind = arg('kind');
    if (!note || !id) {
        console.error(`Usage: ticket.mjs attach <note-path-or-vault-relative> --ticket <id> [--kind ${DOC_KINDS.join('|')}]`);
        process.exit(1);
    }
    if (kind !== null && !DOC_KINDS.includes(kind)) { console.error(`kind must be one of: ${DOC_KINDS.join(', ')}`); process.exit(1); }
    if (!vaultTickets().some((t) => t.frontmatter.id === id)) { console.error(`No such ticket: ${id}`); process.exit(1); }
    const doc = resolveNote(note);
    console.log(`${writeFile(doc.abs, attributeNote(readFileSync(doc.abs, 'utf8'), id, kind))}  ${doc.abs}`);
}

/** Every note with frontmatter under Projects/ (not Tickets, symlinks or secret names), one scan. */
function vaultDocs() {
    const root = join(vault, 'Projects');
    const out = [];
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.isSymbolicLink() || e.name.startsWith('.') || SECRET_NAME.test(e.name) || e.name === 'Tickets') continue;
            const p = join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.md')) {
                const d = readTicket(p);
                if (d) out.push({ ...d, rel: relative(vault, p).split(sep).join('/') });
            }
        }
    };
    if (existsSync(root)) walk(root);
    return out;
}

const FOLDER_KIND = { plans: 'plan', research: 'research', reviews: 'review', runbooks: 'runbook', briefs: 'brief' };

/** `kind:` wins, then a `type:` that is a kind, then the folder the note sits in, else other. */
function docKind(d) {
    const fm = d.frontmatter;
    return [fm.kind, fm.type].find((k) => DOC_KINDS.includes(k))
        ?? d.rel.split('/').slice(0, -1).map((s) => FOLDER_KIND[s.toLowerCase()]).find(Boolean) ?? 'other';
}

/** `updated`, else `last-updated`, `date`, `created`; null when the note carries none (never invented). */
function docDate(d) {
    for (const k of ['updated', 'last-updated', 'date', 'created']) {
        const v = String(d.frontmatter[k] ?? '').match(/^\d{4}-\d{2}-\d{2}/);
        if (v) return v[0];
    }
    return null;
}

function docTitle(d) {
    const fm = d.frontmatter;
    if (typeof fm.title === 'string' && fm.title) return fm.title;
    return d.body.match(/^#\s+(.+?)\s*$/m)?.[1] ?? basename(d.rel, '.md');
}

/** Notes naming the epic or any ticket under it (any depth, any project), newest first. */
function epicDocs(forest, epicId) {
    const tree = new Set(forest.walk([epicId]).map((e) => e.t.frontmatter.id));
    return vaultDocs().filter((d) => docTicketIds(d.frontmatter).some((id) => tree.has(id)))
        .map((d) => ({ title: docTitle(d), kind: docKind(d), updated: docDate(d), path: d.rel, tickets: docTicketIds(d.frontmatter) }))
        .sort((a, b) => String(b.updated).localeCompare(String(a.updated)) || a.path.localeCompare(b.path));
}

const KIND_ORDER = ['brief', 'plan', 'uat', 'runbook', 'review', 'research', 'decision', 'other'];

function cmdDocs() {
    const id = positional[0];
    if (!id) { console.error('Usage: ticket.mjs docs <epic-id> [--json]'); process.exit(1); }
    const forest = buildForest(vaultTickets());
    if (!forest.byId.has(id)) { console.error(`No such ticket: ${id}`); process.exit(1); }
    const docs = epicDocs(forest, id);
    const groups = KIND_ORDER.map((kind) => ({ kind, items: docs.filter((d) => d.kind === kind) })).filter((g) => g.items.length);
    if (has('json')) { console.log(JSON.stringify({ epic: id, groups }, null, 2)); return; }
    if (!docs.length) { console.log(`No docs attributed to ${id} or anything under it.`); return; }
    for (const g of groups) {
        console.log(`${g.kind} (${g.items.length})`);
        for (const d of g.items) console.log(`  ${d.updated ?? 'undated   '}  ${d.title}  ${d.path}`);
    }
    console.log(`\n${docs.length} doc(s)`);
}

// ── Epic brief ────────────────────────────────────────────────────────────────
// One short note per epic at Projects/<epic's project>/Briefs/<epic-id>.md. Its
// frontmatter records a snapshot (`basis`) and a written-at date (`updated`), so
// whether it has gone stale is computed from the tickets and docs, never claimed.

/** The epic's numbers as one comparable line. */
function briefBasis(forest, id) {
    const r = forest.roll(id);
    return `closed ${r.closed} of ${r.total} · blocked ${r.blocked} · points ${r.ptsDone} of ${r.ptsTotal} · ${forest.byId.get(id).frontmatter.status}`;
}

function briefPath(epic) {
    const project = relative(join(vault, 'Projects'), epic.path).split(sep)[0];
    return join(vault, 'Projects', project, 'Briefs', `${epic.frontmatter.id}.md`);
}

function renderBrief(epic, basis) {
    const id = epic.frontmatter.id;
    return [
        '---', 'kind: brief', `epic: ${yamlStr(id)}`, `title: ${yamlStr(epic.frontmatter.title)}`,
        `updated: ${today()}`, `basis: ${yamlStr(basis)}`, `owner: ${yamlStr(DECIDER)}`, '---',
        `# ${id} brief`, '',
        '## Goal', '', 'One sentence.', '',
        '## Why', '', 'Two or three sentences: who is waiting and what it costs to wait.', '',
        '## Status', '', 'One paragraph, written for someone who has not looked in a week.', '',
        '## What done looks like', '', `See [[${id}]] (canonical).`, '',
        '## Key decisions', '', '- YYYY-MM-DD: the decision in one line, with a link', '',
        '## Risks', '', '- risk: likelihood, impact, what would tell us early', '',
        '## Owners', '', '- decider, builder, reviewer', '',
        '## Important links', '', '- [[a plan]] · [[a runbook]] · [label](https://...)', '',
        '## Open questions', '', '- question, recommended answer, who decides', '',
    ].join('\n');
}

/** Why the brief is out of date, or [] when it is current. Compares ISO dates as strings. */
function briefStaleness(forest, epic, brief) {
    const id = epic.frontmatter.id;
    const since = String(brief.frontmatter.updated ?? '');
    const reasons = [];
    const basis = briefBasis(forest, id);
    if (brief.frontmatter.basis !== basis) reasons.push(`numbers changed: brief says "${brief.frontmatter.basis ?? 'nothing'}", now "${basis}"`);
    const newer = (items) => (items.length > 5 ? `${items.slice(0, 5).join(', ')} and ${items.length - 5} more` : items.join(', '));
    const tickets = forest.walk([id]).map((e) => e.t).filter((t) => String(t.frontmatter.updated) > since).map((t) => t.frontmatter.id);
    if (tickets.length) reasons.push(`${tickets.length} ticket(s) updated after ${since}: ${newer(tickets)}`);
    const docs = epicDocs(forest, id).filter((d) => d.updated && d.updated > since).map((d) => d.path);
    if (docs.length) reasons.push(`${docs.length} doc(s) updated after ${since}: ${newer(docs)}`);
    return reasons;
}

function cmdBrief() {
    const id = positional[0];
    if (!id) { console.error('Usage: ticket.mjs brief <epic-id> [--init | --refresh]'); process.exit(1); }
    if (has('init') && has('refresh')) { console.error('Pass --init or --refresh, not both.'); process.exit(1); }
    const forest = buildForest(vaultTickets());
    const epic = forest.byId.get(id);
    if (!epic) { console.error(`No such ticket: ${id}`); process.exit(1); }
    const path = briefPath(epic);
    const brief = existsSync(path) ? readTicket(path) : null;

    if (has('init')) {
        if (brief) { console.log(`exists  ${path} (not overwritten)`); return; }
        if (!dryRun) mkdirSync(join(path, '..'), { recursive: true });
        console.log(`${writeFile(path, renderBrief(epic, briefBasis(forest, id)))}  ${path}`);
        return;
    }
    if (!brief) { console.log(`${id} brief: missing\nCreate it with: ticket.mjs brief ${id} --init`); return; }

    if (has('refresh')) {
        const { lines, tail, rest } = splitFrontmatter(brief.raw);
        if (!lines) { console.error(`${path} has no frontmatter to refresh.`); process.exit(1); }
        setLine(lines, 'updated', today());
        setLine(lines, 'basis', yamlStr(briefBasis(forest, id)));
        console.log(`${writeFile(path, `---\n${lines.join('\n')}${tail}${rest}`)}  ${path}`);
        console.log('Only updated and basis were rewritten; revisit Status and the other sections.');
        return;
    }

    const reasons = briefStaleness(forest, epic, brief);
    console.log(`${id} brief: ${reasons.length ? 'stale' : 'fresh'} (written ${brief.frontmatter.updated ?? 'undated'})\n${path}`);
    for (const r of reasons) console.log(`  - ${r}`);
    if (reasons.length) console.log(`Rewrite what changed, then: ticket.mjs brief ${id} --refresh`);
}

const COMMON_FLAGS = ['vault', 'project', 'dry-run'];
const FLAGS = {
    new: ['title', 'problem', 'context', 'scope', 'done', 'accept', 'out', 'points', 'decision', 'evidence', 'link',
        'type', 'priority', 'labels', 'external', 'blocked-by', 'body-file', 'id', 'parent'],
    list: ['status', 'ready', 'label', 'unreviewed', 'decisions', 'under', 'epic', 'depth', 'tree'],
    close: ['reason', 'force'],
    reopen: [],
    set: ['priority', 'labels', 'blocked-by', 'external', 'title', 'reviewed', 'status', 'parent'],
    decide: ['decision', 'clear'],
    log: [],
    promote: [],
    show: [],
    attach: ['ticket', 'kind'],
    docs: ['json'],
    brief: ['init', 'refresh'],
    index: [],
};

/** Edit distance, for the "did you mean" hint only. */
function distance(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        let prev = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const tmp = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = tmp;
        }
    }
    return row[b.length];
}

/** Exit non-zero on any flag the command does not take, before anything is written. */
function rejectUnknownFlags(command) {
    const allowed = [...FLAGS[command], ...COMMON_FLAGS];
    const unknown = argv.slice(1).filter((a) => a.startsWith('--') && !allowed.includes(a.slice(2)));
    if (!unknown.length) return;
    for (const flag of unknown) {
        const name = flag.slice(2);
        const near = allowed.find((c) => c.startsWith(name) || name.startsWith(c) || distance(c, name) <= 2);
        console.error(`unknown flag ${flag} for '${command}'${near ? ` (did you mean --${near}?)` : ''}`);
    }
    process.exit(1);
}

const commands = { new: cmdNew, list: cmdList, close: cmdClose, reopen: cmdReopen, set: cmdSet, index: rebuildIndex, decide: cmdDecide, log: cmdLog, promote: cmdPromote, show: cmdShow, attach: cmdAttach, docs: cmdDocs, brief: cmdBrief };
if (!commands[cmd]) {
    console.error(`Usage: ticket.mjs <new|list|show|close|reopen|set|decide|log|promote|attach|docs|brief|index> [...]`);
    process.exit(1);
}
rejectUnknownFlags(cmd);
commands[cmd]();
