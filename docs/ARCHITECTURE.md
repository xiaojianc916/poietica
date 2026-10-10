# Poietica 架构

> 本文是**现状**文档（15 页 §11.1）：只写「现在是什么」，不写重构历史。
> 重构过程中的偏差与待决问题在 `docs/refactor-log.md`。

## 1. 一句话

Poietica 是「三个进程 × 三个微内核 × 20 个平台包 + 15 个功能包」的 Windows 桌面 agent 应用：
omp（Oh My Pi）经引擎端口接入，随包发布，与用户机器上的全局 omp 完全隔离。

```
                 ┌────────────── 功能包 features/<x>（垂直切片，一个功能一个包）───────────────┐
                 │  contract ── 三个进程共享的 zod 契约（方法、通知、错误码）                  │
                 │  ui       ── 插进 UI 内核：界面、命令、面板、设置页……                       │
                 │  host     ── 插进 Host 内核：系统能力（终端、对话框、更新……）              │
                 │  core     ── 插进 Core 内核：业务逻辑、数据表、agent 工具                   │
                 └────────────────────────────────────────────────────────────────────────────┘
                          ▲ 插入                 ▲ 插入                      ▲ 插入
┌─────────── UI 进程 ───────────┐ ┌────────── Host 进程 ──────────┐ ┌────────── Core 进程 ──────────┐
│ ui-kernel（贡献点、服务）     │ │ host-kernel（模块、RpcHub）    │ │ core-kernel（模块、迁移、服务）│
│ workbench（外壳，只渲染贡献） │◄┤ CoreSupervisor（看护 Core）   ├►│ engine 端口 ◄── engine-omp 适配 │
│ design-system                 │ │ Electron                      │ │ omp SDK（随包、隔离）           │
└───────────────────────────────┘ └───────────────────────────────┘ └────────────────────────────────┘
        IPC 'poietica:rpc'（JSON-RPC 2.0）          stdio（\x1e 帧，JSON-RPC 2.0）
```

## 2. 五条结构性承诺

1. **一个功能只在一个地方**：新增或删除一个功能 = 增删 `features/<x>/` 一个目录，再在应用清单里增删各一行。
2. **外壳不认识功能**：workbench 与三个内核里不出现任何具体功能的名字，只渲染与调度「贡献」。
3. **业务不认识 omp**：除 `packages/engine-omp/**` 外，全仓任何地方都不 import `@oh-my-pi/*`。
4. **运行时由类型系统把关**：每个包、每个子入口按运行时继承 tsconfig 预设；在 UI 代码里写 `import fs from 'node:fs'`，类型检查直接失败。
5. **每份事实只存一处**：对话内容只在 omp 会话文件里；其余数据各有唯一主人（§6）。

## 3. 分层与依赖规则

```
L5  汇总与外壳   protocol · workbench · apps/core · apps/desktop
L4  功能         features/*（15 个垂直功能包）
L3  内核与适配   core-kernel · host-kernel · ui-kernel · design-system · engine-omp · engine-testkit
L2  运行时工具   runtime-layout · process-kit · fs-kit · logging · storage-sqlite · git · test-kit
L1  契约与模型   contract-kit · rpc · transcript · engine
L0  基础         foundation
```

只能依赖**更低层**的包；同层之间禁止依赖（功能之间的有限例外见 §4.3）。L5 内部只有 `apps/*`
可以依赖 `protocol` 与 `workbench`，这两个包互不依赖。`protocol` 汇总全部功能的 `contract`；
**功能包绝不依赖 `protocol`**，因此不存在「功能 → 汇总 → 功能」的环。

三层强制（缺一层都能被绕过）：

| 层 | 机制 | 位置 |
| --- | --- | --- |
| 1 | bun 的 isolated linker：每个包只能看见自己声明的依赖 | `bunfig.toml` |
| 2 | tsconfig 运行时预设 + 项目引用：类型层面就看不见不该看的 | `tooling/tsconfig/*`、`bun run refs` |
| 3 | dependency-cruiser：跨包/跨子入口的边逐个检查 | `tooling/depcruise/config.cjs` |

功能子入口的允许依赖（03 页 §5.2）：

