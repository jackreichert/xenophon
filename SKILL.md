---
name: xenophon
description: File, update, close and browse project tickets as flat markdown notes in the Obsidian vault. Trigger on xenophon, file a ticket, open a ticket, log a bug, raise an issue, track this as work, close that ticket, what tickets are open, what should I work on next, or any request to record follow-up work durably rather than in a throwaway TODO list.
user-invocable: true
argument-hint: "[new|list|show|close|reopen|set|decide|log|promote|attach|docs|brief] [description or ticket id]"
---

# Xenophon

Project work is tracked as one markdown note per ticket, in the user's Obsidian vault.

**The markdown files are the source of truth.** They are meant to be read and edited directly in Obsidian. There is no database and no sync step to forget.

## At session start

Run `node <this-skill>/scripts/update-check.mjs` once. If it prints a line, relay it to the user as-is; if it prints nothing, say nothing. It only reports, unless the `auto_pull` config key is on (see the README), in which case it fast-forwards a clean checkout that is purely behind.

## Where things live

```
{VAULT}/Projects/{repo-name}/Tickets/
    _Index.md                     generated overview, rebuilt on every write
    {repo-name}-001.md            one note per open ticket
    Archive/{repo-name}-002.md    closed tickets
```

`{VAULT}` is `$VAULT_ROOT`. It is required, and it is not guessed: if it is unset, ask where the vault lives before writing anything. The project folder is the git repo name, so tickets sit beside that project's `CONTEXT.md` and `DECISIONS.md`.

The helper is `<this-skill>/scripts/ticket.mjs`. It handles only the parts that must stay consistent: allocating ids, placing files, moving closed tickets to `Archive/`, and rebuilding the index. Everything else is just editing markdown.

## Filing a ticket

### 1. Check for an existing one

```bash
node <this-skill>/scripts/ticket.mjs list --status all       # including closed
ticket.mjs list --status open      # exactly 'open', excluding in-progress
```

Do not file a second copy of something already tracked. If it exists, update it.

### 2. Gather the content before running anything

A ticket is only worth filing if someone else could act on it. Gather:

- **Title** — the symptom or the desired outcome, not a guess at the cause
- **Problem** — what happens and why it matters (for a bug, the repro and expected vs actual)
- **What done looks like** — the observable finished state. Required. If it is unclear, ask before filing; never write `_TBD_`.
- **Acceptance criteria, scope, out of scope** — when you know them
- **Estimate** — story points, if you can size it
- **Decisions needed** — anything the reader must decide: the decision, the options, your recommendation, the stakes
- **Evidence** — `file:line` and anything *ruled out*, so the next person does not repeat the work

Record what was actually verified. If a lead is weak or rests on a small sample, say so rather than dressing it up as a finding. A ticket that overstates its evidence costs more time than no ticket.

### 3. Create it through the flags

**File through the flags. Do not hand-write a body.** The script lays out the template; you supply the fields.

```bash
node <this-skill>/scripts/ticket.mjs new \
  --title "Short, specific, symptom-first" \
  --type bug --priority 1 --labels test-flake,checkout \
  --external tracker-1234 --blocked-by repo-003 \
  --problem "..." \
  --done "..." \
  --context "..." \
  --scope "..." --accept "..." --out "..." \
  --points 2 \
  --decision "decision | options | recommendation | stakes" \
  --evidence "path/file.ts:42 - what it shows" \
  --link "PR 118"
```

Field rules:

- `--problem` and `--done` are required. `--scope`, `--accept`, `--out`, `--decision`, `--evidence`, `--link` repeat. Quote every value.
- `--decision` needs four parts separated by ` | `. With no decisions the section reads `None`. With any, the header shows `Decision needed: yes` and `list --decisions` finds it.
- The Decisions heading is generic unless a decider is configured (`XENOPHON_DECIDER` or `xenophon-config.md` in the vault); see the README.
- `--points` must be on the scale (`1,2,3,5`, or `XENOPHON_POINTS`). Anything bigger should be split.
- `--type` — `bug`, `task`, `feature`, `epic`, `chore`
- `--priority` — integer `0`–`4` (0 critical, 2 normal, 4 backlog). Words are rejected.
- `--labels`, `--blocked-by` — comma-separated, no spaces around the commas
- `--parent` — id of an existing ticket to nest under (see "Parents, epics and rollups")
- The id is allocated automatically as `{project}-NNN`. Pass `--id` only to deliberately reuse one.
- `--body-file -` is the legacy hand-written path (cannot be mixed with the template flags). Use it only for content that does not fit the template.
- `--body-file` is the only body flag. An unknown flag (e.g. `--body`) exits non-zero before anything is written; a typo no longer files a `_TBD_` ticket.

The command prints the new id on its last line.

### 4. Report

Give the user the id, the priority, and the file path. Do not commit or push the vault unless asked.

## Updating

Use `decide` and `log` to add decisions and dated updates, rather than editing those sections by hand. Other prose is plain markdown: edit the file directly. Use the script for frontmatter and file placement:

```bash
ticket.mjs set <id> --priority 0 --status in-progress --labels a,b --blocked-by other-004
ticket.mjs close <id> --reason "What actually fixed it"   # --force if it still has open descendants
ticket.mjs reopen <id>
ticket.mjs decide <id> --decision "decision | options | recommendation | stakes"   # add one
ticket.mjs decide <id> --clear      # decision made; keeps the record
ticket.mjs log <id> "what changed"   # dated line in ## Log
ticket.mjs promote <id>             # print tracker-ready markdown; writes nothing
ticket.mjs index          # rebuild _Index.md after hand-editing frontmatter
```

