# 架构

[English](../docs/architecture.md) | 中文

- [接口](api.md)

## 依据

存储状态由消费者的实际访问形态决定。

| 事实 | 来源 |
| --- | --- |
| 写入由显式动作触发，一次动作一次写入 | `import_skill`、`cancel_skill`、身份切换 |
| 读取在每个请求上发生 | tail 段装配、system prompt 装配 |
| 一个作用域只持有一个值，无历史 | 身份、已加载技能列表 |
| 值的字段结构属于消费者，且随更新变化 | 两个消费者的字段全异 |
| Pi 不提供可写状态槽 | `ReadonlySessionManager` 全是 getter |
| 存储是全部会话共用的一个文件 | 默认 `{agent_dir}/sessions/states.sqlite` |

> [!note]
> 需要历史回溯的场景使用 Pi 原生的 Entry。
> session-state 只负责不需要回溯的状态。

## 分层

| 层 | 认识 | 不认识 |
| --- | --- | --- |
| 接口层 | 作用域声明、读写删除、参数校验 | 会话树、SQL |
| 键层 | 由 `ctx` 推出三元组 | SQL、Pi 的其余部分 |
| 存储层 | SQLite 读写、进程内缓存 | Pi |

## 键

主键由 `pluginId`、`sessionId`、`branchId` 组成。

| `scope` | `sessionId` | `branchId` |
| --- | --- | --- |
| `"session"` | `getSessionId()` | `""` |
| `"branch"` | `getSessionId()` | `branchKey(ctx)` |

## 分支判定

```text
键(叶)：
  node = 叶
  循环：
    parent = node 的父节点
    parent 不存在       → 返回 node
    parent 的孩子数 ≠ 1  → 返回 node
    node = parent
```

| 性质 | 后果 |
| --- | --- |
| 沿分支追加只延长单孩子链 | 键不变，写入恒落在同一行 |
| 键恒为某个单孩子段的顶 | 不产生不对应任何分支的键 |
| 在叶上方新造分叉会移动该叶的键 | 读必须上溯，不能只查一次 |

读按段上溯：先查本段键，未命中则查其父段的键，直到根，取第一个命中。

写只写本段键，不上溯、不写父段。

## 存储

两张表。

```sql
CREATE TABLE IF NOT EXISTS state (
  plugin_id  TEXT NOT NULL,
  session_id TEXT NOT NULL,
  branch_id  TEXT NOT NULL,   -- '' 为会话级
  value      TEXT NOT NULL,   -- JSON
  PRIMARY KEY (plugin_id, session_id, branch_id)
);

CREATE TABLE IF NOT EXISTS write_lock (
  session_id TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  acquired_at INTEGER NOT NULL  -- 取得时刻，毫秒
);
```

开启 WAL。跨会话争用在 SQLite 层等待（`busy_timeout`）。

### 会话锁

`write` 与 `drop` 各持一次会话锁，粒度是 `write_lock` 中的一行。

| 步骤 | 行为 |
| --- | --- |
| 取得 | 插入本进程的 holder 与当前时刻；已被占用时读出持有者 |
| 接管 | 持有者是本进程、它已不存在、或行龄超过租约：改写成自己 |
| 拒绝 | 其余情形抛错，错带四个要素 |
| 释放 | `finally` 中按 holder 删行 |

`holder` 记 `pid:<pid>`，`acquired_at` 记取得时刻。持有者是否已消失由 pid
是否存活判断；一条崩溃留下的行，若其 pid 后来归了别的活进程，由行龄兜底。

租约须高于一次持有的最坏时长——取得、操作、释放三步各自可能等 SQLite 至多
`busy_timeout`，所以是 60s。

跨分叉物化与无键值落盘这两类读路径上的写不持锁，所以读可以同时进行。

| 路径 | 行为 |
| --- | --- |
| 读 | 作用域首次载入后不再访问磁盘 |
| 写 | 持会话锁；同步落盘，返回即可见 |
| 分支作用域的读 | 跨分叉上溯，命中即物化到本段键 |
| 键尚未产生时的写 | 值只留在内存；取得键之后落盘 |

## 失败

存储故障与缺席分离：故障抛错，缺席是 `undefined`。

构造期的校验（`pluginId`、`scope`、`databasePath`）针对接入参数：不合法即抛，
不降级为共用命名空间或内存存储。

## 模块

| 模块 | 职责 |
| --- | --- |
| `index.ts` | 公共导出与装配 |
| `branch.ts` | 分支判定：叶 → 键。纯函数，可脱离 Pi 测试 |
| `store.ts` | 键 → 行：SQLite 读写、进程内缓存、上溯解析 |
| `settings.ts` | 读取 `settings.json` 的位置配置并归一为绝对路径。纯函数，可脱离 Pi 测试 |

## 不变量

- 一个三元组只有一行。
- 同一分支上的多次写入只产生一个值，不累积。
- 分支作用域的读跨分叉上溯，回退到旧分支时旧值自动回来。
- 缺席是 `undefined`，任何故障都不表现为 `undefined`。
- 存储不解释值的字段。
- 锁行不会长期封住一个会话：崩溃留下的行在租约期后被接管。
