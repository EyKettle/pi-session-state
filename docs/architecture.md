# Architecture

English | [中文](../docs_zh-CN/architecture.md)

- [API](api.md)

## Basis

The state a consumer stores decides the shape of its access.

| Fact | Source |
| --- | --- |
| A write is triggered by an explicit action, one action one write | `import_skill`, `cancel_skill`, an identity switch |
| A read happens on every request | tail-segment assembly, system-prompt assembly |
| A scope holds one value and no history | an identity, the loaded-skill list |
| The value's field structure belongs to the consumer and changes as it is updated | the two consumers' fields are entirely different |
| Pi offers no writable state slot | `ReadonlySessionManager` is getters throughout |
| One file serves every session | default `{agent_dir}/sessions/states.sqlite` |

> [!note]
> A scenario that needs history uses Pi's own entries. session-state owns only
> the state that needs no history.

## Layers

| Layer | Knows | Does not know |
| --- | --- | --- |
| Interface | the scope declaration, read/write/drop, parameter validation | the session tree, SQL |
| Key | the triple derived from `ctx` | SQL, the rest of Pi |
| Store | SQLite reads and writes, the in-process cache | Pi |

## Key

The primary key is `pluginId`, `sessionId`, `branchId`.

| `scope` | `sessionId` | `branchId` |
| --- | --- | --- |
| `"session"` | `getSessionId()` | `""` |
| `"branch"` | `getSessionId()` | `branchKey(ctx)` |

## Branch key

```text
key(leaf):
  node = leaf
  loop:
    parent = node's parent
    no parent              → return node
    parent has ≠ 1 child   → return node
    node = parent
```

| Property | Consequence |
| --- | --- |
| Appending along a branch only lengthens a single-child chain | the key does not change, so a write always lands on the same row |
| The key is always the top of a single-child run | no key is produced that corresponds to no branch |
| A fork made above a leaf moves that leaf's key | a read must ascend; one lookup is not enough |

A read ascends run by run: it looks up the current key, then its parent run's
key, up to the root, and takes the first hit.

A write writes the current key only; it neither ascends nor writes a parent run.

## Storage

Two tables.

```sql
CREATE TABLE IF NOT EXISTS state (
  plugin_id  TEXT NOT NULL,
  session_id TEXT NOT NULL,
  branch_id  TEXT NOT NULL,   -- '' is session scope
  value      TEXT NOT NULL,   -- JSON
  PRIMARY KEY (plugin_id, session_id, branch_id)
);

CREATE TABLE IF NOT EXISTS write_lock (
  session_id TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  acquired_at INTEGER NOT NULL  -- the moment it was acquired, in ms
);
```

WAL is on. Cross-session contention waits in SQLite (`busy_timeout`).

### Session lock

`write` and `drop` each hold one session lock, one row of `write_lock`.

| Step | Behavior |
| --- | --- |
| Acquire | insert this process's holder and the current moment; when it is taken, read out the holder |
| Take over | the holder is this process, it is gone, or the row is older than the lease: rewrite it as this process |
| Refuse | every other case throws, with the four elements |
| Release | delete the row by holder in `finally` |

`holder` records `pid:<pid>`, `acquired_at` the moment of acquisition. Whether
the holder is gone is decided by whether its pid is alive; a crash-left row
whose pid later belongs to another live process is covered by the row's age.

The lease has to exceed the worst legitimate hold — acquire, operate, and
release may each wait on SQLite for up to `busy_timeout` — so it is 60s.

The two read-path writes, cross-fork materialization and landing a keyless
value, hold no lock, which is why reads can proceed at the same time.

| Path | Behavior |
| --- | --- |
| Read | after a scope's first load, no disk access |
| Write | holds the session lock; lands on disk synchronously, visible on return |
| A branch-scope read | ascends across forks, and materializes a hit under the current key |
| A write before the key exists | the value stays in memory; it lands once the key exists |

## Failure

A storage fault and an absence are kept apart: a fault throws, an absence is
`undefined`.

Construction validates its integration parameters (`pluginId`, `scope`,
`databasePath`): an invalid one throws rather than degrading to a shared
namespace or to in-memory storage.

## Modules

| Module | Responsibility |
| --- | --- |
| `index.ts` | the public exports and the assembly |
| `branch.ts` | branch key: leaf → key. Pure, testable without Pi |
| `store.ts` | key → row: SQLite reads and writes, the in-process cache, the ascent |
| `settings.ts` | reads the location setting from `settings.json` and normalizes it to an absolute path. Pure, testable without Pi |

## Invariants

- One triple has one row.
- Repeated writes on one branch produce one value, never a pile.
- A branch-scope read ascends across forks, so stepping back to an old branch
  brings its old value back.
- An absence is `undefined`, and no fault ever shows up as `undefined`.
- The store does not interpret a value's fields.
- A lock row never seals a session for long: a crash-left row is taken over
  after the lease.
