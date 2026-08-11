# Poietica 架构宪法

读者是修改这个仓库的 AI 代理与人。它的目标只有一个：无论谁来写代码，架构不偏移。
本文按"裁决权 → 不变量 → 数据流 → 宏观架构 → 目录与文件 → 微型架构 → 扩展路线 →
变更纪律 → 验证"的顺序展开，每一条都可执行或指向可执行物，没有一条是愿望。

## 0. 裁决权

本文**解释**架构。可执行的定义只在下表，与本文冲突时以下表为准，并回来修本文：

| 事实 | 定义在 | 由谁执行 |
| --- | --- | --- |
| 包分层与依赖方向 | \`tools/architecture/rules.config.mjs\` | \`pnpm test:architecture\` |
| 包内目录命名禁用清单 | 同上 \`forbiddenDirectoryNames\` | 同上 |
| 依赖版本 | \`pnpm-workspace.yaml\` 的 catalog | pnpm |
| IPC 契约 | Rust 类型，生成到 \`packages/ipc/src/generated/\` | \`pnpm ipc:check\` |
| IPC 命令清单 | \`apps/desktop/src-tauri/src/ipc/mod.rs\` 的 surface()，唯一一份 | 同上 |
| 磁盘布局 | \`apps/desktop/src-tauri/src/paths.rs\` | 运行时 |
| 帧的形状 | \`crates/agent-runtime/src/frame.rs\` | serde + 测试 |

**不要在文档里重抄任何一张表。** 手抄表制造第二个事实，第二个事实必然分叉。

## 1. 产品不变量

Poietica 是本地高性能 ACP 客户端桌面应用，对标 Codex 桌面版。围绕 Kimi Code
（TypeScript 版，\`kimi acp\` 入口）构建，Kimi 是一等公民但不独占：agent 以
\`packages/agent-catalog\` 的档案接入，通用层不认识任何一家的名字。多会话并发
是常态而非特例。

- **会话是唯一中心。** 任何能力不得绕过会话另立入口。
- **对话内容的唯一持有者是 agent。** 本地不存对话正文，历史经 ACP 的
  session/load 重放交还。本地只存索引：对话行、轮次封条、附件账。
- **每一类状态有且只有一个所有者、一条写入路径。** 禁影子状态、禁兜底副本。
- **用户主导。** AI 的改动可预览、可拒绝、可撤销；模型输出是不可信输入。
- **本地优先。** 状态可靠落盘，行为可预测，密钥永不落我们的盘。

## 2. 数据流（一句话验收）

帧从 \`kimi acp\` 子进程 stdout 进 driver（官方 ACP Rust SDK），经
RunSlot → Recorder（会话内单调序号）→ FrameSink → 宿主 16ms 攒批 →
Tauri event → transcript-store（按会话号路由到对话）→ timeline 投影 →
React。反向只有三条命令路：prompt / cancel / resolvePermission。
谁持有唯一真相：会话内容 = agent；对话索引 = threads.sqlite3（单写者）；
帧形状 = frame.rs；配置真身 = agent 受控 home 的 config.toml（由 agent 自己
热重载，我们只经它的官方 CLI 写入）。

## 3. 宏观架构

\`\`\`text
apps/desktop/src/        产品界面与应用编排（组合根：shell/app-shell.tsx）
apps/desktop/src-tauri/  唯一的 Rust 组合根：建窗、注册命令、DTO 互转
crates/                  native crate：互不依赖、不依赖 tauri、可 cargo test 单测
packages/                TS 工作区包：分层由 rules.config.mjs 裁决，依赖单向向下
tools/architecture/      机器执行的那部分架构
\`\`\`

三条 TS 不变量：依赖只指向更低层（判据落在 package.json 边上）；只有
transport/composition/application 三层可碰 \`@tauri-apps/*\`；跨包只走公开
exports。新包先定层，否则架构检查失败。

Rust 侧四元结构：每个 crate 拥有一块与宿主无关的能力；src-tauri 命令函数是
薄封装。**薄的判据可执行：凡是不需要 AppHandle/State/Emitter 就能写出的逻辑，
必须住在 crate 里并有自己的单测。** 组合根里只允许：解参、调 crate、DTO 互转、
emit、宿主节拍（攒批、窗口、托盘）。

## 4. 目录与文件的放置判据

**知识归属决定位置，这是第一判据：**

- 目录名声明能力（composer、timeline、recorder、persistence），禁技术种类名与
  万能桶名——禁用清单由机器执行，这里不重抄。
- **agent 专属知识只允许住在两个地方**：agent-catalog 的档案（数据），或以该
  agent 命名的专属模块（代码，如 \`kimi_state.rs\`）。通用层出现
  \`if agent_id == "某家"\` 即为缺陷——判例：thread.rs 曾把改写 Kimi 私有
  state.json 的逻辑写死在通用归档命令里。
- 常量单一产地。跨语言不得不复制时（如 IMAGE_OPENER），拷贝处必须注明正本
  的**当前**路径，正本移动时拷贝注释必须跟着改。
- 生成物（packages/ipc/src/generated/）不手改；lockfile 不由重构脚本碰。

**拆分判据（出现任一才拆，行数本身不是理由）：**

1. 文件里出现第二个判别式主干（同一个 enum/union 在同文件两处 match 分发）；
2. 文件里同居两种寿命的状态（进程级与连接级、会话级与轮次级）；
3. 文件同时服务两类读者（协议解码 + HTTP 应答 + 校验同居一文件）；
4. 模块头注释无法用一句话说清职责。

超过 800 行且不满足以上任何一条的文件，在模块头写明为什么内聚（判例：
transcript-store.ts 的 held/alias/routes 互相耦合，rename 同写三张表，不拆）。

**合并判据：** 同一判据的两半必须同文件（判例：asset.rs 的 FORMATS 把文件头
判定、Content-Type、扩展名收成一张表，加一种格式只改一行）。两处实现同一规则
（两份时钟、两份解析）即为缺陷，向单一产地收敛。

**命名判据：** 名字说的是能力与事实，禁 legacy / v2 / new / old / *2 后缀
（判例：acp-sessions2.md）。改名与换实现必须同一次改动完成，不留旧名转发层。

## 5. 微型架构条例（文件内部）

- **单一分发点**：一种帧/一种状态只允许一个 match/switch 主干；协议知识收在
  一处（TS 侧唯一认识 ACP 帧的文件是 timeline/acp-projection.ts，Rust 侧是
  frame.rs——别处出现协议判别即为泄漏）。
- **成形与投递两段式**：昂贵构造在锁外/号外完成，占号、上锁、发布只做最后一步
  （判例：recorder.rs 的 shape/deliver，asset_protocol 的 materialise 后上锁）。
- **错误一套面**：全仓一个 Error 枚举 + 一张脱敏表；对外文案与内部诊断分离，
  唯一透传例外（AgentCli）必须在变体文档里写明判据与理由。
- **Debug 不打载荷**：任何可能携带大字节/密钥的类型，Debug 手写或字段跳过。
- **store 形制**（TS）：不可变快照 + subscribe + 单一 #commit 写点 + 引用不变
  则不通知；动作是箭头字段，引用终生稳定；派生视图只在其输入变化时重算。
- **顺序即不变量**：写字节先于写账、删账先于删字节——唯一合法中间态必须是
  "会被自动回收的那一种"，在模块头写明方向与理由。
- **时钟、序号、路径等基础设施单点发放**；同款逻辑第二份出现即为缺陷。

## 6. 注释防腐纪律

- 注释只解释**当前代码为什么这样**。历史叙述仅当它是当前形态的直接论据
  （"不是 X，因为 X 试过且以某种方式坏了"）才保留；无现时论据的纯历史一律删。
- 指名道姓：引用标杆（Zed/Codex 的文件路径、SDK 文档节名）、引用本仓判例时给
  **当前**路径。文件被移动/拆分时，指向它的注释锚点必须同步更新——判例：
  transcript-store.ts 曾指向已拆分的 commands/agent.rs。
- 外部行为断言注明来源与日期。Kimi Code 的行为以 TS 版（MoonshotAI/kimi-code，
  npm @moonshot-ai/kimi-code）官方文档为准；kimi_cli Python 版的锚点已过时，
  发现即更新。
- 注释与代码矛盾按缺陷处理：改注释或改代码，不许并存。

## 7. 扩展预留路线（加东西走这里，别发明新路）

- **加一家 agent**：agent-catalog 加档案（program/args/homeVar/ownHomeDirectory/
  installSpec/方言）。验收：通用层零改动。专属行为走档案能力开关 + 专属模块。
- **加一条 IPC 命令**：Rust 定类型与命令 → 挂进 ipc/mod.rs 的 surface() →
  \`pnpm ipc:generate\` → TS 端口层适配。TS 侧先写形状即为缺陷。
- **加一种帧**：frame.rs 加 variant，两侧由编译器与生成绑定兜底。
- **加一个包**：先在分层表定层，再建目录。
- **协议升级**：ACP 稳定版是 v1；v2 是 draft，升级必须显式版本协商 + 特性开关，
  等 SDK 稳定入口。禁手抄协议类型（判例：protocol.ts 记录的 8/13 variant 落后
  事故）——只 re-export 官方 SDK。
- **加持久化**：迁移只追加，一条 shipped 的迁移永不修改。

## 8. 变更纪律

- **一次换干净**：替换旧实现必须同一次改动删掉旧路径。禁兼容层、禁开关双活、
  禁无期限迁移设施——一次性迁移代码必须写明删除条件与预计删除时间，条件满足
  即删（反例登记：profile.rs 的 legacy_providers，见 §10）。
- ADR 单调唯一编号，一号一文件；决策被取代时旧 ADR 标 superseded，不删不改号。
- 改动触及 AI 上下文、持久化、IPC、权限或公开 API 时记 ADR。
- 范围保持聚焦；未验证不得宣称完成。

## 9. 验证

\`\`\`bash
pnpm check
\`\`\`

一条命令串起 Biome、架构规则、全工作区 typecheck/test、rustfmt、Clippy、
cargo test 与 IPC 绑定一致性。涉 AI 的改动另验：取消、超时、异常模型输出、
过期结果、密钥不泄漏。测试内的 expect/unwrap 由根 clippy.toml 放行，不再逐处
allow。

## 10. 已知偏差登记（禁止模仿，按批次收敛中）

1. src-tauri/commands 的 agent/、agent_setup/profile.rs、install.rs 超出薄封装，
   业务分支下沉中——新代码不得以它们为样板。
2. asset_protocol.rs 的模块头仍是旧产品叙述（DocumentCodec/.draw），拆分与注释
   重写排期中。
3. thread.rs 的 Kimi state.json 专属分支待迁出通用层。
4. legacy_providers 一次性迁移设施待收口删除。
5. 部分注释仍引用 Python 版 kimi_cli 路径，逐批替换为 TS 版锚点。

## 11. 文档地图

| 位置 | 内容 |
| --- | --- |
| \`docs/architecture/\` | 稳定的系统边界与实现约束 |
| \`docs/adr/\` | 已接受的技术决策及其理由 |
| \`docs/rfcs/\` | 进行中的提案 |
| \`docs/runbooks/\` | 开发、维护与运维流程 |
| \`tools/architecture/README.md\` | 机器执行的那部分架构 |
