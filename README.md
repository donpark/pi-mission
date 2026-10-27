# pi-mission

Mission tracking for [pi](https://pi.dev). Developers lose track of rabbit holes
and ad-hoc tasks faster than anyone remembers them. pi-mission records every
piece of work the moment it appears, tracks it autonomously while you work, and
shows what runs now, what you worked on, and what remains — in one searchable
mission list.

## Install

```bash
pi install npm:pi-mission
# or straight from git
pi install git:github.com/donpark/pi-mission
```

## What you get

- **`/mission`** — the mission list as a searchable popup. Open it with **`⌥M`**
  (name key), **`⌥J`** (the game convention — the mission list is the quest
  journal), or **`⌃⇧K`** (the closest thing to a free `⌃K`).
  Type to fuzzy-filter by title or `#id`, `↑↓/mouse` to move, `Enter` for a
  mission's actions, `←/→` to fold subtasks, `⌃o` view modes (all / open /
  current), `⌃s` sorts (board / recent / oldest / priority / status),
  `Home/End/PgUp/PgDn` to jump, `Esc` to clear the filter and close.
- **Autonomous tracking** — the agent maintains the list as it work happens:
  adds missions the moment work appears (rabbit holes included), starts them
  when work begins, completes them when done. You intervene only to override:
  the popup's actions are sent as `Mission override:` messages.
- **Named on capture** — add a rough thought and a bargain-tier model turns it
  into a concise, verb-first name (override with
  `PI_MISSION_NAME_MODEL=provider/model-id`).
- **Structure** — one level of subtasks, prerequisites (`depends_on`, cycles
  rejected), and `high/normal/low` priority. Remaining work is ordered by the
  dependency graph and marked `after #n` when blocked.
- **Persistence** — every change updates `~/.pi/agent/missions.json`
  (`PI_MISSION_STORE` overrides). New sessions adopt your open work
  automatically; finished work stays as history. An accompanying skill teaches
  other agents how to find and update these user-level missions.

## Granularity

`PI_MISSION_GRANULARITY=fine|normal|coarse` tunes how much work becomes a
mission: `fine` records every step and side quest, `normal` records each
distinct piece of work (subtasks for its steps), `coarse` records only
multi-step work items.

## Terminal note

The `⌥` shortcuts need option-as-alt from the terminal. In Ghostty, set
`macos_option_as_alt = true` — it also unlocks pi's own `⌥B/⌥D/⌥F` editor
motions. `⌃⇧K` works in CSI-u terminals without configuration.

## Legacy names

The project was previously named pi-kanban (and briefly pi-docket).
`PI_KANBAN_*` environment variables, a `kanban.json` store next to
`missions.json`, the `/kanban` command, and `Kanban override:` messages are
still accepted.

## Development

```bash
node extensions/pi-mission/selftest.mjs   # tool, store, popup, and menu behavior
```

## Publish

The `pi-package` keyword makes the package discoverable in the
[pi package gallery](https://pi.dev/packages). Host packages
(`@earendil-works/*`, `typebox`) are `peerDependencies` only — pi supplies them.

```bash
npm publish --access public
```

## License

MIT
