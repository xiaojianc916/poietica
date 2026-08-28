# RFC 0001: 模块化收敛 — 全仓架构审查与总体设计

Status: 提案（proposed）
日期: 2026-08-28
范围: packages/ + crates/ + apps/desktop/src-tauri + apps/desktop/src
关联: AGENTS.md（架构宪法）§3 §4 §5 §10

## 1. 摘要

本次审查覆盖全仓 13 个 TS 工作区包、6 个原生 crate 与双组合根。结论：分层纪律与
store 形制大体健康（跨包深引用 0 违规、kap 帧唯一分发点成立、domain 层不认识 React
由机器执行）。真正值得动的是四处：**拆 driver、并 file-diff、收窄两个导出面、收敛
transcript-store 写点**，外加两处治理补漏。设计取向是演进式收敛，不是推倒重来——
包数只减不增，接口面只窄不宽。

方案受三个外部仓库调研校准（Lody、opencode、egoist/waku，见 §6）：它们的实质模式
Poietica 基本已有，且多有等价物更严——设计重心是**收窄与命名，不是新增**。

## 2. 背景与判据

审查不引入新标准，全部判据来自 AGENTS.md：

- §3 薄封装判据：凡不需要 AppHandle/State/Emitter 就能写出的逻辑，必须住进 crate
  并单测；
- §4 拆分判据：①同文件第二个判别式主干 ②两种寿命的状态同居 ③同时服务两类读者
  ④模块头一句话说不清职责——行数本身不是理由；超 800 行但不满足任一条的，模块头
  写明内聚理由；
- §5 store 形制：不可变快照 + subscribe + 单一 #commit 写点；
- 代码质量阶梯：优先删除，其次新增；禁止主动新增抽象；一个实现不建接口；
- 变更纪律：一次换干净，禁兼容层、禁双活。

审查方法：git log 热点回溯（近 60 提交：review/ 与 browser/ 各 ≥10 次、timeline+
transcript、settings/custom-agents 是热区）+ 全包导出面普查 + store 形制抽查 +
三仓库架构对标。

## 3. 候选判定表

判定词汇取自 codebase-design：module / interface / implementation / depth /
seam / adapter / leverage / locality。删除测试：删掉该模块，复杂度消失（pass-through）
还是向 N 个调用方转移（挣得存在）？

| # | 候选 | 判定 | 强度 | 关键证据 |
| --- | --- | --- | --- | --- |
| 1 | `crates/agent-runtime/src/driver.rs`（2580 行）拆分 | 判据①③命中：`connect()` 主循环（L865-1418）与 `EventRouter`（L1419 起）是两个判别式主干；L1768-2449 是 18 个纯 REST 端点函数（全部 `http: &reqwest::Client`，无 WS 依赖，只被命令层调用）——两类读者同居一文件。拆法：crate 内新增 `event_router.rs`（EventRouter + 其既有独立测试组迁出）与 `rest.rs`（kap REST 端点群迁入），driver.rs 留守 connect 主循环与连接生命周期原语。**不建新 crate**：REST 客户端只有命令层一个 adapter，假 seam | Strong | grep 全量核实 |
| 2 | `packages/file-diff`（384 行单文件包）并入 `packages/core` | 删除测试通过：9 处消费者（agent-ui 6 文件 + apps/desktop/src/review 3 文件）仅改 import，无复杂度转移、无第二实现、无独立寿命。包级 workspace 注册/治理/导出声明的固定成本 > 收益 | Strong | 9 处 import 全量列举 |
| 3 | `packages/agent/src/session/transcript-store.ts`（1143 行）写点收敛 | `#now/#fire/#republish` 多条私有写路径 + per-key `#dirty` 批处理，违反 §5 单一 #commit。收敛为单一 `#commit(snapshot)`，批处理保留为 commit 内调度。**不拆文件**：模块头已声明 held/alias/routes 耦合（rename 同写三张表），符合 §4 内聚条款 | Strong | 模块头自述 + 形制比对 |
| 4 | `packages/ipc` index 收窄（约 88 符号） | 传输桥 interface 过宽。精选 index 优于新增子路径：`./generated/ipc-bindings` 子路径已存在，再开子路径 = 制造第二个 interface。执行前先统计消费者分布定形状 | Worth exploring | index 符号普查 |
| 5 | `packages/agent` index 收窄（40+ 符号） | 公共面 = 内部全量。若消费者呈 timeline/session 簇分布，子路径导出符合 locality；否则精选 index。同一判据两个候选共用一次消费者统计 | Worth exploring | index 符号普查 |
| 6 | mascot（expressions 2573 + engine 1743）独立成包 | 包级消费者仅 agent-ui 一个（settings 的 mascot-prefs.tsx 只依赖 core 与本地原语，属局部命名巧合）——拆包是假 seam。留 agent-ui 内聚，若 agent-ui 未来再分裂时重议 | Speculative | import 方向核实 |
| 7 | 治理补漏：`update` crate 补进 `tools/architecture/rules.config.mjs` 的 nativeCrates 名单（L278 漏登，该 crate 目前不受「不依赖 tauri / 互不依赖 / lints」治理）；ADR 两个 0030 编号冲突修复（见 §8 批 1） | 治理名单与磁盘不一致 | Strong | rules.config L278 |
| 8 | `src-tauri/commands/agent_setup/profile.rs`（866）+ `install.rs`（546）收敛 | §10 已登记偏差，宪法明言「按批次收敛中」。按 §3 判据把不需 AppHandle/State 的逻辑迁入 agent-runtime（agent 专属知识按 §4 归属：catalog 档案或以 agent 命名的专属模块） | Worth exploring | §10 登记 |
| 9 | `src-tauri/asset_protocol.rs`（1354 行）**不动** | 模块头已声明内聚理由（注册表状态机、Range/206 语义、私有类型共享），判据①-④不命中，同文件 mod tests 可单测。搬家仅挪位置，删除测试不通过。**判例保留**；FORMATS 正本在 `commands/asset.rs:354`（宪法引用无误） | 判例保留 | 模块头 + 宪法引用 |

