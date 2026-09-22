# xenophon

File, update, close, and browse project tickets as flat markdown notes in an Obsidian vault.

**The markdown files are the source of truth.** Read and edit them in Obsidian. There is no database and no sync step. The script only does the jobs that must stay consistent: allocating ids, placing files, moving closed tickets into `Archive/`, and rebuilding the index.

The agent protocol is in [SKILL.md](SKILL.md). The helper is [scripts/ticket.mjs](scripts/ticket.mjs).

## Requirements

- Node.js 18 or newer. The script uses only `node:` built-ins; nothing to `npm install`.
- `git` on `PATH`, and only if you want the project name inferred from the current repo. Otherwise pass `--project`.
- An [Obsidian](https://obsidian.md) vault, or any directory you treat as one. Tickets are ordinary markdown with YAML frontmatter.

## Install

Clone once, then symlink every other harness at that same folder. A second copy that you edit will drift, and the agent will file tickets with whichever copy it loaded.

```bash
mkdir -p ~/.claude/skills
git clone <this-repo-url> ~/.claude/skills/xenophon

mkdir -p ~/.agents/skills
ln -s ~/.claude/skills/xenophon ~/.agents/skills/xenophon

# Copilot, if it reads ~/.copilot/skills:
mkdir -p ~/.copilot/skills
ln -s ~/.claude/skills/xenophon ~/.copilot/skills/xenophon
```

Start a new agent session and ask it to file a ticket. If it does not load the skill, that harness is not reading the directory you symlinked. Add a symlink. Do not copy the files.

Nothing else is installed. `scripts/ticket.mjs` uses only Node built-ins. `git` is used only to infer the project name from the current repo. Pass `--project` when you are not inside that repo.

## Set the vault

Tickets are markdown files in a folder you name. There is no default path. On first use the agent should ask:

> Where should tickets live? Absolute path to your Obsidian vault, or any folder you treat as one.

Answer with a real path. Put it in the shell profile the agent process inherits (`~/.zshrc` on macOS, or the equivalent).

```bash
# Your path, not this placeholder.
export VAULT_ROOT="/absolute/path/to/your/vault"
```

Open a new terminal and confirm the variable is set before you file anything:

```bash
echo "$VAULT_ROOT"
node ~/.claude/skills/xenophon/scripts/ticket.mjs list --project demo
```

`list` does not create files. The first `new` creates:

```text
$VAULT_ROOT/Projects/demo/Tickets/
```

If the command says the vault path is not set, the agent did not inherit `VAULT_ROOT`. Fix the profile, or pass `--vault /absolute/path/to/your/vault` for that one command. `--vault` overrides the variable for that invocation. Set the variable anyway, or every new session will ask again.

Use the same `VAULT_ROOT` as the-maestro if you install both. Tickets then sit beside that project's `CONTEXT.md`.

## Personalize

Most of this skill is already generic. The few local choices are yours to set, not the package's to guess.

1. **Vault path.** That is `VAULT_ROOT` above. Do not write your path into `SKILL.md` or `ticket.mjs` if you might publish the fork.
2. **Project name.** Inside a git repo the script uses the repo directory name. From a multi-repo parent, that inference is wrong, so always pass `--project <repo-name>`. The folder under `Projects/` should match the repo name.
3. **Issue-tracker pointer, optional.** `--external` is a string you choose (`tracker-1234`, a URL, nothing). It is not synced anywhere. If your repos require a tracker key in branch names, keep using that key. A vault id such as `billing-api-014` is not a substitute.
4. **Who marks a ticket read.** `new` sets `reviewed: false`. You mark it read with `set <id> --reviewed`. Leave that as the rule unless you want agents to stamp tickets read, which hides the unread backlog.

If you and the-maestro share a vault, do not create a second vault for tickets. One `VAULT_ROOT`, one `Projects/` tree.

## Where tickets live

```
$VAULT_ROOT/Projects/{repo-name}/
    CONTEXT.md                         # project orientation, not owned by this skill
    Tickets/
        _Index.md                      # generated; rebuilt on every write
        {repo-name}-001.md             # one note per open ticket
        Archive/{repo-name}-002.md     # closed tickets
```

The project folder name should be the git repo name, so tickets sit beside that project's `CONTEXT.md`. From a container directory that is not itself a git repo, always pass `--project`. Inference uses `git rev-parse --show-toplevel`, which is the wrong answer at a multi-repo root.

## Filing a ticket

Check first. Do not file a second copy of something already tracked.

```bash
node ~/.claude/skills/xenophon/scripts/ticket.mjs list --status all --project billing-api
```

Then create one. A ticket is only worth filing if someone else could act on it: symptom, scope, how you will know it is done, and what you already ruled out.

```bash
node ~/.claude/skills/xenophon/scripts/ticket.mjs new \
  --project billing-api \
  --title "Checkout hides the compliance tab for readers" \
  --type bug \
  --priority 1 \
  --labels permissions \
  --external tracker-1234 \
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
BODY
```

The new id prints on the last line, as `{project}-NNN`.

Field rules:

| Flag | Values |
|---|---|
| `--type` | `bug`, `task`, `feature`, `epic`, `chore` |
| `--priority` | Integer `0`–`4`. `0` is critical, `2` is normal, `4` is backlog. Words are rejected. |
| `--labels`, `--blocked-by` | Comma-separated, no spaces around the commas. |
| `--body-file -` | Read the body from stdin. Use a heredoc; inline strings get mangled by the shell. |
| `--id` | Only to deliberately reuse an id. Otherwise it is allocated. |
| `--external` | A pointer to Jira or another tracker. This skill does not sync with it. |

## Updating and browsing

Edit the body in Obsidian or any editor. Use the script for frontmatter and file placement.

```bash
T=~/.claude/skills/xenophon/scripts/ticket.mjs

node $T set billing-api-001 --priority 0 --status in-progress --labels a,b
node $T set billing-api-001 --reviewed              # stamps today
node $T set billing-api-001 --reviewed no           # back to unreviewed
node $T close billing-api-001 --reason "What actually fixed it"
node $T reopen billing-api-001
node $T index --project billing-api                 # after hand-editing frontmatter
```

Statuses: `open`, `in-progress`, `blocked`, `closed`.

`close` moves the note to `Archive/`, stamps `closed:`, and appends a `## Resolution` section when `--reason` is given.

```bash
node $T list --project billing-api                   # active work, highest priority first
node $T list --ready --project billing-api           # open, and not waiting on an open blocker
node $T list --status open --project billing-api     # exactly open, not in-progress
node $T list --unreviewed --project billing-api      # filed but not yet read
node $T list --label permissions --project billing-api
```

`--ready` is the "what can I pick up" view. It hides anything whose `blocked-by` still points at an open ticket.

`new` sets `reviewed: false`. Whoever files the ticket leaves it unreviewed. You mark it read. Unreviewed tickets show as `● unreviewed` in `list` and `**unreviewed**` in `_Index.md`.

## Frontmatter

The script reads these fields. Keep them well-formed. The rest of the note is free-form markdown.

```yaml
---
id: billing-api-001
title: "Checkout hides the compliance tab for readers"
status: open
type: bug
priority: 1
labels: [permissions]
blocked-by: []
external: ""
reviewed: false
created: 2026-09-22
---
```

After you edit those fields by hand, run `ticket.mjs index` so `_Index.md` matches.

## Working in another repo or vault

```bash
node $T list --project some-other-repo
node $T new --title "..." --vault /path/to/other/vault --project some-other-repo
```

`--project` overrides git inference. `--vault` overrides `VAULT_ROOT`.

## Boundaries

- One ticket per problem. Two unrelated findings are two tickets.
- Do not use a throwaway TODO list for work that should outlive the conversation. Within-turn planning is fine.
- Ticket ids (`billing-api-014`) are not issue-tracker keys. If a repo requires a tracker key in branch names, ask for that key. Do not substitute a vault id.
- Record what was actually verified. A ticket that overstates its evidence costs more than no ticket.
- Do not commit or push the vault unless you mean to. This skill only writes markdown under `Projects/<project>/Tickets/`.

## Sharing

This folder is the shareable unit: `SKILL.md`, `scripts/ticket.mjs`, and this README.

Do not put a vault, sample tickets with real findings, or anything under `Projects/` into the skill repo. Recipients point the script at their own vault.
