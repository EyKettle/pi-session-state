# API

English | [中文](../docs_zh-CN/api.md)

- [Architecture](architecture.md)

## Integration

```ts
import { openSessionState } from "pi-session-state";

const state = openSessionState<Identity>({ pluginId: "role" });
```

| Parameter | Required | Meaning |
| --- | --- | --- |
| `pluginId` | yes | the extension's identifier, and the namespace of its storage rows |
| `scope` | no | whether the state follows the session or a branch — see [Scope](#scope) |
| `databasePath` | no | the database file's absolute path — see [Storage](#storage) |

All three are validated at construction; an invalid one throws. `pluginId` is
non-empty and holds only lowercase letters, digits, hyphens, and dots.

## Scope

The scope is fixed at declaration and cannot be switched at call time.

| `scope` | Key | When to use it |
| --- | --- | --- |
| `"session"` (default) | extension + session | the state follows the whole session |
| `"branch"` | extension + session + branch | the state follows the branch |

An extension that needs both granularities opens two instances: the same
`pluginId`, a different `scope`.

## Interface

| Method | Semantics |
| --- | --- |
| `read(ctx)` | the scope's value; `undefined` when it was never written |
| `write(ctx, value)` | write the scope's value; it is on disk when this returns |
| `drop(ctx)` | remove the scope's value |

```ts
interface SessionState<T> {
  read(ctx: ExtensionContext): T | undefined;
  write(ctx: ExtensionContext, value: T): void;
  drop(ctx: ExtensionContext): void;
}
```

## Values

A value is the caller's own JSON. The store neither validates its fields
nor interprets its content; the caller owns the fields it adds and removes.

- The absence of a value is `undefined`; a written `null` is a legal value,
  and the two are distinguishable.
- Writing `undefined` throws.
- A value must be JSON-serializable; one that is not throws.

## Branches

With `scope: "branch"`, the store derives the key's third segment from the
session tree. The rule is [Branch key](architecture.md#branch-key).

`branchKey(ctx)` answers the same question as a pure query, for a caller that
wants the current branch id. session-state owns how that id is extracted, so
the id stays stable.

State is per branch: a branch inherits the state at its fork point, and
stepping back into the middle of a branch reads that branch's current value.

Before the key exists (an empty session), a write stays in memory and is
visible to reads in the same session; it lands in storage once the context
yields the key, and a process that ends before that loses it. This matches
Pi's own session record — nothing is on disk before the first assistant
message ends.

## Storage

The default is `{agent_dir}/sessions/states.sqlite`. Four sources decide the
location, first hit wins:

| Order | Source | Set by |
| --- | --- | --- |
| 1 | `openSessionState`'s `databasePath` parameter | the integrator |
| 2 | `sessionState.databasePath` in `{cwd}/.pi/settings.json` | the user, project level |
| 3 | `sessionState.databasePath` in `{agent_dir}/settings.json` | the user |
| 4 | the default location | — |

The project level is read only when the project is trusted; untrusted, it
counts as absent, which is how Pi itself treats project configuration.

The location is read at construction, and a change takes effect on the next
load.

The integration parameter takes a non-empty absolute path; anything else throws.

The setting takes three forms, each normalized to an absolute path:

| Form | Normalized to |
| --- | --- |
| an absolute path | itself |
| starting with `~` or `~/` | the user's home directory |
| a relative path | under `{agent_dir}` at the user level, under the project's `.pi` at the project level |

An absent configuration is silent. A configured value that yields no usable
location falls back to the default, and the session start reports it once
through Pi's UI.

## Boundaries

- A concurrent write to one session is refused: while another process writes
  the same session, `write`/`drop` throws. The error carries the initiator,
  the action, the object, and the reason, and Pi's UI shows it; reads proceed
  as usual. The mechanism is [Storage](architecture.md#storage).
- The cache is per process: this process reads back what it wrote, and another
  process's write does not refresh it.
- Extensions cannot see each other: an instance reads and writes only its own
  `pluginId` rows.
- Nothing is cleaned up: Pi has no session-deletion hook, so deleting a session
  file leaves its rows.
- A new location is a new database: the old file is not migrated, and the new
  one starts empty.

## Commands

The package registers two commands for inspection and reset.

| Command | What it does |
| --- | --- |
| `/state:status` | who holds this session's lock row and whether that pid is alive (`unknown` when it cannot be told); how many state rows this session has, per extension |
| `/state:force-refresh` | clear this session's lock row and drop this process's cache, then read from disk |

What they solve:

- A crash-left lock row sealed the session — clear it, and writes resume.
- Another process wrote and this process's cache is stale — drop the cache and
  read from disk.
- It is unclear where the state came from — look at the lock row and the row
  counts first, then decide.

`status` only reads, and it does not create the database when the file is
absent. `force-refresh` touches the lock row and the cache only, never a state
row; it confirms first when the holder's pid is alive or cannot be told, and
it leaves the lock alone when there is no UI to confirm with.

When the commands are out of reach — Pi is not running, say — delete the lock
row directly (the default location):

```bash
sqlite3 {agent_dir}/sessions/states.sqlite \
  "DELETE FROM write_lock WHERE session_id = '<session id>';"
```