## 4. 目标模块化目录树（英文，演进收敛）

`[标注]` = 变更类型：合并 / 收窄 / 拆分 / 新增（模块）/ 不动。本树可直接当批次验收清单用。

```text
poietica/
├── packages/                          # 13 → 12
│   ├── core/                          # [合并] ← file-diff 并入（统一 diff→屏幕行能力，基石层）
│   ├── ui/                            # [不动] --ui-* token 设计系统
│   ├── agent-contract/                # [不动] 端口契约（protocol 层，零运行时依赖）
│   ├── agent/                         # [收窄] index 40+ 符号 → 窄导出面（按消费者簇定形状）
│   ├── agent-catalog/                 # [不动] agent 名录与各家专属档案
│   ├── ipc/                           # [收窄] index 88 符号 → 窄面；保留 ./generated/ipc-bindings
│   ├── agent-ui/                      # [不动] 会话界面（composer/feed/timeline/threads/mascot 内聚）
│   ├── automations/                   # [不动] 定时任务
│   ├── browser/                       # [不动] 右坞浏览器面板
│   ├── plugins/                       # [不动] 插件与技能
│   ├── settings/                      # [不动] 设置面与代理配置
│   ├── workspace/                     # [不动] 工作台壳与布局
│   └── desktop-adapters/              # [不动] 组合层适配
├── apps/desktop/
│   ├── src/                           # [冻结] review/browser 刚完成收敛（近 10 提交），本轮不动
│   └── src-tauri/
│       ├── asset_protocol.rs          # [不动] 内聚判例（§4 ④ 反例：已声明理由）
│       ├── commands/asset.rs          # [不动] FORMATS 正本（L354）
│       ├── commands/agent_setup/      # [批次 7 收敛] profile/install 按 §3 判据外迁
│       ├── commands/agent/journal.rs  # [不动] 16ms 攒批（live 流发送点）
│       └── ipc/mod.rs                 # [不动] surface() 103 条命令唯一清单
└── crates/                            # 6 个不变
    ├── agent-runtime/src/
    │   ├── driver.rs                  # [拆分] 留 connect() 主循环 + 连接生命周期原语（Relinked/Spawned/Reconcile*/Prompt*）
    │   ├── event_router.rs            # [独立] EventRouter + event_router_tests 迁出
    │   ├── rest.rs                    # [新增模块] kap REST 端点群（18 个 async fn，L1768-2449）
    │   ├── recorder.rs                # [不动] 会话内单调序号（shape/deliver 两段式判例）
    │   ├── frame.rs                   # [不动] 帧形状唯一真源
    │   └── …（config/credentials/question/sessions/daemon/…）  # [不动]
    ├── persistence/                   # [不动] 4 迁移 9 表；(thread_id, session_id, seq) 回放键
    ├── browser/                       # [不动]（测试缺口不在本轮路线图）
    ├── git/                           # [不动]
    ├── plugin-host/                   # [不动]
    └── update/                        # [不动] 仅补 nativeCrates 治理名单
```

