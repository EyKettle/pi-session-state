# session-state 插件

[![npm](https://img.shields.io/npm/v/pi-session-state)](https://www.npmjs.com/package/pi-session-state) [![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-%23FE5196?logo=conventionalcommits&logoColor=white)](https://conventionalcommits.org) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[English](README.md) | 中文

> [!note]
> AI 生成产物，可能包含低质量代码。

为 [Pi](https://github.com/earendil-works/pi) 扩展提供会话级持久状态的库，
本身也是一个 Pi 扩展。状态存于一个 SQLite 文件。

## 功能

- 会话级与分支级两种作用域
- 值可以是任意 JSON，结构由接入方自理
- 同一会话同一时刻只有一个写入方，读可同时进行
- 崩溃留下的锁会自行过期，会话不会被锁死

## 给接入方

```ts
import { openSessionState } from "pi-session-state";

const state = openSessionState<Identity>({ pluginId: "role" });
```

契约、作用域与边界见[接口](docs_zh-CN/api.md)。

## 给使用者

包内注册两条命令，供排查与复位：

| 命令 | 作用 |
| --- | --- |
| `/state:status` | 本会话的锁行归谁、那个 pid 是否还活着（无法判定时答 unknown）；本会话有几行状态、分属哪些插件 |
| `/state:force-refresh` | 清掉本会话的锁行并丢弃本进程的缓存，随后从磁盘重读 |

数据库位置默认为 `{agent_dir}/sessions/states.sqlite`，
可在 `settings.json` 里替换，见[存储](docs_zh-CN/api.md#存储)。

## 文档

- [接口](docs_zh-CN/api.md)
- [架构](docs_zh-CN/architecture.md)

## 安装

```bash
pi install npm:pi-session-state
```

也可以克隆到 Pi 的用户扩展路径 (如 `~/.pi/agent/extensions`)：

```bash
git clone https://github.com/EyKettle/pi-session-state.git ~/.pi/agent/extensions/session-state
cd ~/.pi/agent/extensions/session-state
pnpm install
```

Pi 按 `package.json` 的 `pi.extensions` 载入本包，安装后重启 Pi 即可。

开发基线为 Pi 1.1.0。

## 开发

```bash
pnpm install
pnpm test
pnpm run typecheck
```
