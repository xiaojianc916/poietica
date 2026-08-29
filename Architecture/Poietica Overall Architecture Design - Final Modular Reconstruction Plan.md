# Poietica 架构总体设计 v2 · 模块化重构方案（证据版）

<aside>
⚖️

结论前置：**当前架构未达专业软件水平**，硬门槛差 7 条（见 §14）。差距不是代码风格，而是三处地基错误——外部协议手搓解析、领域逻辑双份并行（Rust 95KB + TS 224KB）、错误模型四份并存。本页给出一次收敛到位的目标架构；两棵目录树见页尾子页面。

</aside>

## 0. 一句话验收

数据从 `kimi web` 子进程的 KAP 端点来 → 经 **kap-client** 适配层用**生成的**协议模型解码 → 交 **conversation 领域**裁决为封闭的 `ConversationEvent` → 追加写入 **SQLite 事件账本（唯一真相）** → 提交成功后才经**生成的 IPC 契约**投影为前端不可变快照 → **conversation-ui** 只读渲染。反向只有三条命令路：`admitTurn` / `cancelTurn` / `respondInteraction`，三条都是「先落账本、再执行」。

谁持唯一真相：屏幕经过 = 账本 `conversation_events`；模型上下文 = agent 自己；对话索引 = 账本投影（单写者）；事件形状 = `crates/conversation/src/event.rs`；协议形状 = `contracts/kap/*.json` 生成物；错误形状 = `crates/problem`。

## 1. 调研基线与证据口径

本页每条结论都锚定到**实际读过的文件与字节数**，未读的一律标「待验证」，不做经验主义判断。全程未使用网络搜索。