| 子入口 | 运行时 | 可以 import |
| --- | --- | --- |
| `contract` | neutral | `contract-kit`、`foundation`、`transcript`（仅 conversation）、zod、**其它功能的 `contract`** |
| `core-api` | neutral | 本功能 `contract`、`foundation`、`engine`（类型）、`@poietica/core-kernel/events` |
| `core` | bun | 本功能 `contract` / `core-api`、L0–L3 的 bun/node/neutral 包、**依赖功能的 `contract` / `core-api`** |
| `host` | electron-main | 本功能 `contract`、`host-kernel`、L0–L2 的 node/neutral 包、electron、**依赖功能的 `contract`** |
| `ui-api` | dom | 本功能 `contract`、`ui-kernel`、`design-system`、react |
| `ui` | dom | 本功能 `contract` / `ui-api`、`ui-kernel`、`design-system`、react、zustand、**依赖功能的 `contract` / `ui-api`** |

任何子入口都不得 import 其它功能的 `core` / `host` / `ui`。

## 4. 三个进程与三个微内核

### 4.1 Core（`poietica-core.exe`，Bun）

`apps/core/src/main.ts` 按参数分派三种模式：`serve`（默认）、`omp-worker`、`browser-relay`。
`serve` 的顺序是：隔离自检 → 环境清洗 → 打开数据库 → 创建引擎 → `createCoreKernel(modules)` → `start()`。

`core-kernel` 提供：模块定义（`defineCoreModule`）、按 `dependsOn` 拓扑装配、服务令牌注册表、
进程内事件总线（`ctx.events`）、agent 工具注册（`ctx.agentTools`）、迁移、RPC 绑定、生命周期。
启动时逐项验收：所有 `owner='core'` 的方法都有实现、模块依赖无环、每个功能只建自己前缀的表。

### 4.2 Host（Electron 主进程）

`host-kernel` 提供：模块定义（`defineHostModule`）、RpcHub（按契约 owner 路由 UI 的请求）、
CoreSupervisor（启动/重启/关闭 Core，含退避与 crash loop 判定）、IPC 传输、窗口注册表、
`poietica-asset://` 协议、退出协调、日志落盘。

### 4.3 UI（Electron 渲染进程）

`ui-kernel` 提供：功能定义（`defineUiFeature`）、贡献点（`defineContributionPoint`）、内核服务
（导航、命令、快捷键、Core 状态、布局、通知、对话框、日志、错误面）、React 绑定、
`createFeatureStore`（zustand）与 `FeatureErrorBoundary`。

`workbench` 是外壳：布局、侧栏、标题栏、命令面板、面板坞、设置框架。**它只渲染贡献点**，
不认识任何具体功能。

功能之间只有三种合法协作方式：

| 方式 | 说明 | 例子 |
| --- | --- | --- |
| 服务令牌 | 同进程同步调用 | `automations/core` 经 `ConversationServiceToken` 发起对话 |
| 进程内事件 | 发布/订阅 | `conversation/core` 发 `usageSampled`，`usage/core` 订阅后落库 |
| 贡献点 | UI 扩展 | `browser/ui` 往 conversation 的 `toolCallRenderers` 贡献卡片 |

## 5. 契约与协议

每个功能在自己的 `contract` 子入口用 zod 定义方法与通知；`@poietica/protocol` 只做汇总、
查重、版本与快照。

- **方法名**：`<命名空间>.<动作>`，例如 `threads.create`。
- **owner**：`core` 或 `host`，决定 RpcHub 把请求发给谁。
- **通知名**：与命名空间同规则，例如 `timeline.ops`。
- **错误码**：`<契约 id>.<snake_case>`，由功能自己的 `defineErrors` 定义；系统级错误码是 `kernel.*`。
- **协议版本**：`packages/protocol/src/version.ts` 的 `PROTOCOL_VERSION`。**任何契约形状变化都要提升它**
  并跑 `bun run protocol:snapshot`。它只用来发现「安装损坏」或「忘了重建 Core」——
  Host 与 Core 总是一起发布。

`composeContracts` 在启动时校验：命名空间全局唯一、方法与通知名全局唯一、名字以本契约的命名空间开头、
错误码前缀等于契约 id。任意一项不过就直接抛错（快照测试同样失败）。

## 6. 引擎端口与 omp 隔离

业务只认识 `@poietica/engine` 的接口；`@poietica/engine-omp` 是唯一实现，也是全仓唯一
import `@oh-my-pi/*` 的地方（`apps/core/scripts` 的构建脚本是唯一例外）。

隔离的三条硬要求：

