# 接口

[English](../docs/api.md) | 中文

- [架构](architecture.md)

## 接入

```ts
import { openSessionState } from "session-state";

const state = openSessionState<Identity>({ pluginId: "role" });
```

| 参数 | 必填 | 含义 |
| --- | --- | --- |
| `pluginId` | 是 | 扩展的标识，也是存储行的命名空间 |
| `scope` | 否 | 状态跟随会话还是分支，见[作用域](#作用域) |
| `databasePath` | 否 | 数据库文件的绝对路径，见[存储](#存储) |

三个参数都在构造期校验，不合法即抛错。`pluginId` 非空，
只含小写字母、数字、连字符与点。

## 作用域

作用域在声明时确定，调用期不可切换。

| `scope` | 键 | 何时用 |
| --- | --- | --- |
| `"session"`（默认） | 插件 + 会话 | 状态跟随整个会话 |
| `"branch"` | 插件 + 会话 + 分支 | 状态跟随分支 |

需要两种粒度的插件开两个实例：同 `pluginId`，不同 `scope`。

## 接口

| 方法 | 语义 |
| --- | --- |
| `read(ctx)` | 该作用域的值；从未写过时为 `undefined`。 |
| `write(ctx, value)` | 写入该作用域；返回时已落盘。 |
| `drop(ctx)` | 删除该作用域的值。 |

```ts
interface SessionState<T> {
  read(ctx: ExtensionContext): T | undefined;
  write(ctx: ExtensionContext, value: T): void;
  drop(ctx: ExtensionContext): void;
}
```

## 值

值是调用方私有的 JSON。存储不校验其字段、不解释其内容，
字段的增删由调用方自理。

- 缺省是 `undefined`；写入的 `null` 是合法值，二者可区分。
- 写入 `undefined` 抛错。
- 值必须可 JSON 序列化；不可序列化即抛错。

## 分支

`scope: "branch"` 时，键的第三段由存储从会话树推出。
判定方式见[分支判定](architecture.md#分支判定)。

`branchKey(ctx)` 以同一规则提供纯查询，供调用方读取当前分支 ID。
分支 ID 提取方式由 session-state 维护，确保 ID 稳定性。

状态按分支区分：分支继承其分叉处的状态；
回退到分支中段读到的是该分支的当前值。

键尚未产生时（空会话）：写入只留在内存，对同会话的读可见；
上下文取得键之后落到物理存储，在此之前进程结束则丢失。
与 Pi 自身的会话记录行为一致——第一条 assistant 消息结束前，本地没有记录。

## 存储

默认 `{agent_dir}/sessions/states.sqlite`。位置有三个来源，先命中者生效：

| 顺序 | 来源 | 谁定 |
| --- | --- | --- |
| 1 | `openSessionState` 的 `databasePath` 参数 | 接入方 |
| 2 | `{agent_dir}/settings.json` 的 `sessionState.databasePath` | 使用者 |
| 3 | 默认位置 | — |

项目级 `settings.json` 不参与——那里的取值由仓库给出，
不该决定使用者的状态写在哪。配置在构造期读入，改动在下次载入生效。

接入参数取非空的绝对路径；不是即抛错。

配置取三种写法，都归一为绝对路径后使用：

| 写法 | 归到 |
| --- | --- |
| 绝对路径 | 原样 |
| `~` 开头 | 使用者的家目录 |
| 相对路径 | `{agent_dir}` 之下 |

配置不是非空字符串时退回默认位置，并在会话开始时经 Pi 的 UI 报告一次。

## 边界

- 同一会话的并发写被拒绝：另一进程正在写同一会话时，`write`/`drop` 抛错。
  错中带发起人、动作、对象与原因，并经 Pi 的 UI 通知呈现；读照常进行。
  机制见[存储](architecture.md#存储)。
- 单进程缓存：本进程写入后即可读到；别的进程的写入不刷新本进程的缓存。
- 跨插件不可见：实例只读写自己 `pluginId` 的行。
- 不做清理：Pi 没有会话删除钩子，删掉会话文件不会删掉行。
- 换位置即换库：旧文件不迁移，新位置从空开始。

## 命令

包内注册两条命令，供排查与复位。

| 命令 | 做什么 |
| --- | --- |
| `/state:status` | 本会话的锁行归谁、那个 pid 是否还活着；本会话有几行状态、分属哪些插件 |
| `/state:force-refresh` | 清掉本会话的锁行并丢弃本进程的缓存，随后从磁盘重读 |

可解的情形：

- 崩溃留下的锁行把会话封住——清掉它，写恢复。
- 另一进程写过、本进程缓存陈旧——刷掉缓存，从磁盘重读。
- 不清楚状态从哪来——先看锁行与行数，再决定。

`force-refresh` 只动锁行与缓存，不碰状态行；持有者的 pid 还活着时先确认。

命令用不上时（例如 Pi 没在跑），锁行直接删（路径取默认位置）：

```bash
sqlite3 {agent_dir}/sessions/states.sqlite \
  "DELETE FROM write_lock WHERE session_id = '<session id>';"
```