| 仓库 | 提交 | 本轮实读内容 |
| --- | --- | --- |
| xiaojianc916/poietica | 最新内容 | 根清单、[AGENTS.md](http://AGENTS.md)、package.json、Cargo.toml、tools/architecture/run.mjs 全文；crates/*、packages/*、apps/desktop/src[-tauri]/*、contracts/kap、docs/architecture、tests 的目录与文件字节数 |
| LodyAI/Lody | dd241fd | [AGENTS.md](http://AGENTS.md) 全文（能力门控、协议能力协商、durable-write 语义、测试质量条款、公共边界可执行检查） |
| anomalyco/opencode | df35e84 | [AGENTS.md](http://AGENTS.md) 全文（Schema→Core/Protocol→Server 单向依赖、生成 SDK 禁手改、durable prompt admission、steer/queue 投递词汇）+ packages 清单（32 个包） |
| egoist/waku | ae14d1d | [AGENTS.md](http://AGENTS.md) 全文（渲染线程禁 IO、后台执行器 + 世代守卫、虚拟化、串流节拍 ≤8.3Hz/≤30Hz、可访问性作为产品需求）+ src 清单 |

**标杆的反向教训也记录**：waku 的 `src/app.rs` 133KB、`input.rs` 130KB、`browser.rs` 106KB 是已发布产品的真实形态。所以**行数本身不是缺陷判据**——判据是「同居两种寿命的状态 / 两个判别式主干 / 两类读者」。本页对 `driver.rs`（94,961B，占 agent-runtime 源码约 37%）的判决基于后者，不是基于大小。

## 2. 设计哲学：十条公理

每条给出：主张 → 为什么（第一性原理）→ 标杆锚点 → 违反症状 → 可执行判据。哲学不是口号，凡不能被机器或测试检出的条款不写进本节。

### 公理 1 · 账本先于视图（Ledger-before-View）

- **主张**：任何会出现在屏幕上的经过，必须先成为账本里一条已提交的事件，再成为像素。未落账即未发生。
- **为什么**：崩溃、重启、断线、重连是常态而非异常。若视图能先于真相存在，重开对话必然与刚才所见不一致，而「不一致」是无法测试的状态空间。
- **锚点**：opencode「admits one durable `session_input` row before scheduling advisory wake」；Lody「durable local write, then explicit upload；禁止把已持久化的写报成失败」。
- **症状**：UI 出现过而库里没有；重启后消息顺序变化；乐观 UI 与真相分叉。
- **判据**：`ConversationEvent` 的唯一入口是 `ledger.append()`；投影函数签名只接受账本行，不接受网络帧。追加失败必须停流并上报，不得吞掉继续画。

### 公理 2 · 协议不手写（Contract is Generated, Never Typed Twice）

- **主张**：跨进程、跨语言、跨协议的类型只允许由单一机器可读来源生成；两侧手写对齐一律视为缺陷。
- **为什么**：协议演进是外生事件。手写副本的失效方式是「静默错位」——编译器不报警，测试不覆盖，直到用户看到空白气泡。
- **锚点**：opencode「After changing the public Protocol or Server HttpApi, run `bun run generate`；Do not edit `src/generated` directly」；本仓已有 `contracts/kap/openapi.json`（1,035,561B）与 `asyncapi.json`（234,856B）却无任何生成器。
- **症状**：`serde_json::Value` 穿层；`payload as readonly RunEvent[]` 式断言；协议新增变体只有运行时才发现。
- **判据**：`generated/` 目录只由 `tools/contract/*` 写入，CI 跑 `generate` 后 `git diff --exit-code`；生成物之外出现协议字段字面量即违规。

### 公理 3 · 一件事一条管线（One Pipeline per Fact）

- **主张**：同一事实只允许一条代码路径产生、一处状态机裁决、一处投影渲染。
- **为什么**：并行实现之间的差异不是 bug 列表，而是不可枚举的组合空间；两套实现相互兜底时，谁对谁错在生产环境无法判定。
- **锚点**：opencode「Preserve one explicit `llm.stream(request)` call per provider turn；不得经旧 loop 桥接」。
- **症状**：Rust 与 TS 各有一份轮次状态机；同名 store 在两个包各存一份。
- **判据**：状态机、序号发放、时钟、路径解析、错误映射各只有一个产地；架构检查按符号名唯一性验证。

### 公理 4 · 领域纯净（Pure Domain, Injected Edges）

- **主张**：领域层（事件、状态机、不变量、投影）不得链接 IO、时钟、随机、进程、Tauri、DOM；一切边缘能力以 port 注入。
- **为什么**：可测性不是测试的属性，而是分层的属性。领域纯净后，轮次状态机的全部路径可用 `proptest` 穷举，不需要起进程、不需要 sleep。
- **锚点**：Lody「Tests must not depend on real sleeps, wall-clock races, network access…Use injected clocks, fake timers, deterministic fixtures」；Lody `packages/platform` 只放 provider 与 capability 契约。
- **症状**：领域代码里出现 `Instant::now()` / `Date.now()` / `invoke(...)`；单测需要临时目录与真实子进程。
- **判据**：领域 crate 的 `Cargo.toml` 不得出现 tokio/reqwest/rusqlite/tauri；领域包的 `package.json` 不得出现 `@tauri-apps/*`、`react`。

### 公理 5 · 状态单一所有者（Single Owner, Single Writer）

- **主张**：每一类状态有且只有一个所有者、一条写入路径；派生数据必须显式标记为派生并可从真相重算。
- **为什么**：影子状态的代价不是内存，而是「同一个问题两个答案」；缓存与真相脱节后，用户看到的界面无法被任何一份数据解释。
- **锚点**：Lody「Workspace MCP has exactly two durable layers…Do not add machine bindings」——所有者数量是被写进宪法的常量。
- **症状**：`settings-store.ts` 在两个包各一份；UI 本地态与领域态同时可写。
- **判据**：架构检查禁止同一 store 名在两处导出；派生视图只经 `derive(snapshot)` 纯函数产生。

### 公理 6 · 边界即契约（Explicit Module Charter）

- **主张**：每个模块必须能用四句话回答：我是什么、我拥有什么、谁允许调用我、我不许知道什么。答不上就是边界未定义，不得建包。
- **为什么**：目录不是边界，`import` 才是边界。没有显式契约的模块会在半年内退化成第二个垃圾桶。
- **锚点**：opencode 的依赖方向条款把「谁可以依赖谁」写成一句话；Lody 用 `pnpm check:public-boundary` 让边界可执行。
- **症状**：`core` / `desktop-adapters` 这类无法回答第三、四问的包。
- **判据**：每个模块根 `CHARTER.md`（四问四行，≤20 行），架构检查校验其存在且被分层表引用。

### 公理 7 · 错误是数据（Problem as a Value）

- **主张**：全仓一种跨边界错误形状；分类、可重试性、用户文案键、诊断 id 是**数据字段**，不是 catch 处的临场判断。取消不是错误，是状态迁移。
- **为什么**：错误的消费者是三类不同读者（用户、开发者、自动重试逻辑），三者需要的不是同一段文字，而是同一份结构的三个投影。
- **锚点**：RFC 9457 Problem Details 的结构化错误范式（type/title/detail/扩展字段）；Lody「禁止把已持久化的写报成失败」是错误语义正确性的产品级要求。
- **症状**：四处错误定义（`crates/agent-runtime/src/error.rs` 2,264B、`apps/desktop/src-tauri/src/error.rs` 8,388B、`packages/core/src/failure-kernel.ts` 5,853B、`apps/desktop/src/failures/application-policy.ts` 14,749B）。
- **判据**：IPC 边界只允许返回 `Problem`；前端只按 `code/category/retryability` 决策，禁按文案字符串判断。

### 公理 8 · 结构化并发（Owner Creates, Owner Cancels）

- **主张**：任务树与取消树同形：App → Agent → Connection → Session → Turn。父取消必然传播到子；谁创建谁销毁；关闭顺序有界且可测。
- **为什么**：并发缺陷不是概率问题而是拓扑问题。没有取消树，超时、用户中断、窗口关闭三条路径会各自实现一次「尽力而为」。
- **锚点**：Tokio 官方 graceful shutdown 范式与 `tokio_util::sync::CancellationToken` 的父子派生（tokio-util 已在 workspace 依赖中）。
- **症状**：`Mutex` 中毒后回退成布尔值；取消靠标志位轮询。
- **判据**：领域侧只接受 `CancellationToken`，禁 `AtomicBool` 自造取消；关闭路径有集成测试断言「无残留子进程、无未提交事务」。

### 公理 9 · 渲染线程神圣（Frame Budget is a Contract）

- **主张**：渲染路径上不得存在 IO、子进程、锁等待、同步 IPC；重活进后台并以世代号防旧结果覆盖新状态；长列表必须虚拟化；串流有明确提交节拍。
- **为什么**：本地客户端的唯一护城河是「长会话下仍然顺滑」。一旦渲染路径可达 IO，卡顿就从偶发变成必然。
- **锚点**：waku「Treat I/O reached from render as a defect even when it looks cheap or is cached」「guard it with a generation counter」「stream commits ≤ ~8.3 Hz、pulse ≤ ~30 Hz」。
- **症状**：投影在 render 内重算全量；高亮在主线程同步执行。
- **判据**：性能预算写进 `tests/performance/budgets.json` 并在 CI 断言；`useSyncExternalStore` 的 `getSnapshot` 必须返回缓存引用。

### 公理 10 · 能力门控而非环境开关（Capabilities, Not Flags）

- **主张**：差异（agent 方言、协议版本、平台能力）以**协商出的能力集**表达，不以构建种类、环境变量或 `if agent_id == "x"` 表达。
- **为什么**：开关让两套实现同时活着，等于把「哪条路径正在运行」变成运行时谜题；能力集把差异变成可枚举、可测试的数据。
- **锚点**：Lody「negotiate integer protocol versions through `MachineMeta.protocolCapabilities`；never infer support from the CLI release version」「Gate entries…through capabilities rather than build-kind or environment checks」。
- **症状**：通用层出现厂商判断；行为差异靠 env 分叉。
- **判据**：能力集来自握手，落在 `contracts/kap/capabilities.json` 与 `kap-client/src/capability.rs`；通用层出现厂商字面量即架构检查失败。

## 3. 架构原则（可执行条款）

### 3.1 分层：两侧各一条单向环

TS 侧五环，Rust 侧四环，只允许「高环 → 低环」，同环禁互相 import：

| 环 | TS | Rust | 允许依赖 |
| --- | --- | --- | --- |
| R0 契约与词汇 | `contract`（生成）、`problem` | `problem`、`time` | 无 |
| R1 领域 | `conversation`、`review`、`workspace`、`settings`、`agent-catalog`、`automation`、`browser`、`extension`、`update` | 同名领域 crate | R0 |
| R2 适配 | `native-bridge`（唯一 `@tauri-apps/*` 使用者） | `kap-client`、`ledger`、`git-adapter`、`process-host` | R0、R1 的 port |
| R3 表现 | `design-system`、`*-ui` | — | R0、R1 |
| R4 组合根 | `apps/desktop/src` | `apps/desktop/src-tauri` | 全部 |
- 依赖图由 **TypeScript Compiler API**（TS 侧）与 **`cargo metadata`**（Rust 侧）解析，不用正则扫源码——理由：`tsc` 的解析器是官方唯一解析权威，再引第二个解析器等于第二份事实。
- 延迟 `import()` / `require` 不豁免：动态 import 目标同样计入依赖图。
- 新增包必须先在分层表登记，否则检查失败。

### 3.2 模块粒度：三条建包判据（满足其一才独立成包）

1. 拥有稳定对外 API 面（被 ≥2 个上环消费者依赖）；
2. 拥有独立测试价值（能脱离 UI 与进程单测领域不变量）；
3. 承载真实外部边界（协议、进程、文件系统、平台 API）。

不满足即合并。`file-diff`（`src/index.ts` 10,236B 单文件成包）是反例；`review` 领域应是包，其 diff 算法只是它的一个模块。

### 3.3 目录命名：三条禁令

- 禁技术种类名与万能桶名：`core`、`utils`、`common`、`helpers`、`types`、`services`、`adapters`、`persistence` 作为**顶层归属名**一律禁止（`persistence` 允许作为 `ledger` 内部的机制模块名，不允许作为领域归属）。
- 禁时间性命名：`legacy`、`v2`、`new`、`old`、`*2`。
- 目录名声明**能力**（`conversation`、`review`、`ledger`、`composer`、`timeline`），文件名声明**该能力的一个事实**（`admission.rs`、`state_machine.rs`、`outbox.rs`）。

### 3.4 状态所有权矩阵（唯一真相）

| 状态 | 唯一所有者 | 写入路径 | 派生消费者 |
| --- | --- | --- | --- |
| 会话经过（事件流） | `ledger.conversation_events` | `conversation` 领域 → `ledger.append` | 前端快照、线程索引 |
| 轮次准入意图 | `ledger.turn_admissions` | `admitTurn` 命令 | 投递器、崩溃恢复 |
| 投递状态（含未知） | `ledger.delivery_outbox` | `kap-client` 投递器 | 重试、UI「投递中/未知」 |
| 模型上下文 | agent 进程自身 | agent 官方 CLI / `session/load` | 不投影 |
| 线程索引与标题 | `ledger` 投影（单写者） | 事件提交后重算 | 线程列表 |
| UI 瞬时态（滚动、折叠、草稿光标） | 对应 `*-ui` 组件本地态 | 组件内 | 不参与领域 |
| 配置真身 | agent 受控 home 的 `config.toml` | 只经 agent 官方 CLI | 设置界面只读投影 |
| 密钥 | 平台钥匙串 / agent home | 平台 API | 永不落我们的库 |

### 3.5 数据流：四段一向

`采集（adapter）→ 裁决（domain）→ 提交（ledger）→ 投影（projection → snapshot → UI）`。

- 反向只有命令，命令一律「先落意图、再执行」。
- 禁事件回灌：UI 不得向账本以外的任何对象发布领域事件；禁万能事件总线。
- 投影是纯函数：`(账本片段, 能力集) → 快照`；同一输入必得同一输出，实时投影与重启重放必须逐字等价（有测试断言）。

### 3.6 契约生成链（单一来源）

| 契约 | 唯一来源 | 生成物 | 守漂移 |
| --- | --- | --- | --- |
| KAP REST | `contracts/kap/openapi.json` | `crates/kap-client/src/generated/rest.rs` | `tools/contract/generate-kap.ts`  • CI diff |
| KAP 事件 | `contracts/kap/asyncapi.json` | `crates/kap-client/src/generated/events.rs` | 同上 |
| KAP 能力 | 握手协商结果 | `contracts/kap/capabilities.json` | 契约测试 |
| IPC 命令与事件 | Rust 类型 + `ipc/mod.rs::surface()` | `packages/contract/src/generated/ipc-bindings.ts` | `tools/contract/check-generated.ts` |
| 领域事件联合 | `crates/conversation/src/event.rs` | 同上 IPC 生成物 | 穷举测试（TS 端 `never` 兜底） |

生成器选型（需 ADR 定稿，候选：OpenAPI→Rust 客户端生成器 / JSON Schema→Rust 类型生成器）。硬约束：**手写协议结构体一律不接受**，生成器不可用时降级为「由 spec 驱动的校验器 + 拒绝未知必填字段」，而不是回到手写。

### 3.7 错误与取消模型（一套面）

```
Problem {
  code: 稳定字符串枚举（跨版本稳定，前端唯一决策依据）
  category: validation | configuration | permission | transport | protocol
          | persistence | integrity | cancelled | internal
  retryability: no | after-delay | after-user-action
  userMessageKey: i18n 键（不是句子）
  diagnosticId: 关联结构化日志的 ULID
  details: 已脱敏的结构化字段
}
```

- 每个领域 crate 用 `thiserror` 定义**自己的**错误枚举；**只在 IPC 边界一处**映射为 `Problem`（`src-tauri/src/ipc/problem.rs`）。
- `cancelled` 是 category 而非 error：取消后不得上报为失败，不得回滚已提交事件。
- 三条不得吞：账本追加失败、契约解码失败、能力协商失败——必须停流 + 上屏可操作提示。
- 未知外部事件不静默丢弃：落 `UnsupportedExternalEvent`，计数并在诊断面可见。

### 3.8 可测性设计（测试即分层的证明）

| 层 | 测试类型 | 禁止 |
| --- | --- | --- |
| 领域 crate / 领域包 | 单测 + `proptest` 状态机不变量 + 事件排序穷举 | 真时钟、真 IO、临时目录 |
| `kap-client` | 对 in-repo `fake-kap` 的协议契约测试、重连/重放、投递幂等 | 真实 agent 进程 |
| `ledger` | 崩溃一致性、迁移重放、outbox 恰好一次、投影等价 | 手写 SQL 字面量散落 |
| 投影/reducer | 账本 fixture → 快照黄金测试；「实时 ≡ 重放」等价测试 | 快照里存 UI 细节 |
| `*-ui` | 角色/名称/键盘/焦点契约测试 + axe 关键流 | 断言 mock 调用次数 |
| 端到端 | 会话、权限、插话、键盘、崩溃恢复 | 真实网络与真实密钥 |
| 性能 | 预算断言（长转录重放、串流提交、审阅渲染、后台积压） | 只跑不断言 |

三条硬规则（锚点 Lody 测试条款）：**不得依赖真实 sleep 与调度运气**；**fixture 必须合成**，禁提交真实用户/agent 转录；**断言可观测行为**，不断言实现细节。

### 3.9 可扩展性：四条既有路（禁发明新路）

- 加一家 agent：只加 `agent-catalog` 档案 + 能力集；通用层零改动。
- 加一条 IPC 命令：Rust 定类型 → 挂 `surface()` → 生成 → TS 端口层适配。TS 先写形状即违规。
- 加一种领域事件：改 `event.rs` 一处，编译器与生成物在两侧兜底。
- 加一个模块：先写 `CHARTER.md` 与分层登记，再建目录。

### 3.10 可读性：三条局部纪律

- **单一分发点**：一种事件/一种状态只允许一个 `match`/`switch` 主干。
- **成形与投递两段式**：昂贵构造在锁外与号外完成，占号→上锁→发布只做最后一步。
- **注释只解释「当前为什么这样」**；版本号、文件清单、性能数字、进度记事不进注释（腐烂无警报）。

## 4. 模块契约表（四问四答）

| 模块 | 我是什么 | 我拥有什么 | 谁可调用我 | 我不许知道 |
| --- | --- | --- | --- | --- |
| `crates/problem` | 跨边界错误词汇 | Problem 结构、分类、脱敏表 | 所有环 | 任何领域语义 |
| `crates/time` | 注入式时钟 | WallClock/MonotonicClock/TestClock | R1+ | 业务 |
| `crates/conversation` | 会话领域裁决者 | 事件联合、轮次状态机、准入/投递/取消不变量、port 定义 | R2 适配、R3 组合根 | SQLite、KAP、Tauri、UI |
| `crates/review` | 变更集领域 | 变更树、hunk、草稿、提交意图 | R2、R3 | git 命令行、渲染 |
| `crates/asset` | 附件与内容寻址 | 摘要、格式判定表、处置顺序 | R2、R3 | HTTP 响应细节 |
| `crates/workspace` | 工作区与工作台会话 | 根解析、面板会话模型 | R2、R3 | 窗口 API |
| `crates/automation` | 自动化规则领域 | 触发器、调度不变量 | R2、R3 | 通知平台 API |
| `crates/browser` | 内嵌浏览面板领域 | 导航模型、拾取协议 | R3 | 原生 webview 句柄 |
| `crates/extension` | 扩展与技能领域 | 清单、签名校验策略、布局 | R2、R3 | 下载实现 |
| `crates/update` | 发布通道领域 | 通道、清单、签名判据 | R3 | 网络栈细节 |
| `crates/kap-client` | KAP 协议适配 | 生成的协议模型、连接/重连/游标、能力协商、事件翻译 | R3 | 账本、UI、领域内部结构 |
| `crates/ledger` | 事件账本适配 | 连接与事务、迁移、追加/读取、投影表 | R3（经 port 供 R1） | 领域语义（只存不裁） |
| `crates/git-adapter` | git 命令适配 | 进程调用、输出解析、监视 | R3 | 审阅 UI 语义 |
| `apps/desktop/src-tauri` | 唯一原生组合根 | 装配、IPC surface、窗口/webview、资产协议、关闭顺序 | 入口 | 任何领域规则（不得再写业务） |
| `packages/contract` | 生成的线上词汇 | IPC 绑定、事件联合镜像 | R1+ | 手写内容（禁改） |
| `packages/problem` | Problem 的前端解释 | code→文案键、重试决策 | R1+ | 具体 UI 组件 |
| `packages/conversation` | 前端会话领域与用例 | 快照、投影、命令用例、port | R3 UI、R4 | Tauri、DOM、React |
| `packages/review` | 前端审阅领域 | 变更树选择、草稿、语法着色调度 | R3、R4 | 具体面板布局 |
| `packages/native-bridge` | 唯一原生适配 | `invoke`/事件订阅、Problem 解码 | R4 注入 | 领域规则 |
| `packages/design-system` | 设计系统 | 基元、主题、焦点与动效令牌 | R3、R4 | 领域概念 |
| `packages/conversation-ui` | 会话表现层 | 组件、键盘、虚拟化 | R4 | 账本、IPC |
| `apps/desktop/src` | 唯一前端组合根 | DI 装配、shell 区域、命令注册、通知区 | 入口 | 领域裁决（只接线） |

## 5. 范式判决

| 子系统 | 判决 | 依据与标杆对照 |
| --- | --- | --- |
| KAP 协议接入（`agent-runtime/driver.rs` 94,961B 手搓解析） | **重构** | 仓内已有 1.27MB 机器可读 spec 未用于生成；opencode 明令生成 SDK 且禁手改 `src/generated` |
| 领域裁决位置（Rust 95KB 与 TS `packages/agent` ~224KB 各一份状态机/投影） | **重构** | 违反「一件事一条管线」；opencode 只保留一条 provider turn 路径，禁旧 loop 桥接 |
| 账本与准入（`persistence/run_events.rs` 12,596B，无 admission/outbox 表） | **重构** | opencode 的 durable admission 先落行再调度；Lody 的 durable-write-then-upload 语义 |
| 错误模型（四处定义，共 ~31KB） | **重构** | 违反「一套面」；RFC 9457 的结构化错误范式 |
| 取消与生命周期（`run_slot.rs` 2,521B 的锁中毒回退） | **重构** | Tokio 官方 graceful shutdown + CancellationToken 父子树 |
| 组合根薄度（`commands/asset.rs` 21,659B、`automations.rs` 18,851B、`plugins.rs` 17,221B、`updates.rs` 12,189B，另 `asset_protocol.rs` 47,221B、`browser.rs` 26,897B 直接住宿主） | **重构** | 违反本仓 [AGENTS.md](http://AGENTS.md) §3 自定判据；且 §10 只登记了 2 处偏差 → 文档与代码矛盾 |
| 包边界与命名（`core`、`desktop-adapters`、`ipc`、`persistence`、`file-diff`） | **重构** | 违反「按领域划分」；opencode 用 `schema/protocol/core/server/session-ui` 表能力，Lody 用 `platform` 表契约 |
| 状态所有权（`settings-store.ts`/`agent-config-store.ts` 在 `settings` 与 `desktop-adapters` 各一份；`workspace-root.ts` 在 `packages/core` 与 `apps/desktop/src` 各一份） | **重构** | 违反单一所有者 |
| 浏览器能力（`crates/browser` 23KB + 宿主 `browser.rs` 26,897B + 前端 `element-picker-runtime.ts` 25,449B） | **改造** | 能力三处分家；waku 的 `browser.rs` 虽大但单一归属 |
| 审阅子系统（`apps/desktop/src/review/review-pane.tsx` 28,532B + `review-store.ts` 14,713B + `crates/git/review.rs` 12,641B + `packages/file-diff` 10,236B） | **改造** | 领域逻辑住在 UI 层；应收敛为 `review` 领域 + `review-ui` |
| 前端表现层（`agent-ui` 已按 composer/feed/timeline/threads 分域） | **完善** | 结构方向正确，保留并补齐 a11y 与性能预算（waku 条款） |
| 设计系统（`packages/ui` 基元齐备） | **完善** | 仅更名为 `design-system` 并冻结公开面 |
| 契约快照机制（`contracts/kap`  • `tools/kap/spec-sync.mjs`） | **改造** | 快照与校验已有，缺生成环节 |
| 架构治理（`tools/architecture` 正则扫描，`rules.config.mjs` 42,363B 无类型检查） | **重构** | 官方能力可用：TS Compiler API + `cargo metadata`；治理器自身应受与产品同等的类型与测试约束 |
| 工具链语言（11 个 `.mjs`，共 ~90.8KB，全部由 Bun 执行但在 `turbo run typecheck` 覆盖之外） | **重构** | Bun 原生执行 TS，零构建成本；工作区列表为 `apps/*`、`packages/*`、`tests`，`tools/`、`scripts/` 不在其中 |
| 观测性（workspace 只有 `log` facade，无结构化 span） | **改造** | 诊断 id 需跨边界串联，否则 Problem 的 `diagnosticId` 无处可查 |

## 6. 分级问题清单

### P0 架构性

1. **协议手搓**：`driver.rs` 94,961B 手写 KAP 解析，`contracts/kap` 1.27MB spec 未参与生成 → 违反公理 2 → 协议漂移静默失败、变体缺失只在运行时暴露 → 建 `kap-client`，协议模型全部生成，`driver.rs` 删除。
2. **双份领域管线**：Rust `agent-runtime`（~256KB）与 TS `packages/agent`（session ~106KB + timeline ~115KB）各持轮次状态机与投影 → 违反公理 3/5 → 两侧对「轮次是否结束」可给出不同答案 → 领域裁决唯一归 `crates/conversation`，前端只做纯投影与渲染。
3. **账本不是唯一真相**：`persistence` 只有 `run_events`，无 `turn_admissions` / `delivery_outbox` → 违反公理 1 → 崩溃后无法区分「未发送/已发送未确认/已完成」，重试可能重复提交 → 引入准入表 + 发件箱 + 幂等键。
4. **错误模型四份**：`agent-runtime/error.rs`(2,264B)、`src-tauri/error.rs`(8,388B)、`core/failure-kernel.ts`(5,853B)、`failures/application-policy.ts`(14,749B) → 违反公理 7 → 同一故障有四种分类与四套文案，重试策略互相矛盾 → 统一 `Problem`，映射点唯一。
5. **组合根承载业务**：宿主内 `asset_protocol.rs` 47,221B、`browser.rs` 26,897B、`commands/*` 四个文件 >12KB → 违反本仓 §3 与公理 4 → 这些逻辑无法脱离 Tauri 单测 → 下沉到领域 crate，宿主只留解参/装配/emit。
6. **包边界失效**：`core`（6 个不相关文件 + `diagnostics/`）、`desktop-adapters`（含 4 个 store）、`file-diff`（单文件成包）→ 违反公理 6 与「按领域划分」→ 新代码无处可放，默认丢进桶 → 按领域重建，三个包整体删除。
7. **影子状态**：`settings-store.ts` 与 `agent-config-store.ts` 各有两份（`packages/settings` 675B/9,863B 与 `packages/desktop-adapters` 913B/6,070B）；`workspace-root.ts` 两份（2,973B/3,671B）→ 违反公理 5 → 设置与工作区根可出现两个答案 → 单一所有者，另一份删除。
8. **治理器自身不受治理**：`rules.config.mjs` 42,363B + `run.mjs` 4,555B 为无类型 JS，且以正则扫源码判架构；工作区不含 `tools/` → 违反公理 4/6 与「该用标准能力用标准能力」→ 规则误判与漏判都不可见 → 重写为 TS，改用 TS Compiler API + `cargo metadata`。

### P1 专业度差距

1. **能力协商缺失**：无 `capabilities` 协商产物 → 对照 Lody 的 `protocolCapabilities` 整数协商 → 只能靠版本号或分支猜能力 → 建 `capability.rs` + `contracts/kap/capabilities.json`。
2. **取消不是树**：`run_slot.rs` 2,521B 锁中毒回退布尔 → 对照 Tokio CancellationToken 父子派生 → 取消可能漏传、资源泄漏 → 五级取消树 + 关闭顺序测试。
3. **投影不可验证**：`kap-projection.ts` 26,031B + `timeline-reducer.ts` 12,971B 在前端，无「实时 ≡ 重放」等价测试 → 违反可测性 → 顺序/去重缺陷只能靠肉眼 → 投影下沉为纯函数并加等价测试。
4. **观测性缺位**：workspace 依赖只有 `log`，无结构化 span → `Problem.diagnosticId` 无落点 → 现场问题无法定位 → 引入结构化日志与 span，跨 IPC 传递诊断 id。
5. **性能预算未成契约**：`tests/perf` 存在但无预算断言（`tests/unit` 下仅 `architecture/`）→ 对照 waku 的节拍与「render 禁 IO」→ 长会话回归无人守 → `budgets.json` + CI 断言。
6. **可访问性未成门禁**：无 a11y 测试目录 → 对照 waku「accessibility 是产品需求：键盘等价、reduce-motion、不以颜色单独表意」→ 键盘路径易回归 → a11y 契约测试 + axe 关键流。
7. **审阅领域住在 UI**：`review-pane.tsx` 28,532B 与 `review-store.ts` 14,713B → 违反「业务不进 UI 组件」→ 无法脱离 React 测试 diff 选择与草稿 → 抽 `review` 领域包。
8. **agent 专属知识外溢风险**：`agent-catalog` 内含 `provider-state.ts` 10,372B（状态）与 `kimi/`（厂商）混居档案层 → 违反「档案是数据」→ 通用层易被厂商细节污染 → 状态迁出，档案只留数据 + 能力开关。
9. **文档与代码矛盾**：[AGENTS.md](http://AGENTS.md) §10 只登记 2 处「超出薄封装」偏差，实际 ≥6 处 >12KB 宿主文件；`docs/architecture/kap-client.md` 3,093B 描述的 `kap-client` 在 Cargo 成员中不存在（该文档具体描述对象**待验证**）→ 违反「注释与代码矛盾按缺陷处理」→ 新人以错误样板为准 → 目标态一次对齐，宪法瘦身到 ≤8KiB 并按模块分散（对照 Lody 的 scoped [AGENTS.md](http://AGENTS.md) ≤8KiB）。
10. **发布与工具脚本无测试**：`release.mjs` 25,193B 是最高风险脚本却无类型无测试 → 违反可测性 → 发布事故代价最高 → 转 TS 并对清单/签名/通道判定加单测。

### P2 质量债

1. `crates/plugin-host/src/ledger.rs` 10,882B 与 `crates/persistence` 并存两个「账本」概念 → 命名冲突 → 目标态中账本唯一，扩展侧改称 `inventory`。
2. `crates/git` 同时含 `review.rs` 12,641B（领域）与 `watch.rs`（适配）→ 两类读者同居 crate → 拆 `review` 领域 / `git-adapter`。
3. `packages/ipc/src/agent.ts` 19,928B：端口层承担翻译 → 传输层不得含语义 → 翻译归 `conversation`，端口只做调用与 Problem 解码。
4. `apps/desktop/src/failures/` 18 个文件（含 `terminal-*`、`browser-collectors.ts`）→ 故障子系统在 UI 层自成王国 → 迁入 `problem` + `diagnostics` 领域，UI 只保留通知区。
5. `apps/desktop/src/workspace-git.ts` 3,732B 与 `crates/git` 职责重叠 → 前端不得承担 git 语义 → 删除，走命令。
6. `tests/unit` 下只有 `architecture/` → 测试布局名不符实 → 按 §3.8 重排测试目录。
7. `bunfig.toml`/`turbo.json` 的任务图未覆盖 `tools/`、`scripts/`（工作区仅 `apps/*`、`packages/*`、`tests`）→ 工具链逃逸检查 → 纳入工作区或纳入根 tsconfig 项目引用。

### P3 蚊子腿

1. 根目录 `electric-beacon-babbage.md` 11,321B：随机名文档位于仓库根，未在 [AGENTS.md](http://AGENTS.md) §11 文档地图登记（内容**待验证**）→ 归入 `docs/` 或删除。
2. `.workbuddy/` 未在文档地图登记（用途**待验证**）→ 登记或移除。
3. `run.mjs` 内置 `no-task-scoped-guards` 规则专门扫描 `check-*.mjs` → 规则的存在本身说明曾有临时守卫 → 目标态用「策略即代码 + 单一入口」替代，规则随之删除。
4. `Cargo.toml` 中 `# Observability` 段下无任何依赖 → 空标题注释 → 删除或补齐实现。
5. `packages/agent/src/session/immutable-map.ts` 955B：通用容器混在会话领域 → 归 `design-system` 之外的 R0 词汇或就地内联。
6. `apps/desktop/src/chrome/table-downloads.ts` 3,719B：下载语义在窗口装饰目录 → 移到 `asset` 消费侧。

## 7. P0 / P1 前后对比方案

### 7.1 协议接入（P0-1）

- **结构**：前——`crates/agent-runtime/src/driver.rs`（94,961B）兼任进程管理、WebSocket、REST、事件解析、会话路由；后——`crates/kap-client` 按 `process/` `connection/` `session/` `interaction/` `translate/` 五个寿命层拆开，协议模型全部落在 `generated/`。
- **数据流**：前——`serde_json::Value` 一路穿到前端；后——字节 → 生成的 wire 类型 → `translate::event` → 封闭 `ConversationEvent`，未知变体转 `UnsupportedExternalEvent` 并计数。
- **行为变化**（均为提升）：协议新增字段不再静默丢弃；发现未支持事件时给出具名提示而非空白气泡。
- **为何这才专业**：协议属于「已被解决且边界条例极多」的一类，手写必漏；仓内已存在官方 spec，不用等于主动放弃单一真相。

### 7.2 领域裁决与投影（P0-2）

- **结构**：前——Rust `agent-runtime` 与 TS `packages/agent`（`transcript-store.ts` 34,516B、`kap-projection.ts` 26,031B、`presentation.ts` 21,372B 等）各一套；后——唯一状态机在 `crates/conversation/src/turn/state_machine.rs`，前端 `packages/conversation` 只剩「账本片段 → 快照」的纯函数与选择器。
- **数据流**：前——帧同时馈到 recorder 与前端 store，两侧各自判定轮次结束；后——单向：领域裁决 → 提交 → 投影 → UI，UI 无裁决权。
- **行为变化**：重启后时间线与关闭前逐字一致；多会话并发下不再出现跨对话串帧（路由靠账本主键而非内存别名表）。
- **为何这才专业**：领域不可双份。opencode 宁愿改写会话内核也不开第二条执行路径，同理。

### 7.3 账本、准入与发件箱（P0-3）

- **结构**：前——`run_events` 单表；后——`conversation_events`（事件）+ `turn_admissions`（意图）+ `delivery_outbox`（投递，含 `unknown` 终态）+ `kap_cursors`（恢复点）。
- **数据流**：前——命令直接发给 agent，失败就丢；后——`admitTurn` 先写准入行（幂等键 = 客户端生成的 turn id）→ 投递器读取发件箱 → 确认后写终态；崩溃重启从发件箱继续。
- **行为变化**：断网/崩溃后输入不再丢；重试不会双发；「投递未知」有明确状态与可操作提示，而不是转圈到永远。
- **为何这才专业**：事务型发件箱是跨系统投递的标准解法；opencode 的 durable admission 与 Lody 的 durable-write 语义是同一拓扑。

### 7.4 错误模型（P0-4）

- **结构**：前——四处定义 + 前端 14,749B 策略层；后——`crates/problem` 定义，`src-tauri/src/ipc/problem.rs` 唯一映射，`packages/problem` 只做 code → 文案键 / 重试决策。
- **数据流**：领域错误（thiserror）→ 边界映射 → `Problem` → UI 通知区；取消不进错误路。
- **行为变化**：同一故障全局一种文案与一种重试语义；取消不再报错；每条提示带可复制诊断 id。
- **为何这才专业**：错误是产品面的一部分，不是异常流的垃圾桶；结构化错误（RFC 9457 范式）才能同时服务用户、开发者、重试逻辑。

### 7.5 组合根薄化（P0-5）

- **结构**：前——宿主 6 个 >12KB 文件含业务；后——`asset_protocol/` 只留 HTTP 响应与 Range 处理，格式判定与寻址进 `crates/asset`；`browser.rs` 分为 `webview/`（宿主）+ `crates/browser`（领域）；`commands/*` 每文件只剩解参/调用/DTO 互转。
- **数据流**：不变（仍为命令 → 领域 → 账本 → 事件），但每段能单独 `cargo test`。
- **行为变化**：无用户可见差异（纯归属迁移）；副作用是回归可被单测捕获。
- **为何这才专业**：组合根不可测，把业务放进组合根等于把那部分代码永久排除在测试外。

### 7.6 包边界与命名（P0-6）

- **结构**：前——`core` / `desktop-adapters` / `ipc` / `file-diff`；后——`contract`（生成）、`problem`、领域包、`native-bridge`（唯一 Tauri 使用者）、`design-system`、`*-ui`；四个旧包**当场删除**，不留转发。
- **数据流**：不变；依赖图从多向变单向无环。
- **行为变化**：无；仅构建与类型检查变快（环消失）。
- **为何这才专业**：包名就是边界声明。opencode 的 `schema`/`protocol`/`server` 与 Lody 的 `platform` 能一眼看出职责，`core` 不能。

### 7.7 影子状态（P0-7）

- **结构**：前——两份 `settings-store` / `agent-config-store` / `workspace-root`；后——设置真身在 agent `config.toml`（只经官方 CLI 写），前端只持只读投影；工作区根唯一归 `crates/workspace`。
- **数据流**：写路唯一；读路多个但均为派生。
- **行为变化**：设置修改后不会出现“一个面板已变另一个未变”；外部工具改动 `config.toml` 后界面会跟进。
- **为何这才专业**：单一所有者是「不一致 bug 根本无法被写出来」的前提。

### 7.8 治理器（P0-8）

- **结构**：前——`run.mjs` 正则扫描 + 42,363B 无类型规则表；后——`tools/architecture/verify.ts` 编排四个策略模块（分层/所有权/命名/契约），图数据来自 `ts-graph.ts`（TS Compiler API）与 `cargo-graph.ts`（`cargo metadata`）。
- **数据流**：前——文本 → 正则 → 违规；后——AST/包图 → 策略判定 → 违规（带精确位置）。
- **行为变化**：误报与漏报下降；规则自身可单测。
- **为何这才专业**：架构约束是长期资产，它不能是仓库里唯一不受类型与测试约束的代码。

### 7.9 P1 打包对比（能力协商 / 取消树 / 投影等价 / 观测 / 性能 / a11y / 审阅领域 / 档案纯度）

| 项 | 前 | 后 | 可观测提升 |
| --- | --- | --- | --- |
| 能力 | 靠版本/分支猜 | 握手协商整数能力集 | 不支持的功能直接隐藏而非点了报错 |
| 取消 | 标志位 + 锁中毒回退 | 五级 CancellationToken 树 | 取消即时生效；退出无残留进程 |
| 投影 | 无等价测试 | 「实时 ≡ 重放」断言 | 重开对话与当时一致 |
| 观测 | 只有 log | 结构化 span + 诊断 id 跨边界 | 用户可上传一个 id 定位问题 |
| 性能 | 无预算 | `budgets.json` CI 断言 | 长会话不回归卡顿 |
| a11y | 无门禁 | 键盘/焦点/reduce-motion 契约测试 | 全键盘可用，动效尊重系统设置 |
| 审阅 | 领域在 `review-pane.tsx` | `review` 领域包 + `review-ui` | 大仓库选择/草稿行为可回归测试 |
| 档案 | 含状态与厂商目录 | 纯数据 + 能力开关 | 新接一家 agent 通用层零改动 |

## 8. 账本模型（唯一真相的可执行形式）

```
conversation_events   (thread_id, turn_id, seq)  PK；追加只读；payload = 生成的事件联合
turn_admissions       (turn_id) PK；意图快照（prompt、选择、附件、能力集、模型）冻结于准入时
delivery_outbox       (turn_id) PK；state = pending | sent | accepted | unknown | failed；幂等键 = turn_id
kap_cursors           (thread_id) PK；恢复点（事件游标 + 最后已提交 seq）
threads               投影表（标题、排序、忙集、未读），单写者，可从事件重建
usage_totals          投影表（用量与配额），可从事件重建
```

三条不变量：事件表只追加不修改；投影表可删重建（所以它不是真相）；一条已发布的迁移永不修改。

## 9. 工具链判决：11 个 `.mjs` 一次转 TypeScript（回答问题 3：对，应该改）

事实：`packageManager` = `bun@1.4.0`，`engines.bun >= 1.4.0`，且每个脚本的调用方式已经是 `bun xxx.mjs`（`run.mjs` 首行就是 `#!/usr/bin/env bun`）。也就是说**运行时已经是 Bun，只有语言还停在无类型 JS**。Bun 原生执行 TS，改名不引入构建步骤；而当前工作区仅 `apps/*`、`packages/*`、`tests`，所以这 90,772B 完全在 `turbo run typecheck` 之外——仓库里唯一不被类型检查的代码，恰好是「检查其他代码」与「发布产品」那两块。

| 现文件 | 字节 | 目标位置 |
| --- | --- | --- |
| `tools/architecture/rules.config.mjs` | 42,363 | `tools/architecture/{layer-policy.ts,ownership-policy.ts,naming-policy.ts,contract-policy.ts}` |
| `tools/architecture/run.mjs` | 4,555 | `tools/architecture/verify.ts`（+ `ts-graph.ts`、`cargo-graph.ts`、`report.ts`） |
| `tools/kap/spec-sync.mjs` | 3,288 | `tools/contract/kap-spec-sync.ts` |
| `scripts/clean.mjs` | 3,506 | `tools/dev/clean.ts` |
| `scripts/git-hooks/install.mjs` | 817 | `tools/dev/install-git-hooks.ts` |
| `scripts/release/release.mjs` | 25,193 | `tools/release/release.ts` |
| `scripts/release/manifest.mjs` | 4,740 | `tools/release/manifest.ts` |
| `scripts/release/set-version.mjs` | 2,173 | `tools/release/version.ts`（set） |
| `scripts/release/version.mjs` | 899 | `tools/release/version.ts`（read） |
| `scripts/release/verify-channel.mjs` | 1,679 | `tools/release/verify-channel.ts` |
| `scripts/release/check-versions.mjs` | 1,559 | `tools/release/check-versions.ts` |

配套硬要求：`tools/` 纳入根 tsconfig 项目引用（或作为工作区成员），`bun run check` 必须 typecheck 它们；`scripts/` 目录整体消失（工具只有一个归属：`tools/`）；转换与删除同一次完成，不允许 `.mjs` 与 `.ts` 双存。

## 10. 模块化 / 可测 / 可扩展 / 可维护 / 可读（回答问题 1、2）

| 目标 | 机制（不是愿望，是结构） |
| --- | --- |
| 模块化 | 五环分层 + 每模块 `CHARTER.md` 四问 + 三条建包判据 + 子路径导出（`@poietica/conversation/turn`）而非肥大根 index |
| 可测 | 领域零 IO、时钟注入、`fake-kap` 契约服务器、账本 fixture 黄金测试、「实时≡重放」等价测试 |
| 可扩展 | 四条既有扩展路（§3.9）+ 能力集而非开关 + 事件联合单点新增 |
| 可维护 | 一事一管线、单一所有者、生成物不手改、迁移只追加、宪法 ≤8KiB 且按模块分散 |
| 可读 | 单一分发点、成形/投递两段式、目录名 = 能力 / 文件名 = 事实、注释只答「为何如此」 |

## 11. 体验与体量约束

行为变化只允许是提升，逐条列明：

1. 输入不丢（准入表）；2. 重启一致（账本投影）；3. 取消即时且彻底（取消树）；4. 错误可操作（Problem 文案键 + 重试语义）；5. 未支持能力直接隐藏而非报错（能力集）；6. 长会话不卡（预算 + 虚拟化 + 节拍）；7. 全键盘可达与 reduce-motion（a11y 门禁）。

不得发生：现有快捷键与布局变更、首帧变慢（`pre-react-entry.ts` 能力保留）、已有会话数据不可读（迁移只追加）、发行版开发者工具被移除。

## 12. 一次收敛实施顺序（每批可编译可发布，旧路径当场删）

1. **词汇层**：`crates/problem`、`crates/time`、`packages/problem`；四处错误定义归一，旧文件删除。
2. **治理层**：`tools/**` 全量 TS，`scripts/` 删除；分层策略改为 AST + `cargo metadata`。
3. **契约层**：`packages/contract` 生成物就位；`crates/kap-client` 生成协议模型。
4. **账本层**：`crates/ledger` 与四张表；迁移只追加；`persistence` 删除。
5. **领域层**：`crates/conversation` 接管状态机与不变量；`agent-runtime` 删除。
6. **宿主层**：命令薄化、`asset_protocol/`、`webview/`、关闭顺序；宿主内业务代码删除。
7. **前端领域层**：`packages/conversation`、`review`、`workspace`、`settings`；`agent`、`core`、`desktop-adapters`、`ipc`、`file-diff` 删除。
8. **表现与门禁**：`design-system` 改名、`*-ui` 拆分、a11y 与性能预算入 CI。

## 13. 验收门禁（`bun run check` 必须串起）

分层无环（AST + cargo 图）→ 模块 `CHARTER.md` 存在且已登记 → 命名禁令 → 生成物无漂移（IPC + KAP）→ 事件联合穷举 → 领域包无禁用依赖 → 单一所有者（无同名 store 双导出）→ `实时≡重放` 等价 → 关闭无残留 → 性能预算 → a11y 关键流 → rustfmt/Clippy/Biome/typecheck（含 `tools/`）。

## 14. 诚实结论

**现状：未达专业软件水平。** 差这七条硬门槛：① 协议非生成（driver.rs 手搓）；② 领域双份管线（Rust/TS 各一套状态机）；③ 账本不含准入与投递状态；④ 错误模型四份；⑤ 组合根承载业务（≥6 处 >12KB）；⑥ 包边界与命名失效（core/desktop-adapters/ipc/file-diff）；⑦ 治理器自身无类型无测试。

本页方案落地后可以说达到，因为届时四个硬指标同时成立：依赖图单向无环且由官方解析器验证；每份状态能指名唯一所有者；每条跨边界契约有单一生成来源；核心逻辑可在无 UI、无进程、无真时钟下穷举测试。

## 15. 附录：两棵目录树

英文实际目录树与纯中文模块化目录树在下方子页面。

[附录 A · 目标目录树（英文实际目录，含关键单文件）]
Project Architecture Design\Appendix A - Target Directory Tree (Actual English Directories, Including Key Single Files).md
[附录 B · 目标目录树（纯中文模块化语义）]
Project Architecture Design\Appendix B - Target Directory Tree (Pure‑Chinese Modular Semantics).md