1. omp 的全部数据落在 `%APPDATA%\Poietica\omp\`（`DataLayout` 的 `ompRoot`）。
2. 启动时自检（T-ISO-1…5）：不达标直接拒绝启动。
3. 全局 `~/.omp`、`.env` 与其它工具的凭据变量一律屏蔽（`launchEnv` 的清洗）。

omp 锁在 `18.5.0`（根 `package.json` 的 catalog）。升级前必须逐项核对 16 页 §5 的陷阱表，
并在 `docs/refactor-log.md` 记录核对结果。

## 7. 数据与存储

 | 数据 | 唯一主人 | 落点 |
| --- | --- | --- |
| 对话内容 | omp | `omp/agent/sessions/*.jsonl` |
| 线程/工作区/附件/自动化/用量的元数据 | 各功能的 core | `core/poietica.db`（SQLite） |
| 附件内容 | attachments | `attachments/<sha 前两位>/<sha>` |
| 用户偏好 / 布局记忆 / 快捷键 | preferences | `preferences.json` / `ui-state.json` / `keymap.json` |
| 窗口位置 | platform | `window-state.json` |
| 内置 Python | python | `tools/python/` |
| 内置浏览器 | browser | `session/Partitions/persist:poietica-browser` |
| 日志 | Host / Core | `logs/main.log` / `logs/core.log` |

规则：数据路径只来自 `DataLayout`；SQL 只写在功能的 `core/repository.ts`，表名以功能 id
（`-` 换 `_`）为前缀，内核启动时校验。JSON 文件统一走 `@poietica/fs-kit` 的
`createJsonDocument`（坏文件改名保留，不静默吞掉）。

## 8. 测试策略

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 单元 | `packages/*/src/**/__tests__`、`features/*/src/**/__tests__` | 纯函数与不依赖内核的类 |
| 内核级 | 同上，`@poietica/core-kernel/testing` 的 `createCoreHarness` | 只装被测模块及其依赖的真实内核 + FakeEngine |
| 一致性 | `@poietica/engine-testkit` | 同一套用例分别跑 FakeEngine 与 OmpEngine，保证替身可信 |
| 隔离 | `packages/engine-omp/src/__tests__/isolation.test.ts` + `bun run core:probe` | 进程级自检与假用户目录零写入 |
| 端到端 | `bun run dev`（真机） | 界面流程；发布前另有安装包冒烟（`bun run desktop:smoke`） |

`bun run  all` = `typecheck` + `lint` + `test`，是唯一的准入闸门（CI 跑的就是它）。

## 9. 扩展配方

**加一个平台包**：`bun run new:package <name> --runtime <preset>` → 在 `tooling/depcruise/layers.json`
登记层级 → `bun run refs` → `bun run  all`。

**加一个功能**（九个步骤）：

1. `bun run new:feature <id> --parts contract,core,host,ui,...`（生成标准骨架与 tsconfig）。
2. 在 `contract/entities.ts` 与 `contract/index.ts` 写 zod 实体、方法与通知，错误码走 `defineErrors`。
3. 在 `packages/protocol/src/index.ts` 把新契约加进 `composeContracts`，提升 `PROTOCOL_VERSION`。
4. 实现 `core`（或 `host`）：服务 + `repository.ts`（唯一写 SQL 的地方）+ `migrations.ts` + `handlers.ts`。
5. 实现 `ui`：`api.ts` 薄封装 RPC、store、组件、贡献点。
6. 在三个清单里各加一行：`apps/core/src/modules.ts`、`apps/desktop/src/main/modules.ts`、
   `apps/desktop/src/renderer/features.ts`。
7. 写测试（必测项见 07 页对应小节的 §xG）。
8. `bun run refs` → `bun run protocol:snapshot` → `bun run  all`。
9. 在 `docs/refactor-log.md` 记录偏差或待决问题（如果有）。

**升级 omp**：改根 `package.json` catalog 的四个 `@oh-my-pi/*` 版本 → 按 16 页 §5 的陷阱表逐项核对
（会话文件、设置键、工具名、事件形状、浏览器 relay 协议……）→ 记录到 `docs/refactor-log.md` →
`bun run core:build` + `core:probe` + `bun run  all`。

**发布**：`bun run version:set <x.y.z>`（唯一入口，同时改 desktop 与 core）→ 提交 →
`git tag v<x.y.z>` → 推送 tag → release 工作流构建、冒烟、创建草稿 → 人工在干净虚拟机上验收 →
把草稿改为正式发布。
