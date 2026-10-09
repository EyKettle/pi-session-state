# 接口

[English](../docs/api.md) | 中文

- [架构](architecture.md)

## 接入

```ts
import { openSessionState } from "session-state";

const state = openSessionState<Identity>({ pluginId: "role" });
```

`pluginId` 是扩展的标识，也是存储行的命名空间。在构造期校验：非空，
只含小写字母、数字、连字符与点。不合法即抛错。

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

## 存储

默认 `{agent_dir}/sessions/states.sqlite`。
[`databasePath`](configuration.md#数据位置) 可覆盖，供测试隔离。

## 边界

- 单进程缓存：同一会话被两个进程打开时，SQLite 串行化写入，
  但另一进程的缓存可能陈旧。
- 跨插件不可见：实例只读写自己 `pluginId` 的行。
- 不做清理：Pi 没有会话删除钩子，删掉会话文件不会删掉行。