`close` moves the note to `Archive/`, stamps `closed:`, and appends a `## Resolution` section when `--reason` is given. `reopen` moves it back.

Statuses: `open`, `in-progress`, `blocked`, `closed`.

## Parents, epics and rollups

Any ticket can be the parent of another, to any depth; `type: epic` is a label, not a requirement. Link with `--parent <id>` on `new`, or `set <id> --parent <id|none>`. The parent must exist and a ticket may not become its own ancestor (the refusal names the cycle path). Link tickets that genuinely roll up into one outcome; do not use a parent as a label.

```bash
ticket.mjs new --title "..." --problem "..." --done "..." --parent repo-001
ticket.mjs set repo-007 --parent repo-001      # or: --parent none
ticket.mjs list --under repo-001 [--depth 1]   # descendants (--epic is an alias)
ticket.mjs list --tree [--under repo-001]      # ASCII tree with rollups
ticket.mjs show repo-001                       # parent, rollup, children table
```

- **Ids are scoped by project**: `{project}-NNN` names the project that owns the ticket. A parent is found by id across all projects in the vault, so a child in another project can hang under it. Same vault only.
- A ticket with children shows a rollup over its whole subtree in `list`, `--tree` and `_Index.md`: `2/4 closed (2 direct), 1 blocked, 8/10 pts`. It is computed on each run from frontmatter, never stored. Leaves show nothing.
- The parent's note holds a generated table of direct children between `<!-- xenophon:children -->` markers; `index` and `show` refresh it and leave everything else alone. Do not hand-edit inside the markers.
- `close` on a ticket with open descendants warns and exits non-zero; pass `--force` only when that is intended.
- A hand-edited parent loop is reported and ignored rather than breaking listing; fix the `parent:` line and re-run `index`.

## Supporting docs and the epic brief

A vault note you write for a ticket (plan, research, review, runbook, UAT) names that ticket in its own frontmatter; the epic is found by walking parents, so name the most specific ticket, not the epic. Do this before you report. Never put a docs list on a ticket: ticket frontmatter is rewritten from a fixed key set and would drop it.

```bash
ticket.mjs attach <note-path-or-vault-relative> --ticket <id> [--kind plan|research|review|runbook|uat|brief|decision|other]
ticket.mjs docs <epic-id> [--json]      # docs for the epic and everything under it, by kind
ticket.mjs brief <epic-id>              # fresh or stale, and why (or: missing)
ticket.mjs brief <epic-id> --init       # create Projects/<project>/Briefs/<epic-id>.md from the template
ticket.mjs brief <epic-id> --refresh    # restamp updated and basis only
```

- `attach` is idempotent (`unchanged` on a repeat), appends a second ticket to `tickets:`, keeps every other frontmatter key and the body, and refuses an unknown ticket, a path outside `Projects/`, symlinks, ticket notes and secret-looking names. `ticket: none` marks a note project-level.
- A brief is one short note per epic. It records a snapshot of the epic's numbers and a written-at date, and is **stale** when the numbers changed or any ticket under the epic or attributed doc is newer. When your work changes an epic's state, run `brief <epic-id>`; if it says stale or missing, rewrite the Status paragraph (create it with `--init` first), then `--refresh`. `--init` never overwrites.
- A link outside the vault (a shared UAT document, a design file) goes in the epic ticket's `## Links` section, which `promote` drops.

## Promoting to a tracker

The public sections (down to Estimate) mirror a tracker ticket; Decisions needed, Evidence, Links and Log are internal. `promote <id>` prints the markdown with internal sections and vault references removed. It only prints. Re-read it, then file it in the tracker yourself if you are asked to. Do not cite vault ids in the tracker.

## Review state

Every ticket carries a `reviewed` frontmatter field so you can see what you have actually read.
`new` sets it to `false`; marking it stamps the date, so the ticket records *when* it was reviewed,
not just that it was.

```bash
ticket.mjs set <id> --reviewed          # stamps today
ticket.mjs set <id> --reviewed no       # back to unreviewed
ticket.mjs set <id> --reviewed 2026-09-01   # backdate
ticket.mjs list --unreviewed            # what still needs a read
```

Unreviewed tickets are marked `● unreviewed` in `list` and `**unreviewed**` in `_Index.md`, so the
backlog of unread findings is visible without a filter. An agent filing a ticket always leaves it
unreviewed — only you mark it read.

## Browsing

```bash
ticket.mjs list                    # all active work (open/in-progress/blocked), highest priority first
ticket.mjs list --ready            # open, and not waiting on an unclosed blocker
ticket.mjs list --status all       # including closed
ticket.mjs list --status open      # exactly 'open', excluding in-progress
ticket.mjs list --label test-flake
ticket.mjs list --decisions        # tickets waiting on a decision
```

`--ready` is the "what can I actually pick up" view: it hides anything whose `blocked-by` still points at an open ticket.

## Working in another repo or vault

The project is inferred from `git rev-parse --show-toplevel`. Override either side:

```bash
ticket.mjs list --project some-other-repo
ticket.mjs new --title "..." --vault /path/to/other/vault
```

## Boundaries

- Do not use throwaway TODO lists for durable work — that is what this replaces. Short-lived within-turn planning is fine.
- One ticket per problem. If an investigation turned up two unrelated problems, file two.
- Frontmatter is machine-read: keep `id`, `status`, `type`, `priority`, `labels`, `blocked-by`, `parent` well-formed. The rest of the file is free-form.
- Run `ticket.mjs index` after hand-editing frontmatter so `_Index.md` stays accurate.
