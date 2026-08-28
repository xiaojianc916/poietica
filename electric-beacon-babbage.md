# Poietica 架构审查与模块化总体设计 — 执行计划

## 0. 已确认决策（用户拍板）

1. **交付物**：`docs/rfcs/0001-modular-convergence.md` 正式 RFC + 临时目录可视化 HTML 审查报告，双交付
2. **范围**：全仓（packages + crates + src-tauri + apps/desktop/src）
3. **本轮只做设计**，不动代码；重构按批次另行立项
4. **纯中文目录树 = 语义对照视图**（模块给中文能力名，实际落地仍是英文目录名）
5. 参考仓库调研已完成：LodyAI/Lody、anomalyco/opencode、egoist/waku（澄清：egoist/waku 是 Rust+GPUI 本地编码 agent 桌面应用，与 Poietica 定位几乎重合，非 React 框架）

## 1. 审查结论（候选清单）

| # | 候选 | 判定 | 强度 |
|---|---|---|---|
| 1 | `crates/agent-runtime/src/driver.rs`（2580 行）拆分：`connect()` 主循环（L865-1418）留守；`EventRouter`（L1419起，已有独立 event_router_tests）独立成文件；REST 端点群迁入新模块 `rest.rs` | 判据①（两个判别式主干）③（两类读者）命中；crate 内拆文件，**不建新 crate**（单 adapter = 假 seam） | **Strong** |
| 2 | `packages/file-diff`（384 行单文件包）并入 `packages/core` | 删除测试通过：9 处消费者（agent-ui 6 + review 3）仅改 import，无复杂度转移；包级 workspace 成本 > 收益 | **Strong** |
| 3 | `packages/agent/src/session/transcript-store.ts`（1143 行）写点收敛：`#now/#fire/#republish` → 单一 `#commit`；held/alias/routes 不拆（模块头已声明耦合理由） | 违反 store 形制（单一 #commit）；纯私有复杂度收敛 | **Strong** |
| 4 | `packages/ipc` index 收窄（~88 符号） | 精选 index 优于新增子路径（generated 子路径已存在，再开=第二个 interface）；先统计消费者分布 | Worth exploring |
| 5 | `packages/agent` index 收窄（40+ 符号） | 同上；若消费者呈 timeline/session 簇分布则子路径导出符合 locality | Worth exploring |
| 6 | mascot（expressions 2573 + engine 1743）独立成包 | 仅核实到单一消费者（agent-ui）→ 拆包是假 seam；留 agent-ui 内聚 | Speculative |
| 7 | 治理补漏：`update` crate 补进 rules.config.mjs `nativeCrates`（L278 漏登）；ADR 两个 0030 编号冲突修复 | 一行规则 + 迁号勘误 | **Strong** |
| 8 | `agent_setup/profile.rs`(866)+`install.rs`(546) §10 偏差收敛 | 宪法明言"按批次收敛中"；按 §3 判据把不需 AppHandle 的逻辑迁入 crate（agent-runtime 内，§4 agent 专属知识归属） | Worth exploring（L，后置批次） |
| 9 | `asset_protocol.rs`（1354 行）**不动** | 模块头已声明内聚理由，判据①-④不命中，同文件 mod tests 可单测；搬家仅挪位置 | 判例保留 |

**结论主线**：分层纪律与 store 形制大体健康（跨包深引用 0 违规、kap-projection 唯一分发点成立）。设计重心是**收窄导出面、收敛写点、拆 driver、并 file-diff**——演进式收敛，不是推倒重来，包数只减不增。

## 2. 目标目录树（英文，演进收敛；[标注]=变更类型）

```
poietica/
├── packages/                          # 13 → 12
│   ├── core/                          # [合并] ← file-diff 并入（diff 管线能力，基石层）
│   ├── ui/                            # [不动] --ui-* token 设计系统
│   ├── agent-contract/                # [不动] 端口契约（protocol 层，零运行时依赖）
│   ├── agent/                         # [收窄] index 40+ → 窄导出面（timeline/session 按消费者定）
│   ├── agent-catalog/                 # [不动] agent 名录档案
│   ├── ipc/                           # [收窄] index 88 → 窄面；保留 ./generated/ipc-bindings
│   ├── agent-ui/                      # [不动] 会话界面（composer/feed/timeline/threads/mascot 内聚）
│   ├── automations/ browser/ plugins/ settings/ workspace/   # [不动]
│   └── desktop-adapters/              # [不动] 组合层
├── apps/desktop/
│   ├── src/                           # [冻结] review/browser 刚收敛完（git 近 10 提交），本轮不动
│   └── src-tauri/
│       ├── asset_protocol.rs          # [不动] 内聚判例
│       ├── commands/                  # [不动] 本轮；批次 7 另行收敛 agent_setup
│       └── ipc/mod.rs surface()       # [不动] 103 条命令唯一清单
└── crates/                            # 6 个不变
    ├── agent-runtime/src/
    │   ├── driver.rs                  # [拆分] 留 connect() 主循环 + 连接生命周期原语
    │   ├── event_router.rs            # [独立] EventRouter + 其测试迁出
    │   ├── rest.rs                    # [新增] kap REST 客户端（端点函数群迁入）
    │   └── recorder.rs frame.rs ...   # [不动]
    ├── persistence/                   # [不动] 4 迁移 9 表，(thread_id,session_id,seq) 回放键
    ├── browser/ git/ plugin-host/     # [不动]（测试缺口另议，不在本轮路线图）
    └── update/                        # [不动] 仅补治理名单
```

## 3. 纯中文语义目录树（模块化对照视图）

