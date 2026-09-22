---
name: xenophon
description: File, update, close and browse project tickets as flat markdown notes in the Obsidian vault. Trigger on xenophon, file a ticket, open a ticket, log a bug, raise an issue, track this as work, close that ticket, what tickets are open, what should I work on next, or any request to record follow-up work durably rather than in a throwaway TODO list.
user-invocable: true
argument-hint: "[new|list|close|reopen|set] [description or ticket id]"
---

# Xenophon

Project work is tracked as one markdown note per ticket, in the user's Obsidian vault.

**The markdown files are the source of truth.** They are meant to be read and edited directly in Obsidian. There is no database and no sync step to forget.

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

### 2. Write the content before running anything

A ticket is only worth filing if someone else could act on it. Gather:

- **Title** — the symptom or the desired outcome, not a guess at the cause
- **Description** — what happens, the scope, and why it matters
- **Steps to Reproduce** — for a bug, the exact command and what to expect
- **Expected vs Actual**
- **Acceptance criteria** — how we will know it is done
- **Evidence already gathered** — especially hypotheses *ruled out*, so the next person does not repeat the work
- **Design notes** — concrete next avenues, ordered

Record what was actually verified. If a lead is weak or rests on a small sample, say so on the ticket rather than dressing it up as a finding. A ticket that overstates its evidence costs more time than no ticket.

### 3. Create it

```bash
node <this-skill>/scripts/ticket.mjs new \
  --title "Short, specific, symptom-first" \
  --type bug \
  --priority 1 \
  --labels test-flake,checkout \
  --external tracker-1234 \
  --blocked-by repo-003 \
  --body-file - <<'BODY'
## Symptom
...

## Steps to Reproduce
...

## Expected vs Actual
...

## Acceptance Criteria
...

## Ruled out, with evidence
...

## Design
...
BODY
```

Field rules:

- `--type` — `bug`, `task`, `feature`, `epic`, `chore`
- `--priority` — integer `0`–`4` (0 critical, 2 normal, 4 backlog). Words are rejected.
- `--labels`, `--blocked-by` — comma-separated, no spaces around the commas
- `--body-file -` reads the body from stdin. Use a heredoc; long inline strings get mangled by shell quoting.
- The id is allocated automatically as `{project}-NNN`. Pass `--id` only to deliberately reuse one.

The command prints the new id on its last line.

### 4. Report

Give the user the id, the priority, and the file path. Do not commit or push the vault unless asked.

## Updating

The body is plain markdown — edit the file directly, in Obsidian or with the Edit tool. Use the script for frontmatter and file placement:

```bash
ticket.mjs set <id> --priority 0 --status in-progress --labels a,b --blocked-by other-004
ticket.mjs close <id> --reason "What actually fixed it"
ticket.mjs reopen <id>
ticket.mjs index          # rebuild _Index.md after hand-editing frontmatter
```

`close` moves the note to `Archive/`, stamps `closed:`, and appends a `## Resolution` section when `--reason` is given. `reopen` moves it back.

Statuses: `open`, `in-progress`, `blocked`, `closed`.

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
- Frontmatter is machine-read: keep `id`, `status`, `type`, `priority`, `labels`, `blocked-by` well-formed. The rest of the file is free-form.
- Run `ticket.mjs index` after hand-editing frontmatter so `_Index.md` stays accurate.