## 5. 纯中文语义目录树（模块化对照视图）

同一棵目标的语义投影：目录名给中文能力名，实际落地仍是英文目录名。用于沟通评审与
新人 onboarding。命名原则：译能力，不译技术词形（「原生箱」取 crate 本义，「进程桥」
取 ipc 职责）。

```text
诗创（poietica，源自 poiein ＝ 制作）
├── 组件包（packages）
│   ├── 基石层
│   │   ├── 核心（core ＋ 吸收「文件差异比对」）
│   │   └── 界面基石（ui：设计令牌与基元）
│   ├── 契约层
│   │   └── 代理契约（agent-contract：端口类型，零运行时依赖）
│   ├── 领域层（不认识 React）
│   │   ├── 会话域（agent：kap 帧投影、对话转录库、会话状态）
│   │   └── 代理名录（agent-catalog：名录档案与各家专属档案）
│   ├── 传输层
│   │   └── 进程桥（ipc：宿主桥与生成绑定）
│   ├── 特性层
│   │   ├── 会话界面（agent-ui：输入台/信息流/时间线/线程/吉祥物）
│   │   ├── 自动化（automations）
│   │   ├── 内嵌浏览器（browser）
│   │   ├── 插件（plugins）
│   │   ├── 设置（settings）
│   │   └── 工作区（workspace）
│   ├── 组合层
│   │   └── 桌面适配器（desktop-adapters）
│   └── 应用层
│       └── 桌面（desktop：应用壳与编排）
├── 桌面应用（apps/desktop）
│   ├── 界面源码（src：应用壳〔组合根〕、审查台、故障台、工作台、助手、更新胶囊）
│   └── 本机壳（src-tauri：建窗、103 条命令注册、资产协议哨站、磁盘布局、
│               错误登记处、16ms 攒批）
└── 原生箱（crates，互不依赖、不碰宿主）
    ├── 代理运行时（agent-runtime：驱动器〔连接主循环、事件路由器、kap 走访端〕、
    │                 录制器、帧、运行槽位、提问、凭据、守护开关）
    ├── 持久层（persistence：线程账、运行事件账本〔回放游标〕、用量、附件、迁移脚本）
    ├── 内嵌浏览器引擎（browser：拾取器）
    ├── 评审引擎（git：审查、变更监视）
    ├── 插件宿主（plugin-host：账本、布局、暂存区、技艺）
    └── 更新器（update：更新胶囊与差分更新）
```

**术语对照表**（正文 Glossary 已落 `CONTEXT.md`，此处列映射）：
kap 帧投影 = kap-projection｜对话转录库 = transcript-store｜代理名录 = agent-catalog｜
进程桥 = ipc｜驱动器 = driver｜事件路由器 = EventRouter｜录制器 = recorder｜帧 = frame｜
运行事件账本 = run_events｜线程账 = threads｜运行槽位 = RunSlot｜接缝 = seam｜
适配器 = adapter｜深模块 = deep module。

## 6. 外部借鉴映射

调研对象：LodyAI/Lody（Electron+React，ACP + 每家 agent 一个扩展包）、
anomalyco/opencode（Bun/TS，headless server + 多客户端）、egoist/waku（Rust+GPUI
本地编码 agent 桌面应用——注意：非 React 框架，与本项目定位几乎重合）。

**已在仓内，禁止重复建设**：

| 外部模式 | Poietica 等价物 |
| --- | --- |
| waku 协议 crate 单一真源生成 TS 类型 | contracts/kap 快照 + 生成绑定与一致性检查命令 |
| waku sequence 去重 + replay cursor | persistence 运行事件账本唯一键 (thread_id, session_id, seq) |
| opencode Session→Message→Part 分层 | 线程账 + 运行事件账本 + 帧投影 |
| opencode durable/live 双事件流 | 运行事件落库（durable）+ journal.rs:23 的 16ms 攒批宿主事件（live）——**实质已存在但未被命名**，采纳动作 = 批 6 记 ADR 命名，零实现改动 |
| opencode 依赖红线（Schema/Protocol 薄叶子） | rules.config.mjs 分层表 + 同层禁互指 |
| Lody cli-supervisor 独立包 | agent-runtime 守护开关 + 子进程监管 |
| Lody turn-diff（每轮代码变更是等实体） | 审查台单管线 diff（近期已收敛 review 与 timeline） |

