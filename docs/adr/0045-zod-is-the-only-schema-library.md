# 0045. Zod is the only schema library

- Status: Accepted
- Date: 2026-09-19
- Owners: TypeScript workspace

## Context

仓库里同时装着两套 schema 库：`@poietica/transcript` 用 zod 钉线上帧形状，而
agent-catalog、extension、workspace 与桌面外壳用 valibot 解磁盘配置。两套库的
`looseObject`/`fallback`/`union` 语义并不等价，同一个「读坏了就用默认值」的意图在两处
写成两种东西，审阅时无法互推。

两套库都必须留在 catalog 里、都必须进 lockfile，而每加一处解码就要先决定用哪一套 ——
这个决定没有判据，只有习惯。

## Decision

TypeScript 侧的 schema 一律用 zod（`catalog` 里的 `zod`，当前 4.x）。valibot 从
catalog、四份 package.json 与 lockfile 中移除，不留兼容层。

移植时必须保住的既有语义，逐条记录理由：

1. **`v.fallback(schema, 值)` → `schema.catch(值)`**。两者都同时兜住「类型不对」与
   「`transform` 抛错」，这是偏好落盘那条路径依赖的性质：坏值回落到默认值，而不是让
   界面打不开。
2. **`v.pipe(v.number(), v.finite())` 不需要移植**。zod 的 `z.number()` 本身就拒收
   `NaN` 与 `±Infinity`（valibot 的 `v.number()` 收 `Infinity`，所以那边才要 `finite`）。
   照抄 `finite()` 是给一条已经成立的判据再加一道，删掉。
3. **`v.pipe(v.unknown(), IsObject, v.looseObject({...}))` 里的 `IsObject` 不需要移植**。
   zod 的 `looseObject` 自己就不收数组与原始值，那道前置 `check` 在 valibot 里也是冗余的。
   `mcp-config.ts` 里 `checkedDocument` 的第二道逐条 `ServerEntry` 复查同理 ——
   `z.record(z.string(), ServerEntry)` 已经把每条都验过了。
4. **`v.record(键schema, 值schema)` → `z.record(键schema, 值schema)`**。两边都真的拿键
   schema 去校验键（`env` 的 `ENV_NAME_PATTERN`、`defaultConfigOptions` 的 `text` 长度），
   移植后仍然如此。
5. **校验不承担序列化**。`checkedDocument` 交回原始输入而不是解析结果：zod 的对象解析会
   丢掉 `__proto__` 这类自有键，而 mcp.json 写回磁盘时必须原样保留它们
   （`mcp-management.test.ts` 的 `uses own keys rather than inherited object properties`）。
6. **`v.integer()` → `z.int()`**，`v.minValue/maxValue` → `.min()/.max()`，
   `v.picklist` → `z.enum`，`v.literal` → `z.literal`，`v.custom<T>` → `z.custom<T>`。

## Consequences

- 全仓只有一套 schema 词汇，解码处的写法可以直接互相参照。
- 上面的第 2、3 条是「移植时顺手删掉的死代码」，不是行为变化：删掉的判据在 zod 里由
  类型本身保证。若日后换掉 zod，这几条要重新审。
- 帧形状（`packages/transcript`）与配置解码从此共用同一份依赖版本，catalog 少一项。
- 迁移后 `bun run check:web` 的 36 个任务全绿；mcp.json 的 `__proto__` 写回用例是这次
  移植的行为锚点。