```
诗创（poietica，源自 poiein＝制作）
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
│   │   └── 进程桥（ipc：Tauri 桥与生成绑定）
│   ├── 特性层
│   │   ├── 会话界面（agent-ui：输入台/信息流/时间线/线程/吉祥物）
│   │   ├── 自动化（automations）｜ 内嵌浏览器（browser）｜ 插件（plugins）
│   │   ├── 设置（settings）｜ 工作区（workspace）
│   ├── 组合层：桌面适配器（desktop-adapters）
│   └── 应用层：桌面（desktop：应用壳与编排）
├── 桌面应用（apps/desktop）
│   ├── 界面源码（src：应用壳〔组合根〕、审查台、故障台、工作台、助手、更新胶囊）
│   └── 本机壳（src-tauri：建窗、103 条命令注册、资产协议哨站、磁盘布局、错误登记处、16ms 攒批）
└── 原生箱（crates，互不依赖、不碰宿主）
    ├── 代理运行时（agent-runtime：驱动器〔连接主循环、事件路由器、kap 走访端〕、
    │                录制器、帧、运行槽位、提问、凭据、守护开关）
    ├── 持久层（persistence：线程账、运行事件账本〔回放游标〕、用量、附件、迁移脚本）
    ├── 内嵌浏览器引擎（browser）｜ 评审引擎（git：审查、变更监视）
    ├── 插件宿主（plugin-host：账本、布局、暂存区、技艺）
    └── 更新器（update：更新胶囊与差分更新）
```

**术语对照表**（批准后落进 `CONTEXT.md`，纯 glossary 无实现细节）：kap 帧投影=kap-projection｜对话转录库=transcript-store｜代理名录=agent-catalog｜进程桥=ipc｜驱动器=driver｜事件路由器=EventRouter｜录制器=recorder｜帧=frame｜运行事件账本=run_events｜线程账=threads｜运行槽位=RunSlot｜接缝=seam｜适配器=adapter｜深模块=deep module。

## 4. 外部借鉴映射（偷懒哲学：先认领已有的，再谈采纳）

- **已在仓内，禁止重复建设**：协议单一真源生成 TS 类型（contracts/kap + `ipc:generate/check` ≈ waku 协议 crate）；序列去重+回放（run_events 唯一键 ≈ waku replay cursor）；Session→消息→部分分层（threads/run_events ≈ opencode）；durable/live 双流（run_events 持久化= durable，journal.rs:23 的 16ms 攒批 Tauri event= live）——**实质已存在但未被命名**，采纳动作=记 ADR 命名，零实现改动。
- **真缺口，采纳**：CONTEXT.md 术语表（opencode 有、Poietica 无）；durable/live 命名。
- **明确不采纳**：Lody Agent Role 三层（目录+能力快照+Turn 冻结）——agent-catalog 现状无 Turn 冻结需求证据，一个实现不建接口；waku daemon 进程隔离——已有 daemon toggle，无第二进程模型证据；Lody CRDT——单机本地优先无同步需求。

## 5. 分批落地路线图（每批一次换干净、`bun run check` 独立验收）

| 批 | 内容 | 规模 | ADR |
|---|---|---|---|
| 1 | update 入 nativeCrates；ADR 0030 冲突迁号（后发者 0030-dwm → 0032 + 文件内勘误行 + README 勘误条目）；rfcs 未编号文件合规检查 | S | 否 |
| 2 | file-diff 并入 core（9 处 import 改写，删包，分层表同步） | S | 记（公开 API） |
| 3 | driver.rs 拆 event_router.rs + rest.rs（crate 内纯文件迁移） | M | 否 |
| 4 | transcript-store 单一 #commit 收敛（不拆文件） | M | 否 |
| 5 | ipc + agent 导出面收窄（先统计消费者分布再定形状） | M | 记（公开 API） |
| 6 | CONTEXT.md 落术语表 + durable/live 双流命名 | S | 记（IPC+持久化） |
| 7 | agent_setup profile/install 按 §3 判据收敛进 crate（§4 专属知识归属） | L | 记（AI 上下文） |

顺序依据：1-2 零风险先行；3/4 互不依赖可并行；5 依赖消费者统计；6 收尾命名；7 最重后置。

## 6. 批准后的执行步骤（本轮：只产出文档，不动代码）

1. 写 `docs/rfcs/0001-modular-convergence.md`：摘要 → 背景（引用宪法 §4 判据）→ 候选判定表（本计划第 1 节）→ 目标目录树两棵（第 2/3 节）→ 借鉴映射 → 路线图 → 未采纳项及理由
2. 创建 `CONTEXT.md`（仓库根，第 3 节术语表，按 domain-modeling 格式）
3. 生成 HTML 审查报告至 `%TEMP%\architecture-review-<timestamp>.html`（Tailwind CDN + Mermaid；7 张候选卡片：Files/Problem/Solution/Benefits/前后对照图/推荐强度徽章；结尾 Top recommendation = **driver.rs 拆分**，判据命中最多、证据最实、可独立验收）；`start` 打开
4. `present_files` 展示 RFC 与 HTML 报告
5. **不改任何源码/配置**；记录 workspace memory 日志

## 7. 执行时核实项与风险

- driver.rs L1768-2449 确为纯 REST 端点群（grep reqwest/async fn 复核，已验证 EventRouter/connect 行号）
- AGENTS.md 引用 FORMATS 正本位置（asset.rs vs asset_protocol.rs）是否需勘误
- mascot 消费者全量核实（决定 Speculative 是否升级）
- `docs/rfcs/thread-owns-sessions.md` 未编号的合规处理方式
- 风险：review/browser 热区冻结不动；transcript-store 只收写点不拆文件（模块头判例在先）；批次 7 涉及 Kimi 私有 state，须守 §4 专属知识归属；ADR 迁号是"永不重排"纪律的唯一豁免，须在 RFC 与 README 双处留痕