**真缺口，采纳**：CONTEXT.md 术语表（opencode 有、本仓无，随本 RFC 落地）；
durable/live 双流命名。

**明确不采纳**：Lody Agent Role 三层（目录 + 能力快照 + Turn 冻结）——名录现状无
Turn 冻结需求证据，一个实现不建接口；waku daemon 进程隔离——已有守护开关，无第二
进程模型证据；Lody loro CRDT——单机本地优先，无多端同步需求。

## 7. 分批落地路线图

每批一次换干净、独立验收（一条检查命令通过）、有明确删除条件；触及公开 API /
持久化 / IPC / AI 上下文的批次记 ADR（编号接 docs/adr/ 当前最大号之后）。

| 批 | 内容 | 规模 | ADR | 验收 / 删除条件 |
| --- | --- | --- | --- | --- |
| 1 | update 补进 nativeCrates；ADR 0030 编号冲突迁号（后发布者 0030-dwm → 0032，文件内加勘误行，ADR README 补勘误条目——「永不重排」纪律的唯一一次豁免，双处留痕）；rfcs 未编号文件合规检查 | S | 否 | 治理名单与磁盘一致；adr 目录无重号 |
| 2 | file-diff 并入 core（9 处 import 改写，删包，分层表同步，模块头迁移） | S | 记（公开 API） | 包目录消失 |
| 3 | driver.rs 拆 event_router.rs + rest.rs（crate 内纯文件迁移，不改行为） | M | 否 | driver.rs 降回单判别式主干；cargo test 全绿 |
| 4 | transcript-store 写点收敛（不拆文件） | M | 否 | 私有写路径 = 1；既有测试全绿 |
| 5 | ipc + agent 导出面收窄（先统计消费者分布再定形状：精选 index vs 子路径） | M | 记（公开 API） | index 符号数减半；无消费者破坏 |
| 6 | CONTEXT.md 术语表补全 + durable/live 双流命名 | S | 记（持久化 + IPC） | 术语在文档与代码注释中统一使用 |
| 7 | agent_setup profile/install 按 §3 判据收敛进 agent-runtime（专属知识按 §4 归属） | L | 记（AI 上下文） | §10 偏差登记销账 |

顺序依据：1-2 零风险先行；3 / 4 互不依赖可并行；5 依赖消费者统计；6 收尾命名；
7 最重后置。批 1-2 完成前不动任何产品代码路径。

## 8. 未采纳项及理由

- **mascot 独立成包**：单一包级消费者（agent-ui），假 seam。留内聚。
- **asset_protocol.rs 拆分/搬家**：模块头已声明内聚理由，四条拆分判据均不命中。
  宪法引用其 FORMATS 收表为正面判例，判例地位不变。
- **新建 agent-setup crate**：REST 端点群同款论证——profile/install 的 adapter
  只有命令层一个；迁入 agent-runtime 已满足 §3（进 crate + 单测），新 crate 是
  假 seam。
- **重排 ADR 编号**：除 0030 冲突迁号外，不重排、不复用任何编号。
- **apps/desktop/src 大规模包化**（failures 1903 / review 1555 / workbench 1083
  等升格为包）：热区刚收敛完，无 seam 证据支持拆分；冻结观察，出现第二个消费者
  或第二判别式主干时再议。

## 9. 执行时核实记录（本 RFC 成文时已闭环）

1. driver.rs L1768-2449：grep 证实 18 个 `async fn` 全部以 `http: &reqwest::Client`
   起参（ensure_model / submit_prompt / open_session / load_session / fork_session /
   archive_session / list_sessions / list_skills / list_mcp_servers / abort_session 等），
   无 WS 依赖。判据③证据成立。
2. FORMATS 正本：`apps/desktop/src-tauri/src/commands/asset.rs:354`。AGENTS.md 引用
   「asset.rs 的 FORMATS」无误，无需勘误（推翻设计阶段的一条待核假设）。
3. mascot 消费者：packages/settings 的两个命中文件均不 import agent-ui（仅 core +
   本地原语），属局部命名巧合。包级消费者仍仅 agent-ui，「不拆」判定维持。
