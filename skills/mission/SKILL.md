---
name: mission
description: The session task board maintained by the pi-mission extension. Use when the user asks about their tasks or work items — what is open, started, done, or remaining, what is on the board, what they worked on in this session, or to carry unfinished work over from a previous session (handoff) — or when an agent must find, query, or update the session's tracked tasks. Covers where the board data lives, the per-session append log, subtask/prerequisite/priority semantics, the handoff recipe, the override convention, and the granularity setting. Prefer this over ad-hoc scratch lists for anything that is a task.
---

# mission — the session's task board

pi-mission (~/.pi/agent/extensions/pi-mission/) tracks the session's work items:
planned, started, and finished tasks, with subtasks, prerequisites, and
priority. The board is session-scoped, like `/tree`: each session has its own
board and a new session starts empty.

When the user asks to track, add, or record tasks ("add these as tasks", "add
the remaining open items", "keep track of this work"), the answer is one
`mission` tool call — see **Update the board** below for the exact arguments.

## Where the data lives

- One append-only JSONL file per session:
  `~/.pi/agent/mission-boards/<session-id>.jsonl` (override: `PI_MISSION_STORE`
  points at the directory). The same per-file pattern pi uses for session
  transcripts.
- Each line is the board snapshot after one change: `{ "ts": <ms>, "nextId": n,
  "tasks": [Task, ...] }`. The current board is the last line; the lines before
  it are that session's history. A torn trailing line (crash mid-append) is
  skipped on read.
- Task record: `id` (unique within the session's board), `title`, `status`
  (`pending|active|done|dropped`), `priority` (`high|normal|low`; absent or
  `normal` = normal), `parent` (supertask id or null; one nesting level),
  `dependsOn` (ids that must be done first), `createdAt`, `updatedAt?`,
  `startedAt?`, `doneAt?` (ms).
- Other sessions' files are history. Read them to answer "what did I work on"
  questions. Copy their tasks onto the current board only in a handoff the user
  asked for (see Hand off unfinished work) — never automatically.

## Read the board

```sh
# current board of one session (latest snapshot)
tail -1 ~/.pi/agent/mission-boards/<session-id>.jsonl | jq -r \
  '.tasks[] | "\(.id) [\(.priority // "normal")] \(.status) \(.title)"'

# one session's history (how the board evolved)
jq -r '"\(.ts)", (.tasks[] | "  \(.status) \(.title)")' \
  ~/.pi/agent/mission-boards/<session-id>.jsonl
```

Reading the board semantics:

- `active` = in progress now. `pending` = remaining work.
- A pending task is **blocked** when any `dependsOn` id is neither `done` nor
  `dropped` (a missing id counts as satisfied). Remaining work is ordered by
  this dependency graph, dependencies first.
- Subtasks hang off `parent`; progress on a parent often shows in its subtasks.
- `priority` high/low are explicit; anything else is normal.

## Update the board

In a pi session the tool is **`mission`**. One call per change; `add` takes
many tasks in one call. The board is maintained autonomously: add work the
moment it appears, start it when work begins, done when it completes.

Common cases as literal tool arguments:

- One task: `{ "action": "add", "title": "Fix the exporter crash" }`
- Many tasks in one call (e.g. "add the remaining open items"):
  `{ "action": "add", "tasks": [{ "title": "…" }, { "title": "…" }] }` —
  one entry per task, ids assigned in order, all-or-nothing (an invalid entry
  adds nothing). Per entry: `title` (exact name) or `capture` (rough thought —
  a concise name is generated), `parent` (supertask id), `depends_on`,
  `priority` (high/normal/low).
- To make one new task wait on another new task: add both first, then wire them
  with `dep` — batch `depends_on` ids must already exist on the board.
- Remaining actions: `dep` (id, depends_on — set prerequisites, rejects cycles),
  `prio` (id, priority), `start` (id), `done` (id), `drop` (id), `list`.
- Every change appends a snapshot line.
- A message that starts with `Mission override:` is a manual state change from
  the user. Apply it exactly and do not relitigate it.
- Outside pi (no tool available): append one snapshot line to the session's
  file — copy the previous line's `tasks`, apply the change, bump `nextId` when
  adding. Never renumber ids inside one session.

## Hand off unfinished work

Carry-over happens only when the user asks ("carry over last session's
unfinished tasks", "continue where we left off") — never automatically.

- `/mission-handoff` (in a pi session) does it end to end: it sends the
  unfinished (`pending`/`active`) tasks of **every** earlier board that still
  has open work to the agent, which adds them with one batch `add`, skipping
  titles already on this board (a newer board's copy of a title wins over an
  older one's). A session where the handoff was forgotten therefore does not
  shadow older leftovers. The message names each source session — when
  interleaved projects mixed boards, correct it in conversation and read the
  right file instead.
- By hand: `tail -1` the previous session's file, keep tasks with status
  `pending` or `active`, skip titles already on this board, and add the rest in
  one call: `{ "action": "add", "tasks": [{ "title": "…" }, …] }`.
- Carried-over tasks enter the board as `pending` — work restarts here.
- The safe end-of-session step is not a command: keep the board honest — mark
  finished work `done` or `dropped` before quitting, so the unfinished set is
  already curated.

## Granularity

`PI_MISSION_GRANULARITY=fine|normal|coarse` (default normal) tunes how much
work becomes a task: `fine` records every step and side quest, `normal` records
each distinct piece of work, `coarse` records only multi-step work items and
folds small steps into the parent. Set it in the environment that launches pi.

## Related

- The `/mission` command or the `alt+k` / `ctrl+shift+k` shortcut shows the board
  as a searchable popup in a pi session (filter by typing, `⌃s` sorts, `⌃o`
  view modes, `←/→` folds subtasks).
- Task names are generated by a bargain-tier model when a task is added from a
  raw capture (`PI_MISSION_NAME_MODEL` overrides the model).
