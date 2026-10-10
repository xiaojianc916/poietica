# AGENTS.md — Poietica 工作守则
​
给 AI 与人类贡献者。先读这一页，细节以 `docs/ARCHITECTURE.md` 为准；两者冲突时以代码与 `bun run  all` 为准，并把冲突记进 `docs/refactor-log.md`。
​
## 1. 项目速览
​
- Windows 本地 AI agent 桌面应用（AGPL-3.0）。三个进程：**UI**（Electron 渲染进程，React）↔ **Host**（Electron 主进程）↔ **Core**（`poietica-core.exe`，Bun 编译）。
- UI↔Host 走 IPC `poietica:rpc`，Host↔Core 走 stdio（`\x1e` 分帧），两段都是 JSON-RPC 2.0。Host 的 `CoreSupervisor` 负责看护 Core：Core 会崩溃、会重启，UI 必须能重新同步。
- 每个进程一个微内核（`core-kernel` / `host-kernel` / `ui-kernel`），功能以模块或贡献的形式插进去。外壳（`workbench`）只渲染贡献点，不认识任何具体功能。
- agent 引擎是 omp（Oh My Pi，`@oh-my-pi/*` 锁在 `18.5.0`），只经 `@poietica/engine` 端口接入，唯一实现是 `packages/engine-omp`。omp 随包发布，数据落在 `%APPDATA%\Poietica\omp\`，与用户机器上的全局 omp 完全隔离。
​
必读文档：
​
| 文档 | 用途 |
| --- | --- |
| `docs/ARCHITECTURE.md` | 现状架构：分层、进程、契约、数据归属、测试策略、扩展配方 |
| `docs/refactor-log.md` | 进度、**偏差**（与方案不一致之处及原因）、**待决问题** |
| `docs/omp-sdk-reference.md` | omp 18.5.0 的精确 API（带源码行号）。写 engine-omp 之前先查这里，不要凭记忆 |
| `docs/release-notes/` | 每个版本的发布说明 |
​
## 2. 环境与命令
​
需要 Bun 1.4.3+（`packageManager` 锁 `bun@1.4.3`，`bun check` 做类型检查）和 Node 20+。CI 跑在 `windows-latest`。
​
| 命令 | 作用 |
| --- | --- |
| `bun install` | 安装依赖（isolated linker，不 hoist） |
| `bun run dev` | 构建 Core 后启动桌面端 |
| `bun run  all` | **唯一的准入闸门**：typecheck + lint（biome、自定义闸门、depcruise）+ test |
| `bun test <路径>` | 只跑某一部分测试 |
| `bun run format` | biome 自动格式化 |
| `bun run refs` | 重新生成 tsconfig 项目引用（禁止手改 references） |
| `bun run protocol:snapshot` | 契约形状变化后更新协议快照 |
| `bun run core:build` / `core:probe` / `core:verify-dist` | 构建 Core、进程级隔离自检、校验产物 |
| `bun run new:package` / `new:feature` | 脚手架（创建包或功能的唯一入口） |
| `bun run version:set <x.y.z>` | 同时改 desktop 与 core 的版本号（唯一入口） |
| `bun run desktop:smoke <安装包>` / `dist` | 安装包冒烟 / 打包安装程序 |
| `bun run python:pin` | 升级内置 Python 时钉住校验和 |
​
## 3. 仓库地图与分层
​
```
L5  protocol · workbench · apps/core · apps/desktop      汇总与外壳
L4  features/*（15 个功能，垂直切片）                    功能
L3  core-kernel · host-kernel · ui-kernel · design-system · engine-omp · engine-testkit
L2  runtime-layout · process-kit · fs-kit · logging · storage-sqlite · git · test-kit
L1  contract-kit · rpc · transcript · engine
L0  foundation
```
​
- 只能依赖**更低层**，同层互不依赖。层级登记在 `tooling/depcruise/layers.json`。
- 功能包 `features/<id>/src/` 的子入口：`contract`（zod 契约，三进程共享）、`core-api` / `ui-api`（给别的功能用的接口）、`core`（Bun）、`host`（Electron 主进程）、`ui`（DOM）。包名是 `@poietica/feature-<id>`，子入口用 `exports` 暴露。
- `apps/*` 只做组装：三个清单 `apps/core/src/modules.ts`、`apps/desktop/src/main/modules.ts`、`apps/desktop/src/renderer/features.ts`。
- `tooling/`：tsconfig 预设（`base/bun/node/dom/electron-main/neutral`）、depcruise 规则、refs 同步、脚手架、发布脚本、自定义闸门（`tooling/checks/`）。`scripts/`：一次性维护脚本。
​
## 4. 边界铁律（全部有闸门，违反就是 check 红）
​
1. **只有 `packages/engine-omp` 能 import `@oh-my-pi/*`**（`apps/core/scripts` 的构建脚本除外）；也只有 `apps/core` 能依赖 `engine-omp`。业务只认 `@poietica/engine` 的接口。
2. **功能之间只经 `contract` / `core-api` / `ui-api` 协作**，绝不 import 别的功能的 `core` / `host` / `ui`。同进程内只有三种合法协作方式：服务令牌、进程内事件（`ctx.events`）、UI 贡献点。
3. **子入口的运行时纯度**：`ui` 不碰 electron、node-pty 和 Node core 模块；`core` 不碰 react、electron、zustand；`host` 不碰 react、zustand、`bun:`；`contract` / `core-api` 只依赖 contract-kit、foundation、transcript、engine、zod 和功能 contract。
4. **平台包和内核不认识功能**（`protocol` 例外，且只能 import 功能的 contract）；功能包不依赖 workbench、protocol、apps。
5. **只能 import 本包 `package.json` 声明过的依赖**。第三方版本只写在根 `package.json` 的 `catalog`，子包写 `"catalog:"`；改了依赖要跑 `bun install`。
6. 无循环依赖。
​
## 5. 架构约定
​
### 5.1 代码放在哪
​
| 要做的事 | 放在 |
| --- | --- |
| 业务逻辑、数据表、调用引擎 | `features/<id>/src/core`（Core 进程） |
| 系统能力：窗口、对话框、pty、自动更新、shell、资源协议 | `features/<id>/src/host`（Host 进程） |
| 界面、命令、设置页、前端状态 | `features/<id>/src/ui`（UI 进程） |
| 跨进程的方法、通知、错误码、实体 | `features/<id>/src/contract` |
| 给别的功能在同进程内调用的服务和事件 | `core-api`（Core 侧）/ `ui-api`（UI 侧） |
| 和 omp 打交道 | 先在 `packages/engine` 加端口，再在 `packages/engine-omp` 实现（见 5.5） |
| 与具体功能无关、多处复用的能力 | 平台包，按层级放 |
| 把功能装进应用 | `apps/*` 的三个清单，每个功能只加一行 |
​
拿不准放哪时，先问「它属于哪个功能」，再问「它必须在哪个进程跑」。答不上来的，就是待决问题。
​
### 5.2 三个内核的模块写法
​
三个内核的形状相同：`id`（等于功能 id）+ 可选的 `contract` 和 `dependsOn` + `setup(ctx)`。`dependsOn` 不许成环，内核按拓扑顺序装配。
​
- **Core**：`defineCoreModule({ id, contract, dependsOn, migrations, setup })`。`ctx` 提供 `logger`、`clock`、`layout`、`db`、`engine`、`rpc`（`handle` 注册方法，`emit` 发通知）、`host`（调用 `owner='host'` 的方法）、`services`、`events`、`agentTools`、`lifecycle.onReady/onShutdown` 和 `disposables`。
- **Host**：`defineHostModule({ id, contract, dependsOn, setup })`。`ctx` 提供 `rpc`、`core`（`call` / `on` / `status` / `onStatus`，Core 未就绪时请求最多排队 30 秒）、`windows`、`assets`（注册 `poietica-asset://<host>/…`）、`app.quit`、`lifecycle` 和 `disposables`。
- **UI**：`defineUiFeature({ id, dependsOn, setup })`。`ctx` 提供 `rpc(contract)`（只能用本功能或 `dependsOn` 里功能的契约）、`contribute(point, item)`、`services`、`lifecycle.onCoreReady/onDispose`。
​
写 `setup` 的规矩：
​
1. `setup` 里只做装配：注册 handler、`provide` 服务、订阅事件、贡献界面。耗时的初始化放 `onReady`（Core / Host），或者 `onCoreReady`（UI）。
2. 每个订阅、定时器、子进程都要有归宿：挂到 `ctx.disposables`，或者在 `onShutdown` / `onDispose` 里释放。
3. Core 的 `migrations` 只能建本功能前缀的表和索引。`version` 按模块从 1 开始连续递增，只加不改：已发布的迁移不许修改，要变更就追加一条新的。
4. UI 的 `onCoreReady` 在**每次** Core 进入 ready 时都会调用（首次启动、崩溃重启、手动重启）。从 Core 来的数据都要在这里重新拉取、重新订阅，不要只加载一次。
​
### 5.3 功能之间怎么协作
​
| 方式 | 由谁定义、在哪里 | 使用方要做什么 |
| --- | --- | --- |
| 服务令牌（同进程同步调用） | 提供方在 `core-api` / `ui-api` 里 `defineServiceToken<T>('<id>', 'Name')`，在 `setup` 里 `services.provide` | `dependsOn` 声明提供方，否则 `services.get` 直接抛错 |
| 进程内事件（发布 / 订阅） | 提供方在 `core-api` 里 `defineCoreEvent<T>('<id>', 'name')` | `dependsOn` 声明提供方，否则订阅时抛错 |
| 贡献点（UI 扩展） | 内置的在 `ui-kernel` 的 `builtinPoints`（commands、surfaces、panels、settingsPages……）；功能自己的在 `ui-api` 里 `defineContributionPoint<T>('<id>.<name>')` | `ctx.contribute(point, item)` |
| 跨进程调用 | 契约方法和通知 | UI / Host 经 `rpc` 调用，Core 经 `ctx.host` 调用 Host |
​
另外：
​
- 服务接口只暴露这个功能愿意承诺的最小能力，不要把内部类直接交出去。
- 事件载荷只放 id 和必要字段，不放可变对象。
- 订阅方不能假定自己一定能收到事件（Core 重启时会丢）。需要可靠送达的，用持久化状态，在启动时对账。
​
### 5.4 跨进程与重启
​
- 三个进程各自独立崩溃和重启。Host 的 `CoreSupervisor` 负责重启 Core（带退避和 crash loop 判定）；UI 用 `onCoreReady` 重新同步。
- 通知是**有损**的：Core 重启前后之间发出的通知不会补发。UI 侧的任何状态都要能靠「重读一次」恢复。
- 时间线是唯一有补齐协议的流：`epoch` 加 `seq`，可以 catch-up，补不上就整页重读。新增类似的流式数据时，照这个协议做，或者干脆每次整读，不要发明第三种。
- Host 与 Core 总是一起发布，不存在跨版本兼容；`PROTOCOL_VERSION` 只用来发现装坏了或忘了重建 Core。
​
### 5.5 引擎端口
​
- 业务只认 `@poietica/engine` 的接口（`AgentEngine`、`EngineSession`、事件类型）。要用 omp 的新能力，按顺序做：
  1. 在 `packages/engine` 加端口（接口和类型）；
  2. 在 `@poietica/engine-testkit` 的 FakeEngine 里实现，并加一致性用例；
  3. 在 `packages/engine-omp` 实现，跑通同一套一致性用例。
- omp 的事件形状、设置键、会话文件格式以 `docs/omp-sdk-reference.md` 为准；写 engine-omp 时把踩到的坑写成「omp 知识 #N」注释。
- 隔离是硬要求：omp 的全部数据只落在 `DataLayout.ompRoot`；全局 `~/.omp`、`.env` 和其它工具的凭据变量一律屏蔽；启动自检不过就拒绝启动。动到 bootstrap、环境或路径的改动，必须跑 isolation 测试和 `core:probe`。
​
## 6. 契约、RPC 与协议版本
​
- 契约用 `defineContract` / `defineMethod`（`@poietica/contract-kit`）加 zod 定义。方法名是 `<命名空间>.<动作>`，`owner` 取 `core` 或 `host`（决定 RpcHub 把请求路由给谁）。错误码是 `<契约 id>.<snake_case>`，由本功能的 `defineErrors` 定义；系统级错误码是 `kernel.*`。
- **先写契约，再写实现**。新契约要在 `packages/protocol/src/index.ts` 的 `composeContracts` 里登记；内核启动时会检查是否有方法没实现。
- **任何契约形状变化**：都要提升 `packages/protocol/src/version.ts` 的 `PROTOCOL_VERSION`，再跑 `bun run protocol:snapshot`。Host 与 Core 总是一起发布，版本号只用来发现装坏了或忘了重建 Core。
- 改通知或事件时要想清楚接收方在**重启 / 重连之后**怎么补齐（时间线用 epoch + seq；Core 的每次重启都要让 UI 看得出来）。
​
## 7. 代码约定
​
- **TypeScript 严格模式**。禁止 `any`、`@ts-ignore`、`@ts-expect-error`、`biome-ignore`。确实需要的规则例外，只能写进 `biome.json` 的 `overrides`，按精确文件路径列出，并在文件头注释说明原因。
- **格式**交给 biome：2 空格缩进，行宽 120，单引号，不写分号，尾逗号。单个函数的认知复杂度不超过 15，超了就拆函数，不许压制。
- **错误三分类**（`features/**` 里不许出现裸 `Error`）：
  - 业务错误（会跨 RPC 或被用户看到）用 `AppError` 加本功能的错误码。
  - 程序不变量用 `invariant()` / `assertNever()`（`@poietica/foundation`）。
  - 表单校验返回 `{ ok: false, message }`，不抛异常。
- **日志**只用注入的 logger（`ctx.logger` 或依赖里传进来的 `Logger`），产品代码禁止 `console.*`。
- **路径**：数据路径只来自 `DataLayout`（`@poietica/runtime-layout`）；拼路径一律用 `node:path`，禁止手写 `\\` 或 `/`。
- **存储**：SQL 只写在功能 `core/` 下的仓储文件（`repository.ts` / `*-repository.ts` / `repo.ts`）和 `migrations.ts` 里；表名以功能 id 为前缀（`-` 换成 `_`），内核会校验。JSON 文件统一走 `@poietica/fs-kit` 的 `createJsonDocument`。每份事实只存一处：对话正文只在 omp 会话文件里，其余数据各有唯一主人（见 ARCHITECTURE §7）。
- **系统能力**（文件对话框、开链接、通知等）走 platform 功能的契约，不在功能里重复实现。
- 注释、界面文案、提交说明用**中文**。注释写「为什么」，不写「做了什么」。
​
## 8. 运行时正确性：这个仓库最容易出错的地方
​
写异步、生命周期或跨进程代码时逐条自查：
​
1. **不吞异常**。`catch` 至少记一条带上下文的 warn；`void promise` 必须带 `.catch`。吞掉的异常就是一个永远卡住的状态。
2. **状态机收尾放 `finally`**。「一轮结束」「回到 idle」「释放资源」不能放在可能抛异常的语句后面。
3. **每个 `await` 之后重新检查前提**：是否已 dispose、是否被取消、代号（generation）是否变了。打开中、启动中的对象也要能被关闭和取消。
4. **按线程或会话索引的进程内表（`Map` / `Set`）必须有删除路径**。Core 是长期运行的进程，只增不减就是内存泄漏。
5. **Core 会重启，UI 会重载**。UI 侧的状态要能从 Core 重新拉齐，不能只在首次就绪时加载一次；不要在进程内从 1 开始数版本号，然后假定对端没见过。
6. **时间线**：增量投影（`LiveProjector`）和历史投影（`projectHistoryPage`）的 step / frame 编号规则不同。一轮还开着时不要让 UI 整页重取，局部失败就局部降级。
7. **Windows**：文件被占用时 rename / unlink 可能报 `EPERM` / `EBUSY`；子进程退出、端口释放都比 Linux 慢，关停要有超时预算。
​
## 9. UI 约定
​
- 前端状态用 `createFeatureStore`（zustand），store 归属于某个功能，不建跨功能的全局 store；功能的界面包在 `FeatureErrorBoundary` 里，一个功能崩了不拖垮外壳。
- 调 RPC 统一走功能 `ui/api.ts` 里的薄封装，组件里不直接拼方法名。
- 样式用 `design-system` 的组件与 token，加 Tailwind 4；不要在功能里另起一套颜色或间距。
- 界面文案与视觉以基准截图（`docs/baseline/`，由维护者提供）为准，**不得擅自改动**。
​
## 10. 测试
​
- 框架是 `bun:test`。测试放在 `src/**/__tests__/*.test.ts(x)`；UI 测试由 `tooling/test/` 的 preload 提供 happy-dom 和 React 环境。
- 内核级测试用 `@poietica/core-kernel/testing` 的 `createCoreHarness`（只装被测模块和它的依赖，加 FakeEngine）。引擎替身来自 `@poietica/engine-testkit`；改了引擎行为时，一致性用例要同时跑 FakeEngine 和 OmpEngine。测试用 logger 来自 `@poietica/test-kit`。
- 修 bug 时**先写一个在旧代码上失败的测试**，再改实现。
- 隔离相关的改动要过 `packages/engine-omp/src/__tests__/isolation.test.ts`，再跑 `bun run core:probe`。
- 测试文件可以用裸 `Error` 和 `console`，也不受子入口运行时规则约束；但测试文件也必须被某个带 `bun` types 的 tsconfig 收录（闸门 `editor-project-map`）。
​
## 11. 常见任务
​
- **加平台包**：`bun run new:package <name> --layer <0|1|2|3|5> --runtime <neutral|dom|node|bun|electron-main>`（会自动登记到 `layers.json`）→ `bun run refs` → `bun run  all`。
- **加功能**：`bun run new:feature <id> --parts …` → 写 contract → 在 protocol 登记并提升版本 → 实现 core / host（服务、仓储、迁移、handlers）→ 实现 ui → 三个清单各加一行 → 写测试 → `refs` + `protocol:snapshot` + `check`。完整步骤见 ARCHITECTURE §9。
- **加或删一个 RPC 方法**：改 contract → 实现 handler → 提升 `PROTOCOL_VERSION` → `protocol:snapshot`。
- **升级 omp**：改 catalog 里四个 `@oh-my-pi/*` 的版本 → 对照 `docs/omp-sdk-reference.md` 和代码里的「omp 知识 #N」注释（`rg "omp 知识 #" packages/engine-omp`）逐项核对会话文件格式、设置键、工具名、事件形状、浏览器 relay 协议 → 核对结果写进 refactor-log → `core:build` + `core:probe` + `check`。核对完成前不合并。
- **发布**：`bun run version:set <x.y.z>` → 提交 → 打 tag `v<x.y.z>` 并推送 → release 工作流出草稿 → 在干净虚拟机上人工验收 → 转为正式发布。
​
## 12. 工作方式
​
- 改动只覆盖任务点名的范围，不顺手重构。遇到文档没覆盖、拿不准的情况，在 `docs/refactor-log.md` 的「待决问题」记一条，**停下这一项，不要猜**。与架构不一致又必须这样做的，记进「偏差」并写明原因。
- 提交信息用 `<type>(<scope>): <中文说明>`（type 取 feat / fix / refactor / test / docs / chore）。`bun run  all` 不绿不提交。
