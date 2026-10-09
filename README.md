# session-state extension

[![npm](https://img.shields.io/npm/v/pi-session-state)](https://www.npmjs.com/package/pi-session-state) [![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-%23FE5196?logo=conventionalcommits&logoColor=white)](https://conventionalcommits.org) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

English | [中文](README.zh-CN.md)

> [!note]
> AI-generated artifacts. May include low-quality code.

A [Pi](https://github.com/earendil-works/pi) extension and a library for other
extensions: it holds session-scoped persistent state in one SQLite file.

## Features

- Session scope and branch scope
- A value can be any JSON; its structure is the integrator's to define
- One writer per session at a time, while reads proceed in parallel
- A crash-left lock ages out on its own, so a session is never sealed

## For integrators

```ts
import { openSessionState } from "pi-session-state";

const state = openSessionState<Identity>({ pluginId: "role" });
```

The contract, the scopes, and the boundaries are in the [API](docs/api.md).

## For users

The package registers two commands for inspection and reset:

| Command | What it does |
| --- | --- |
| `/state:status` | who holds this session's lock row and whether that pid is alive (`unknown` when it cannot be told); how many state rows this session has, per extension |
| `/state:force-refresh` | clear this session's lock row and drop this process's cache, then read from disk |

The database defaults to `{agent_dir}/sessions/states.sqlite` and can be
replaced from `settings.json` — see [Storage](docs/api.md#storage).

## Docs

- [API](docs/api.md)
- [Architecture](docs/architecture.md)

## Install

```bash
pi install npm:pi-session-state
```

Or clone it into Pi's user extension path (e.g. `~/.pi/agent/extensions`):

```bash
git clone https://github.com/EyKettle/pi-session-state.git ~/.pi/agent/extensions/session-state
cd ~/.pi/agent/extensions/session-state
pnpm install
```

Pi loads the package through its `pi.extensions` entry. Reload Pi after
installing.

Developed against Pi 1.1.0.

## Develop

```bash
pnpm install
pnpm test
pnpm run typecheck
```
