# 重构日志

## 进度
| 步骤 | 状态 | 完成日期 | 提交 |
|---|---|---|---|
| P0.1 冻结旧代码（tag `legacy-final` + worktree `../poietica-legacy` + 分支 `rebuild`） | ✅ | 2026-10-05 | — |
| P0.2 清空新树（`.gitignore`/`.gitattributes`/`README.md`，保留 LICENSE） | ✅ | 2026-10-05 | 735c6594 |
| P0.3 截取 legacy 界面基准图 | ⏭️ 用户自行完成，执行者跳过 | — | — |
| P0.4 根 `package.json`（workspaces + catalog + 脚本） | ✅ | 2026-10-05 | |
| P0.5 `bunfig.toml` + `tooling/test/preload.ts` | ✅ | 2026-10-05 | |
| P0.6 TypeScript 六预设 + 根 `tsconfig.json` + `tsconfig.tests.json` | ✅ | 2026-10-05 | |
| P0.7 Biome | ✅ | 2026-10-05 | |
| P0.8 dependency-cruiser 规则 | ✅ | 2026-10-05 | |
| P0.9 引用同步工具 + 脚手架 | ✅ | 2026-10-05 | |
| P0.10 新 `AGENTS.md`、`docs/refactor-log.md`、`docs/ARCHITECTURE.md` | ✅ | 2026-10-05 | |
| P0.11 CI（`.github/workflows/ci.yml`） | ✅ | 2026-10-05 | |
| P0.12 阶段验收 | ✅ | 2026-10-05 | |
| P1.1 `foundation` | ✅ | 2026-10-05 | 615b3395 |
| P1.2 `contract-kit` | ✅ | 2026-10-05 | 53043f52 |
| P1.3 `rpc`（含 `./stdio`） | ✅ | 2026-10-05 | 53043f52 |
| P1.4 `transcript`（upstream 逐字节同 legacy） | ✅ | 2026-10-05 | 8a14910f |
| P1.5 `engine`（端口） | ✅ | 2026-10-05 | 8a14910f |
| P1.6 `logging` | ✅ | 2026-10-05 | 361a683d |
| P1.7 `process-kit` | ✅ | 2026-10-05 | 5f07d4bc |
| P1.8 `fs-kit` | ✅ | 2026-10-05 | 5f07d4bc |
| P1.9 `runtime-layout` | ✅ | 2026-10-05 | 5f07d4bc |
| P1.10 `storage-sqlite` | ✅ | 2026-10-05 | 5f07d4bc |
| P1.11 `git` | ✅ | 2026-10-05 | 5f07d4bc |
| P1.12 `test-kit` | ✅ | 2026-10-05 | 5f07d4bc |
| P1.13 跨传输互通测试（IO-1…IO-8） | ✅ | 2026-10-05 | |
| P1.14 阶段验收 | ✅ | 2026-10-05 | 21cffe0e，标签 `rebuild-p1` |
| P2.1 `engine-testkit`（FakeEngine + 一致性套件 13 例） | ✅ | 2026-10-05 | 71cb3259 |
| P2.2 engine-omp 包骨架与测试专用 omp 目录 | ✅ | 2026-10-05 | 5826021b |
| P2.3 bootstrap：进程模式、stdout 守卫、隔离变量、环境清洗、自检（T-ISO-1…4） | ✅ | 2026-10-05 | 31a19073 |
| P2.4 设置访问、外来 provider（13 个）、姿态 | ✅ | 2026-10-05 | 4bcd7a30 |
| P2.5 createOmpEngine 与 SessionFactory | ✅ 端到端接通 | 2026-10-05 | 3b5e87ff |
| P2.6 OmpSession、提示转换、控件 | ✅ | 2026-10-05 | 31bb7b6e |
| P2.7 交互：broker、ui-context、审批、提问、计划 | ✅（38 例，legacy 断言全迁移） | 2026-10-05 | 2c9c41c4 |
| P2.8 投影器：实时、历史、子 agent、工具展示 | ✅ | 2026-10-05 | a2e1b346 / 7682f10c |
| P2.9 端口实现：会话文件、模型、设置、技能、MCP、插件 | ✅（10 文件 + 9 测试文件，46 例） | 2026-10-05 | 2c9c41c4 |
| P2.10 工具桥、错误映射、用量 | ✅ | 2026-10-05 | d842f48c |
| P2.11 `./testing` 入口 + 一致性套件接入 OmpEngine | ✅ **13/13 全绿**（离线 mock provider，与 FakeEngine 同一套用例） | 2026-10-05 | 3b5e87ff |
| P2.11 legacy 27 个测试的去向表 | ✅ 见「P2.11 legacy 27 个测试的去向」一节 | 2026-10-05 | 08a70e66 |
| P2.11 T-ISO-5（假用户目录：完整引导后用户目录零写入） | ✅ 捕获并修掉两处真实漏洞 | 2026-10-05 | 770ba5fc |
| P2.11 legacy 测试迁移（投影器/提示/控件批次） | ✅ 12 文件，断言意图不删 | 2026-10-05 | d4901a54 |
| P3.1 `core-kernel`（module / rpc-binding / events / agent-tools / kernel / ./testing） | ✅ K-1…K-10 全绿（44 例） | 2026-10-05 | 610995b9 |
| P3.2 `host-kernel`（supervisor / rpc-hub / ipc / asset / windows / quit） | ✅ S-1…S-12 + rpc-hub 8 场景（42 例） | 2026-10-05 | 610995b9 |
| P3.3 `ui-kernel`（feature / contribution / services / react / store） | ✅ UK-1…UK-8 全绿（66 例） | 2026-10-05 | 610995b9 |
| P3.4 `design-system` 迁移 | ✅ 样式变量一个未改；导出清单按「legacy 全仓有无使用处」审查后删除 5 项 | 2026-10-05 | 610995b9 |
| P3.5 `workbench`（布局 / 命令面板 / 设置界面 / ✓ 错误边界隔离） | ✅ `workbench.test.tsx` 12 例 + fuzzy 7 例 | 2026-10-05 | 610995b9 |
| P3.6 `protocol`（appContract + PROTOCOL_VERSION=1） | ✅ T-PROTO-SNAPSHOT 通过 | 2026-10-05 | 610995b9 |
| P3.7 `apps/core`（main / serve / version / modules / build.ts / probe.ts） | ✅ `core:build` + `core:probe` 全通过（含「用户目录只有数据根」） | 2026-10-05 | 610995b9 |
| P3.8 `apps/desktop`（electron-vite 三份产物、preload、renderer、CSP 插件） | ✅ `desktop:build` 通过（main/preload/renderer 三份产物齐全） | 2026-10-05 | 610995b9 |
| P3.9 CI 追加 `core-build` 作业 | ✅ | 2026-10-05 | 610995b9 |
| P4.1 `platform`（contract / core diagnostics / host 七件套 / ui 三贡献 + 关闭拦截） | ✅ 36 例 | 2026-10-05 | 34f6b133 |
| P4.2 `preferences`（contract / prefs / uiState / keymap / ui 三设置页） | ✅ 17 例 | 2026-10-05 | 34f6b133 |

## 偏差（与架构方案不一致之处，必须写原因）
| 日期 | 位置 | 偏差 | 原因 |
|---|---|---|---|
| 2026-10-05 | `tooling/depcruise/config.cjs` | `NM` 常量由 `'(^|/)node_modules/(.+/)?'` 改为 `'node_modules/.*'` | dependency-cruiser 用 safe-regex 校验规则正则，原式被判为病态回溯而**拒绝启动**（不是规则不生效，是整份配置加载失败）。`'node_modules/.*'` 语义等价（resolution 结果是绝对路径），且通过安全检查；已用 safe-regex 逐条复核全部 40 条规则的 path/pathNot 均为 SAFE。 |
| 2026-10-05 | `tooling/refs/sync.ts` | 额外实现了一个与 biome JSON 格式化一致的序列化器（只含标量的数组写在一行） | `bun run check` 同时跑 `refs --check` 与 `biome check .`；若 references 的书写形式与 biome 不一致，两者会互相打架（写盘 → biome 判不合规 → 格式化 → refs --check 又判过期），check 永远不绿。序列化器带写盘前 `JSON.parse` 自检。 |
| 2026-10-05 | `bunfig.toml`、根 `package.json` 脚本 | 按方案原文创建，未改 | — |
| 2026-10-05 | 仓库根目录 `Project Refactoring Plan/` | 保持**不入库**（追加到 `.gitignore`） | 该目录是用户提供的重构方案（外部输入），不是产品源码；P0.2 的 `git rm -r .` 会删工作树里的未跟踪文件，故先备份到仓库外 `D:\\xiaojianc\\.poietica-refactor-plan-backup\\` 再恢复。 |

| 2026-10-05 | `packages/workbench`（外壳栅格） | **不设状态栏**：栅格为三行（页头 36px / 横幅 auto / 三列主体），删掉 06 页 §6.2 布局图里那行 StatusBar（24px）。Core 状态改到设置的「关于」页 | **用户决定**（2026-10-05）：「删除状态栏的设计，不要这个，状态栏改成设置项'关于'的其中一个 ui 就行」。06 页 §6.2 布局图、03 页 §4 的 `statusItems` 贡献点、13 页 P3 手册第 233/394/396 行都要求状态栏，本条与它们不一致 —— 按用户决定执行。`builtinPoints.statusItems` 的定义**保留**（贡献点表仍按 03 页 §4 列出，P5 的功能若要落点可直接用）。 |
| 2026-10-05 | `packages/workbench/src/parts/banners.tsx` | 「N 个功能加载失败」指示器从状态栏左端移到**横幅区** | 同上（状态栏已删）。06 页 §6.2 渲染规则表只要求「kernel.failures 非空时显示红色计数，点击弹出列表」，未指定必须住状态栏；横幅区是外壳自己的家具，比底栏更显眼。 |
## P2.11 legacy 27 个测试的去向

来源：`../poietica-legacy/packages/agent-bridge/src/__tests__/`（27 个文件，含 1 个辅助文件 `sdk-home.ts`）。

| legacy 测试 | 去向 | 说明 |
| --- | --- | --- |
| `answer-parity.test.ts` | `engine-omp/src/interactions/__tests__/questions.test.ts` | 原样迁移，7 种答复形状 + 空表 = 没答 |
| `questions.test.ts` | 同上 | 题组折叠、丢垃圾字段、号不留洞 |
| `dialog-lifecycle.test.ts` | `engine-omp/src/interactions/__tests__/broker.test.ts` | DialogDesk → InteractionBroker |
| `dialog-abort.test.ts` | 同上 | |
| `cancel-drains-dialogs.test.ts` | 同上 | cancelAll 兑现全部待答交互 |
| `interaction.test.ts` | `engine-omp/src/__tests__/conformance.test.ts`（C-INTERACTION / C-INTERACTION-EXPIRED） | 改为经 OmpSession + mock 驱动 |
| `interaction-reaches-the-dock.test.ts` | 同上 | 交互上屏由 `OmpSession.attachBroker()` 的 `interaction.upsert` 承担 |
| `projection.test.ts` | `engine-omp/src/projector/__tests__/`（快照） | 改为快照断言 |
| `screen-turns.test.ts` | 同上 | |
| `history-images.test.ts` | 同上 | |
| `live-image-attachments.test.ts` | 同上 | |
| `compaction-events.test.ts` | 同上 | 压缩标记走 `marker.upsert` |
| `skill-turn.test.ts` | 同上 | 技能轮走 `origin.payload.skillActivations` |
| `interjection-layers.test.ts` | 同上 | 插话分层走 `steeredFrame` |
| `transcript-mirror.test.ts` | `engine-omp/src/projector/__tests__/history.test.ts` | 镜像窗口机制已删，改为针对**历史分页** |
| `subagents.test.ts` | `engine-omp/src/projector/__tests__/subagents.test.ts` | 原样迁移（SubagentLedger） |
| `settings.test.ts` | `engine-omp/src/ports/__tests__/settings.test.ts` | |
| `settings-labels.test.ts` | `engine-omp/src/ports/__tests__/settings-catalog.test.ts` | |
| `settings-descriptions.test.ts` | 同上 | |
| `thinking.test.ts` | `engine-omp/src/__tests__/controls.test.ts` | |
| `outcome.test.ts` | `engine-omp/src/__tests__/errors.test.ts` | 已覆盖（`outcomeOf` 与 `toEngineError`） |
| `provider-input.test.ts` | `engine-omp/src/__tests__/prompt.test.ts` | |
| `stdout-is-a-protocol-channel.test.ts` | T-ISO-1（`engine-omp/src/__tests__/isolation.test.ts`） | 子进程夹具验证 stdout 只有帧 |
| `pty-interactive-ability-is-declared-off.test.ts` | `engine-omp/src/__tests__/isolation.test.ts` | 断言 `PI_NO_PTY=1`，`custom()` 返回 undefined |
| `share-session.test.ts` | **删除** | 分享功能不在产品范围（09 页已删除 export/share） |
| `expected-state.test.ts` | **删除** | 期望态机制已取消；其意图「未建会话也能读到默认模型和姿态」改由 `ports/__tests__/models.test.ts` 覆盖 |
| `sdk-home.ts`（辅助） | 被 `engine-omp/src/__tests__/omp-home.ts` 取代 | |

**与 legacy 行为不同的 4 处**（12 页 §12.5 第 4 条要求逐条记名）：

1. **审批选项只有两个**：legacy 的 dialog 有更多选项；现在严格识别 omp 的 `['Approve', 'Deny']`（`interactions/approval.ts`）。
2. **ask 的真实含义**：`ask` 不是「每次调用都要批准」，读类工具自动放行（`posture.ts` 的 `POSTURE_MODE` 表）。
3. **外来 provider 13 个**：legacy 是 11 个，现在按 omp 18.5.0 的 discovery 逐个核对后补到 14 个（多出 `claude-md`、`agents`、`agent-plugins`）；其中 `agents` 于 2026-10-09 按产品负责人裁决放行（见 Q32 与「外来 provider 放行」一节）。
4. **会话设置用 overlay 且会话级放行不再写全局**：legacy 把「本会话允许」写到全局并 flush，变成了「永久允许」；现在写会话设置的 override 层（`posture.ts` 的 `grantToolForSession`）。

## P2.11 验收清单执行结果（12 页 §12.5）

| # | 检查 | 结果 |
| --- | --- | --- |
| 1 | `bun test packages/engine-testkit packages/engine-omp` 全绿 | ✅ 一致性套件 13 个用例 × 2 个引擎全绿（FakeEngine 13/13、OmpEngine 13/13，离线 mock provider）；T-ISO-1…5 全绿；投影器与端口测试全绿 |
| 2 | `@oh-my-pi/` 只出现在 `packages/engine-omp/**` 与 `apps/core/scripts/**` | ✅ 除 engine-omp 外全仓无引用；depcruise 的 `omp-confined` 通过 |
| 3 | `rg "omp 知识 #" packages/engine-omp` 覆盖 #1–#16 | ✅ 27 处注释，distinct = 1…16 全覆盖 |
| 4 | `docs/refactor-log.md` 有 27 个 legacy 测试的去向表 + 4 处行为差异 | ✅ 见上两节 |
| 5 | `bun run check` 通过 | ✅ **553 tests / 0 fail**（含 12 个包的 P1 测试、engine-testkit、engine-omp、迁移后的 legacy 用例） |

## P4 手工验收执行结果（真机，CDP 读真实界面）

本机之前跑不起 `bun dev`（退出码 3 / 静默退出）。修好之后用 CDP 连进真实渲染进程逐条验收（14 页 §3）：

| # | 手工检查 | 结果 |
| --- | --- | --- |
| 1 | `bun run dev` 打开窗口、空外壳正常显示 | ✅ `[data-workbench]` 在外，标题栏 / 横幅区 / 侧栏 / 主区 / 状态栏 / 未知页面占位齐备 |
| 2 | 窗口按钮三个都可用 | ✅ `data-window-button` = minimize / maximize（`max=false`）/ close |
| 3 | 状态栏显示 Core 已就绪 | ✅ Core 为 ready 时**不显示**任何横幅（`[data-platform-banner]` 不存在） |
| 4 | 拔掉副屏后重启窗口居中 | ✅ **真机验证**：把 `window-state.json` 的坐标改成 9000,9000 后重启，窗口 rect = L143 T54 R1564 B972（居中，宽高保留），**没有**跑到屏幕外；平时关窗后坐标正常写回该文件 |
| 5 | 切换浅色/深色/跟随系统 | ✅ 外观页选 `dark` → `document.documentElement.dataset.theme` 由 light 变 dark |
| 6 | 修改快捷键并重启仍生效；恢复默认 | ✅ 快捷键页列出 11 条命令及当前按键（`workbench.commandPalette -> Ctrl+Shift+P` 等）；`keymap.set/reset` 单测覆盖 |
| 7 | 存储页数字合理 | ✅ 10 项齐全：database 48.1 KB、attachments 466.0 KB、tools 180.9 MB、kernel-cache 182.3 MB… |
| 8 | 关于页所有目录都在数据根之下 | ✅ 10 个目录（ompAgentDir / nativeHomeDir / coreCwd / dbFile / attachmentsDir / scratchDir / toolsDir / pythonDir / logsDir / chromiumSessionDir），数据根 = `%APPDATA%\Poietica Dev` |
| 9 | 结束 `poietica-core.exe`：横幅显示重连，随后消失 | ✅ 横幅实测「Agent 引擎意外退出，正在重新连接（第 1 次）」；约 1 秒后 Core 以新 pid 重新 ready，横幅自动消失，渲染进程无异常 |
| 10 | 关闭窗口后无残留进程 | ✅ 关窗 6 秒后 electron 0 个、poietica-core 0 个；host 日志 `quitting → core exited code 0 → bye` |
| 11 | 设置页齐备 | ✅ `preferences.general / preferences.appearance / preferences.keymap / platform.storage / platform.about` 五页都在 |

## 本机环境问题：`bun dev` 起不来（已修好）

用户机器上 `bun run dev` 一直是「构建成功 → starting electron app... → 退出码 3」或「窗口一闪、零日志、退出码 0」。逐层定位到**三个互相独立的原因**：前两个是代码缺陷（已修），第三个是机器上的脏目录（已在机器上修好）。

| 层 | 现象 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | electron.exe 一启动就以 3 结束（STATUS_BREAKPOINT），**stdout/stderr 全空**；加 `--no-sandbox` 就正常 | 这个终端是**管理员身份**（`Mandatory Label\High Mandatory Level`），Chromium 沙箱在这种 token 下起不来。实测 `--disable-gpu` / `--no-zygote` / `--single-process` 都救不回来 | `tooling/desktop/dev.ts` 先探测一次 `electron --version`，失败才设 electron-vite 的 `NO_SANDBOX=1`，并把原因印在终端上。默认路径不变，正常桌面仍是带沙箱启动 |
| 2 | 加了 `--no-sandbox` 后窗口一闪、**零日志**、退出码 0 | `core.ready` 都没发出来。实测 `app.requestSingleInstanceLock()` 返回 **false**（Chromium 报 `Lock file can not be created: 拒绝访问 (0x5)`），`runHostKernel` 按 06 页 §4.3 的设计调 `app.quit()` —— 而这一步在**日志目录建立之前**，所以什么都没写 | `runHostKernel` 的单实例分支补一条 stderr：区分「已有实例」与「拿不到锁」，并给出数据根路径与绕过办法 |
| 3 | 换新数据根就正常；旧数据根 `%APPDATA%\Poietica Dev` 拿不到锁 | 那个目录是 **legacy 应用与新构建产物混用**出来的（里面有 `ledger.sqlite3`、`automation.lock`、`DevToolsActivePort`、`poietica.log`、`agents.json`，owner 一度是 `BUILTIN\Administrators`）。把内容逐字节复制到**新路径**或**同名新目录**都能拿到锁 —— 即目录实体自身的问题，与内容和路径名都无关 | 在机器上把该目录改名备份到仓库外，重建同名空目录，再把 18 项内容原样搬回；复测 `lock=false → true`。**用户数据一项未丢**；`dev.ts` 同时加了检测：数据根里出现那些旧名字就打印提示与绕过办法 |

**由此暴露的产品缺陷（P3 遗留，已修）**：

1. **preload 没有外部化 electron**（`apps/desktop/electron.vite.config.ts`）。`externalizeDepsPlugin()` **只外部化 `dependencies`**，而 electron 按 13 页 §8.1 的设计在 `devDependencies`。于是 preload 产物里被打进了 npm 的 electron **安装器**，它在顶层 `require("child_process")` —— sandbox 下 preload 没有 Node 模块，直接抛 `module not found: child_process`；bridge 挂不上，渲染进程跟着抛 `preload 没有暴露 bridge`，**整个外壳渲染不出来**（现象是白窗口）。
2. **`engine.info.version` 是 undefined**。`createOmpEngine` 的选项要求 `appVersion` 与 `engineVersion`，但 `apps/core/src/serve.ts` 只传了 `{ layout, relayPort, logger }`。后果：`core.ready` 载荷里没有 `engineVersion`，strict 模式下 platform 的 `diagnostics.core` 因 `engineVersion: expected string, received undefined` 被判不符合契约而**整个方法失败**。修法是让 `engine-omp` 提供 `OMP_VERSION`，**编译期由 build.ts 注入**（运行时 `createRequire` 读 package.json 在编译成单 exe 后直接 `Cannot find module`，让 Core 反复以退出码 1 崩溃；该包也没有 exports `./package.json`，静态 import 同样解析不到）。
3. **单实例锁失败时零日志**。这是排查中最耗时的一环：现象与「崩溃」完全一样。

## P3/P4 过程中发现并修掉的真问题

| # | 问题 | 影响 |
| --- | --- | --- |
| 1 | dependency-cruiser 17.4.3 的 swc 解析器不打开 `tsx` | 只要仓库里出现一个 `.tsx`，`bun run lint` 就整体失败（不是某条规则报错，是配置加载失败）。当时用 `tooling/depcruise/swc-tsx.cjs` 打补丁。**2026-10-07 随 dependency-cruiser 升到 18.5.0 消除**：18 的 `src/extract/swc/parse.mjs` 新增 `getOptionsFor()`，对 `.tsx/.jsx` 自动带 `tsx: true`，补丁文件已删除（见本轮「依赖现代化」）。 |
| 2 | omp 官方 `compile-binary` 的两个插件在安装版布局下都不可用 | 照抄官方编译脚本会直接构建失败。已按「Poietica 不用 legacy Pi 扩展」的事实退化为空桩 + 空文档索引，并在 `core-manifest.json` 里记下 `legacyPiPlugin: 'stub'` 以便排查。 |
| 3 | 06 页 §5.3 的 UI 契约访问控制没有给内核自有的 `system` 契约留通道 | platform 的「重新启动 Core」按钮调不到 `core.restart`。已用 `SYSTEM_CONTRACT_ID` 放行内核契约。 |
| 4 | `os.tmpdir()` 在本机不可写（编出来的 exe 写普通文件即 `EPERM`，`bun:sqlite` 报 `unable to open database file`） | 探针若按方案原文把假用户目录建在 `%TEMP%` 下会永远红，而且看起来像隔离失败。已改用仓库根下的 `.probe-home/`，并逐条记录了判别依据（同一 exe 在其它路径写成功）。 |

| 5 | **加了新工作区包之后没清 Vite 的依赖预构建缓存** | P5 的五个 feature 包入库、`bun install` 已把 `packages/protocol/node_modules/@poietica/feature-*` 链好，但 Vite 缓存还是旧的：`bun dev` 起不来，反复报 `Failed to resolve import "@poietica/feature-agent-settings/contract"`。删掉 `apps/desktop/node_modules/.vite` 后正常（`electron: 4 / core: 1`、零 resolve 错误）。**以后每加一个工作区包，先清这个目录。** |
## P3 验收清单执行结果（13 页 §10）

| # | 检查 | 结果 |
| --- | --- | --- |
| 1 | K-1…K-10（core-kernel） | ✅ 全绿，另加 K-1b/K-2b/K-3b…K-4d/K-5/K-8b/K-9b 与模块图三种错误 |
| 2 | S-1…S-12（core-supervisor） | ✅ 全绿（含 S-5b 退出码 2、killNow、启动参数、stderr 落盘） |
| 3 | rpc-hub 8 个场景 | ✅ 全绿（本地处理 / 转发带 traceId / 未知方法 / Core→core 被拒 / Core→host 放行 / 通知旁听+广播 / 页面重载换对端 / 窗口销毁清理） |
| 4 | UK-1…UK-8（ui-kernel） | ✅ 全绿（含设置页读写、toasts 去重、错误边界隔离、onCoreReady 重启后重跑） |
| 5 | `workbench.test.tsx` | ✅ 空外壳各区域空状态 / 注册功能后侧栏与主区出现 / 命令面板搜索过滤与执行 / 设置页路由 / toasts / 确认框 / 功能失败计数 / 错误边界 |
| 6 | T-PROTO-SNAPSHOT | ✅ |
| 7 | `bun run core:build && bun run core:probe` | ✅ 探针 5 步全过，其中「用户目录下只有数据根」通过 |
| 8 | `bun run desktop:build` | ✅ 三份产物：`out/main/index.cjs`、`out/preload/index.cjs`、`out/renderer/{index.html,css,js}`；CSP 占位符已替换为安装版策略 |
| 9 | `bun run check` | ✅ **795 tests / 0 fail**（104 个测试文件） |
| 10 | 手工验证（`bun run dev` 打开窗口、看状态栏） | ⏳ **本环境无法执行**：electron.exe 是 GUI 程序，在本会话的沙箱里启动即崩（`Received fatal exception EXCEPTION_BREAKPOINT`，同一条命令在交互式桌面上不受影响）。构建产物已逐份核对（见 8），窗口与交互留给用户在真机上跑 `bun run dev` 验证。 |

## P4 验收清单执行结果（14 页 §3）

| # | 检查 | 结果 |
| --- | --- | --- |
| 1 | platform / preferences 的全部必测 | ✅ platform 36 例（shell 协议白名单、window-state 越界与坏文件、storage 10 项精确 + session 三项之和 + 清理、core diagnostics、横幅文案 6 档、formatBytes）+ preferences 17 例（深合并、默认值补全、坏文件改名、去抖、keymap） |
| 2 | `bun run check` 绿 | ✅ 795 tests / 0 fail |
| 3 | 手工检查（窗口按钮、位置恢复、主题、存储页、关于页、任务管理器结束 Core） | ⏳ 同上，需要真机 GUI |
| 4 | 基准界面 #1–#6 与截图一致 | ⏳ 需要真机 GUI；本阶段的界面改动只有 platform 的窗口按钮 / 横幅 / 两个设置页，样式全部走 design-system 令牌（token 一个未改） |

## 待决问题
| 编号 | 日期 | 问题 | 阻塞的步骤 | 状态 |
|---|---|---|---|---|
| Q1 | 2026-10-05 | 本机 bun 为 1.4.2，方案 P0.0 要求 1.4.0 | 无（`packageManager` 仍按方案写死 `bun@1.4.0`，1.4.2 兼容运行） | 记录 |
| Q2 | 2026-10-05 | 方案给的部分 catalog 版本已被上游更新（例：`@oh-my-pi/pi-coding-agent` 实际最新 18.6.1，方案要求锁 18.5.0；`@lydell/node-pty` 实际最新为 1.2.0-beta.15） | 无 | **部分关闭（2026-10-07）**：产品负责人指示升级并适配 `@happy-dom/global-registrator` / `croner` / `dependency-cruiser` 三项，已落地（见本轮「依赖现代化」）。`@oh-my-pi/pi-*` 仍按方案锁 18.5.0、`@lydell/node-pty` 仍取最新稳定 1.1.0，未动 |
| Q11 | 2026-10-05 | `apps/desktop` 的 `package.json` 里 `dependencies` 为空（方案 P3 时就应有 `@lydell/node-pty` 与 `electron-updater`，但它们要到 P6 的 terminal / update 功能才用得上） | 无（P6 加入功能时再填） | 记录 |
| Q12 | 2026-10-05 | P3 手册 §7.3 的探针要求「P4 之后改为调用 `diagnostics.core`」检查隔离目录 | 无（当前探针用「用户目录零泄漏」替代，同样是 P3 级结论；P4 的 diagnostics 已可用，但探针跑在 Core 尚未注册功能模块前的空壳上，改成 RPC 调用需要等 P5 的真实功能装配） | 记录：探针在「用户目录只有数据根」这一条上保持 P3 做法 |
| Q13 | 2026-10-05 | 本机无法运行 electron GUI（沙箱），因此「`bun run dev` 显示空外壳」与后续所有需要看界面的验收项都只能由用户在真机上确认 | 无（不影响自动测试与构建） | 部分解决：加了 `bun run dev:nosandbox`（见下），本机已能跑到「host ready + core ready」 |
| Q15 | 2026-10-05 | 状态栏的 Core 状态该由谁画：13 页 P3 手册第 233 行把「状态栏」列为 workbench 自己的内容、第 394/396 行的手工验收要求「状态栏显示 Core 已就绪」「状态栏显示正在重新连接」，但 03 页 §4 的 `statusItems` 贡献点表里 P3/P4 阶段没有任何贡献者（conversation 与 workspaces 的 statusItems 都在 P5） | 无 | **用户决定（2026-10-05）：删除状态栏整个设计**；Core 状态改到设置「关于」页的一格 UI。见「偏差」表第 7 条 |
| Q16 | 2026-10-05 | 16 页 §6 的基准界面 #01 `home-empty`「首页空状态」标为 P4，但该界面属于 `conversation.home` 表面、由 conversation 功能在 P5 提供（07 页 §7 的文件清单里 `home-surface.tsx` 在 conversation 下）；P4 只加 platform 与 preferences，两者都不注册任何 surface | 基准 #01 的对照要等 P5 之后 | 记录：不改 `defaultRoute`（06 页 §7 的 main.tsx 原文写的就是 `conversation.home`），P4 阶段主区按方案显示 UnknownSurface |
| Q14 | 2026-10-05 | 本会话的宿主环境里 electron.exe 只有在带 `--no-sandbox` 时才能启动（`electron.exe --version` 无开关返回 3、加 `--no-sandbox` 返回 0；`--disable-gpu`/`--no-zygote`/`--single-process` 都救不回来） | 不影响产品代码；为了让用户在**这台机器**上也能看到界面，提供了 `bun run dev:nosandbox`（等价于 electron-vite 的 `NO_SANDBOX=1`） | 记录：**默认 `bun run dev` 保持原样**，正常桌面不要用这个脚本 —— 关掉沙箱会少一层渲染进程隔离 |

## P5（2026-10-05）

| 步骤 | 状态 | 说明 |
|---|---|---|
| P5.1 workspaces（contract / core / core-api / ui / ui-api） | ✅ | 19 例：pathKey 同一路径大小写、重复添加同 id、scratch 删目录而 folder 不删、事件在删行之后、requireUsable 的两种失败 |
| P5.2 models（contract / core / ui） | ✅ core | 9 例：只记服务商名的日志、内置服务商只读、onDidChange → models.changed |
| P5.3 agent-settings（contract / core / ui） | ✅ core | 13 例：未知路径、类型不符、分组次序取 SETTING_GROUPS |
| P5.4 attachments（contract / core / core-api / host） | ✅ | 26 例：内容寻址去重、50 MB 先判后拷、回收宽限、预览协议四条 |
| P5.5 conversation core（线程 / 会话池 / 时间线通道 / 事件路由） | ✅ | CV-1…CV-12 全绿（60 例）。含 `clientTurnId` 的线上形状、epoch/seq 一致性协议 |
| P5.5 conversation ui | 🚧 | legacy `surface/**` 全树迁入（191 文件 / 38 份 CSS 逐字），数据来源已换；**模型设置页仍是近似实现** |
| P5 验收 | 🚧 | `bun run check` 932 例 / 0 失败；手工验收需要真实 API key，未做 |

### 偏差（P5 新增）

| # | 日期 | 事项 | 决定 | 理由 |
|---|---|---|---|---|
| 9 | 2026-10-05 | 内置贡献点新增 `entryNotices` | 产品负责人要求「还没有配置模型服务商」画在新对话界面的**吉祥物上方**，不占外壳栅格的一行 | 03 页 §4.4 的跨功能扩展机制；models 因此不必依赖 conversation（07 页 §0.1 的依赖表不变） |
| 10 | 2026-10-05 | `--cp-*` 度量令牌与 `.assistant-menu-surface` 从 conversation 移入 design-system | 迁 | 工作区选择器（workspaces）与输入框/时间线（conversation）共用这两样，而功能之间不得互相 import（`feature-cross-impl`）。判据与 P4 把设置词汇放进 design-system 同一条 |
| 11 | 2026-10-05 | 工作区选择器落在 `features/workspaces/src/ui-api/` | 迁 | 07 页 §3E 说选择器属于 workspaces；03 页 §4.4 说 ui-api 可导出可复用组件。会话的输入框那一行取同一个组件 |
| 12 | 2026-10-05 | `clientTurnId` 加在**线上形状**（`contract/wire.ts`）而不是 upstream | 迁 | 05 页 §12.2 要求它出现在 `turn.upsert`，而 upstream 的 `TranscriptTurn` 没有这个字段；`src/upstream/` 必须与 legacy 逐字节相同（11 页 P1.4） |
| 13 | 2026-10-05 | `SettingsPort` 增加 `groupOrder` | 迁 | 07 页 §7B 要求分组次序取 engine-omp 的 `SETTING_GROUPS`，而 `engine-omp-only-in-app` 禁止功能 import engine-omp，次序只能经引擎端口过来 |
| 14 | 2026-10-05 | conversation 侧留一份 `unified-diff.ts`（逐字迁自 review） | 迁 | 07 页 §0.2 规定 conversation 不 import review；P5 的工具卡片要能画出改动。P6 的 review 经 `toolCallRenderers` 接真后这一层退成兜底 |
| 15 | 2026-10-05 | `AgentSessionUsage.breakdown` 在 P5 恒为 null | 迁（**2026-10-07 已撤销**，见本文件末尾「输入框的上下文用量圆环不显示」一节与偏差 #51） | legacy 的构成明细由原生侧算，新引擎端口没有对应报数；屏幕退成只画总条（与 legacy「这一份报数没带构成」时的画法一致）。**当时的判断有误**：omp 自己有 `computeSessionContextBreakdown`（legacy bridge.ts 调的就是它），新引擎端口接上同一产地即可，不必退成只画总条 |
| 16 | 2026-10-05 | 关闭 Vite 开发期错误浮层 | 迁 | 它不属于产品界面语言；本仓的错误面有三层（kernel.failures 横幅 / FeatureErrorBoundary / 平台横幅），遮罩一盖全都看不见 |

## P6（2026-10-05）

| 步骤 | 状态 | 说明 |
|---|---|---|
| P6 骨架（8 个功能包 scaffold + protocol/apps 接线待做） | ✅ | extensions / automations / review / terminal / browser / python / update / usage 全部建包，refs 已同步 |
| P6.1 usage（core + ui） | ✅ | 契约 4 方法 + 1 通知；core 订阅 usageSampled、1 秒合批写 `usage_events`；UI 设置页（概览 / 26 周热力图 / 每日趋势图）自 legacy 逐字移植；US-1…US-6 全过 |
| P6.7 python（core + ui） | ✅ | 契约 3 方法 + 1 通知；core 的 release 常量 + installer（下载/边下边算 sha256/解压/验证/原子替换）+ 状态机；UI 设置页；PY-1…PY-7 全过 |
| P6.5 extensions（core + ui） | ✅ | 契约 14 方法 + 3 通知；core 全部转发引擎端口，删除技能先 `shell.trashItem` 再 `forget`；UI 三页（技能 / 插件 / MCP 服务器）；核心断言 5 例全过 |
| 其余（automations / review / terminal / browser / update） | ✅ | **2026-10-08 更新**：五个功能均已完整落地（contract / core 或 host / ui + 必测），见下面的 P6.2–P6.8 与「07 第一批/第二批整改」两节。此行原先写「只有脚手架」是当时的瞬间状态 |

### 偏差（P6 新增）

| # | 日期 | 事项 | 决定 | 理由 |
|---|---|---|---|---|
| 17 | 2026-10-05 | 新增 `features/tsconfig.json`、`packages/tsconfig.json`；`tooling/tsconfig.json` 的 include 补测试 glob | 迁 | **编辑器工程映射**：`tooling/tsconfig/*.json` 一律 exclude `__tests__`（测试要更松的规则，且不进 `tsc -b`），于是测试文件不属于任何 project，VS Code / Trae 落到 inferred project —— 那里没有 `types: ["bun"]`，每个测试文件第一行 `import { … } from 'bun:test'` 都报 TS2307。仓库自己的 `bun run check`（`tsc -p tsconfig.tests.json`）一直是好的，红的是编辑器。修法是给测试文件一个**往上找得到、且包含它**的 project：`features/tsconfig.json`（extends 根 tests 预设，include 只收 `*/src/**/__tests__/**`）。它不匹配 `refs` 的 PROJECT_PATTERNS（`features/*/src/*/tsconfig.json`），所以 refs 不会覆写它；也不被根 `tsconfig.json` 引用，`tsc -b` 不受影响。 |
| 18 | 2026-10-05 | `AttachmentIntake.import` 改名 `importPaths` | 迁 | **depcruise 假阳性**（P5 起 check 一直红的真凶）：swc 解析器把接口里的属性名 `readonly import: (…) => …` 当成动态 import，报 `not-to-unresolvable`。已用最小复现确认（同文件里把名字换成 `take` 就不报）。该名字在全仓只有这一处声明、无调用点，改名即可；deviates from legacy 的字段名，记此。 |

### 待决问题（P6 新增）

| # | 日期 | 问题 | 现状 | 处理 |
|---|---|---|---|---|
| Q21 | 2026-10-05 | `mcp.upsert` 的「新增重名 → `mcp_name_conflict`」在 Core 侧**不可达**：05 页 §11 的参数只有 `McpServerInfo`，线上没有区分「新增」与「更新」的位，而「名字已存在」恰恰就是更新 | 已按幂等 upsert 实现（同名即更新），错误码保留在契约里未删 | 按守则 11 停下这一项：等 05/07 页给出意图位（或 UI 走独立的新增方法）再接；测试改为断言幂等 |

### 待决问题（P5 新增）

| # | 日期 | 问题 | 现状 | 处理 |
|---|---|---|---|---|
| Q17 | 2026-10-05 | 模型设置页的数据模型换代 | legacy 是原生侧 catalog wire（含 `kimi`/`vertexai`/`google-genai` 三种 provider 类型与 agent-CLI 安装流程）；新契约（07 页 §6B）只有三种自定义 API 形态 | 该页待按新架构重做：删掉 catalog 导入 tab 与 agent-CLI 那一套，保留服务商列表 + key 表单 + 模型可见性 + 默认值。当前是近似实现 |
| Q18 | 2026-10-05 | 数据根残留旧版本文件 | `%APPDATA%\Poietica Dev` 里还有 `ledger.sqlite3`/`automation.lock`/`agents.json`/`settings.json`/`DevToolsActivePort`，且 `session\GPUPersistentCache` 拒绝访问 | 会在 Chromium 拿单实例锁时失败（窗口一闪、零日志）。清空该目录重建即可（新布局只要 core/omp/native-home/attachments/scratch/tools/logs/session 与三个 json） |

| Q19 | 2026-10-05 | 模型页的「默认思考强度」没有可选项来源 | 07 页 §6E 要求这一页有「默认模型与默认思考强度」；契约里 `setDefaults({thinking})` 可写、`defaults().thinking` 可读，但**档位枚举在会话的 Controls 里**（`thinkingChoices`，取值由模型决定，04 页），models 功能读不到 | 按守则 11 停下这一项：模型页先只呈现「默认模型」，思考强度等 Controls 有了跨功能的读法（或 §6E 补一句它从哪来）再补 |
| Q20 | 2026-10-05 | 输入框下方那一行的「git 分支」与「不在项目中工作」 | 分支在 07 页 §10 属 **review**（`statusItems` left order 20「当前分支名」），而 review 是 P6；`ThreadInit.workspaceId` 在 05 页是**必填**，所以 legacy 的「不在项目中工作」（projectless）在 P5 无法表达 | 分支等 P6 的 review 落地（conversation 的 `GitBranchPicker` 已在，只缺数据来源）；projectless 需要 05 页先给 `workspaceId` 可空，P5 不做 |

## P6 设置界面还原（2026-10-06）

产品负责人要求「设置界面与 legacy 原样一致」，据此做了七项改动（详见
`Project Refactoring Plan/Refactoring Progress/P6 UI 迁移与设置界面收尾进度报告.md`）。
其中两处与 07 页原文不一致，按用户的「外观以 legacy 为绝对权威」执行：

| # | 日期 | 事项 | 决定 | 理由 |
|---|---|---|---|---|
| 19 | 2026-10-06 | 删掉设置页「工作区」与「插件」 | 撤 `workspaces.list`（order 200）与 `extensions.plugins`（order 510）两条 `settingsPages` 贡献，连组件一起删（`workspaces/src/ui/settings-page.tsx`、`extensions/src/ui/plugins-settings.tsx`） | 07 页 §3E/§8C 设计了这两页，而 legacy 的 `SECTIONS` 里没有；用户要求导航与 legacy 一模一样，**legacy 是外观的绝对权威** |
| 20 | 2026-10-06 | Python 与「软件更新」由整页并入通用页 / 关于页 | 新增内置贡献点 `builtinPoints.settingsSections`（`{ id, order, page, component }`，`page` 为设置页 id 的纯字符串）；python 贡献 `page: 'preferences.general'`、update 贡献 `page: 'platform.about'`；宿主页（preferences 的通用页 / platform 的 about 页）按 `page` 过滤后用 `FeatureScope` 逐段渲染 | 07 页 §13G（Python order 600）与 §15E（软件更新 order 950）各记成一整页，而 legacy 的 `GeneralSettings` 里住着「运行时」组、`AboutSettings` 里住着「诊断与更新」组；用户要求并入。判据与偏差 9（`entryNotices`）相同：为跨功能扩展新增一个内置贡献点，**`page` 只是字符串**，所以 platform/preferences 不 import update/python 的 `ui`（守则 3 不破） |

### 待决问题（P6 设置界面新增）

| # | 日期 | 问题 | 现状 | 处理 |
|---|---|---|---|---|
| Q22 | 2026-10-06 | 设置导航的「已归档」页与通用页的「启动项 / 守护进程」组缺失 | **已归档页已裁决并落地（2026-10-07）**：产品负责人指示补到 conversation 的 ui（`conversation.archived`，`SETTINGS_GROUPS.agent`，order 710），逐字迁移 legacy 的 `ArchivedChatsSettings`，见「第二轮」§3。**「启动项 / 守护进程」组仍未决**：`preferences.general` 契约里没有 `daemon` 字段，等方案补落点 |

## P6 技能 / MCP 界面还原（2026-10-06）

用户要求「技能」与「MCP」两页与 legacy 完全一致。按新架构重写：

| 事项 | 落点 |
|---|---|
| 技能页 | `features/extensions/src/ui/skills-settings.tsx`（DOM / 类名 / 文案 / 键盘走位 / 确认框逐条照 legacy `packages/settings/src/ui/skills-settings.tsx`）+ 逐字迁入的 `skills-settings.css` |
| MCP 页 | `features/extensions/src/ui/mcp-settings.tsx` + 逐字迁入的 `mcp-settings.css` / `catalog-grid.css`；纯函数 `mcp-config.ts` 迁自 legacy 同名文件，名单与分组 `catalog.ts` 迁自 legacy `packages/extension/src/catalog/{builtin,listing}.ts` |
| 关于页 | 删掉「Agent 引擎目录（隔离证明）」整组（用户 2026-10-06 要求；`features/platform/src/ui/about-page.tsx`） |

### 偏差（P6 技能 / MCP 新增）

| # | 日期 | 事项 | 决定 | 理由 |
|---|---|---|---|---|
| 21 | 2026-10-06 | 技能来源由 legacy 的**五档**（builtin / managed / project / user / extra）收成**三档**（builtin / 本机 / 项目） | 筛选器与 `sourceOf` 只画三档；`user` 映射到这一页的「本机」 | 契约 `SkillInfo.source` 只有 `builtin` / `user` / `project`（`packages/engine/src/values.ts`）。legacy 的 `managed` 就是这里的 `user`（Poietica 装进 agent skills/ 的那一批），`extra` 在新架构里没有来源。legacy 行上的「无效」标读的是 SKILL.md 的 parse issues，契约不带这一格，因此不再出现 |
| 22 | 2026-10-06 | 技能启停 / 删除的判据改成 `source === 'user'` | 开关与「移到回收站」只对 `source === 'user'` 放开 | legacy 的判据是「有没有 directory」；契约里只有 `user` 这一类写得动盘（07 页 §8C 的 `skill_not_removable` 判据同此） |
| 23 | 2026-10-06 | 「查看 SKILL.md」落到右坞的新落点 | conversation 定义 `SkillDocumentToken`（`ui-api`）并**在第一次打开时才贡献**一个 `location: 'right'` 的面板（`conversation.skillDocument`），面板本体 `features/conversation/src/ui/components/skill-document-pane.tsx` 逐字迁自 legacy `apps/desktop/src/workbench/skill-document-pane.tsx`；extensions 经令牌把内容递过去 | legacy 的面板挂在宿主 auxiliary dock 的 `file:` pane 上（`resourceId` 跟着技能走）；新架构的 `panels` 贡献项没有动态参数，所以「看的是哪一份」悬在服务上、面板标签名固定写「技能文档」。frontmatter 的解析从 legacy 的 `yaml` 包退成行级取值（`extensions/src/ui/skill-document.ts`）：解析结果要交给 conversation 渲染，而 `yaml` 不在 ui 子入口允许的依赖表里（03 页 §5.2）；代价是块状标量（`description: |`）读成字面量 |
| 24 | 2026-10-06 | 「从文件夹安装」/「从 zip 安装」不摆在技能页上 | 走命令面板与快捷键：`extensions.installSkillFromFolder` / `extensions.installSkillFromZip`（`features/extensions/src/ui/index.tsx`） | 07 页 §8E 要求这一页有这两个入口（路径走 platform 的 `dialog.pickFolder` / `dialog.pickFiles`），而 legacy 的技能页上**没有**这两颗键（legacy 的 `installSkill` 全仓没有调用点）。用户要求设置界面与 legacy 逐像素一致，所以能力照方案补齐、页面外观照 legacy 保留 |
| 25 | 2026-10-06 | MCP 名单页的 stdio 条目直接写 `npx`，不做启动器解析 | `catalog.ts` 的 `mcpServerBody` 不再收 `launcher` 参数，写进 `mcp.json` 的 `command` 就是名单里的逻辑程序名 | legacy 在这一步经原生侧的 `launcher_resolve`（把 `npx` 换成这台机器上的绝对路径、给 `.cmd` 垫片加 `cmd.exe /c`）；新架构没有这条通道（engine 的 McpPort 只收 `McpServerInfo`），这一层不该自己造一条假的解析。与 `CatalogGrid` 的 `elsewhere` 状态同一处境：契约里没有那一格 |

### 待决问题（P6 技能 / MCP 新增）

| # | 日期 | 问题 | 现状 | 处理 |
|---|---|---|---|---|
| Q23 | 2026-10-06 | MCP 列表的「状态灯」与来源说明没有数据来源 | legacy 里每台服务器带 `origin`（用户 / 插件）与 `launchedBy`（agent / none），卡片据此写「个人 · 已启用 …」或「<插件名> · 插件已停用」，绿点读 `launchedBy !== 'none'`；契约 `McpServerInfo` 只有 `name` / `transport` / `enabled` / `config`，`McpStatus.state` 是**连接**状态（会话侧报回来）而不是「允许装载」 | 卡片说明行固定写「个人 · 已启用 · 连接状态由会话确认」/「个人 · 已停用」，绿点读 `enabled && state === 'connected'`（视觉与 legacy 同形，语义是近似）。等契约补 `origin` / `launchedBy` 后改回逐字一致 |

## P6 设置界面四项修复 + 订阅式读取缺陷（2026-10-06 第三轮）

产品负责人报告的现象与根因、落点：

| # | 现象 | 根因 | 落点 |
| --- | --- | --- | --- |
| 1 | 进入设置（位于「通用」）时左侧「通用」不高亮 | 组合根传的是 ``route.params.page ?? ''``，空串穿过 ``page ?? route.params.page`` 落到 activeId 上 → ``data-active`` 全是 false | ``packages/workbench/src/parts/settings-regions.tsx``：空串当「没指定」，回落到第一页 |
| 2 | 进入设置后底部「帮助 / 设置」两枚图标消失 | 设置那一支侧栏只渲了导航，没把 legacy 的 ``SidebarFooter settingsActive`` 接回去 | ``packages/workbench/src/workbench.tsx``：``<SettingsNavigation footer={<SidebarFooter settingsActive />} />`` |
| 3 | 选了「深色」，冷启动仍是浅色，要点一次外观页才刷新 | ``theme.changed`` 只在偏好变化/系统深浅变化时发，首帧到 Core ready 之间一条都没有，而 index.html 写死 ``data-theme="light"`` | ``features/preferences/src/ui/{theme.ts,index.tsx}``：启动与偏好到达时就地解一次（system 读 matchMedia），订阅仍保留 |
| 4 | 关于页「复制诊断信息」与存储页「打开」按钮样式与设置页其余按钮不一致 | 用的是 ``size="sm" variant="outline"``，而设置页其余动作是 ``size="xs" variant="soft"`` | ``features/platform/src/ui/{about-page.tsx,storage-page.tsx}`` |

**同一根因的一类缺陷（本轮一并修）**：组件在渲染期读 store 的一次性快照（``getState()`` 或 ``store`` 上直接取值）。
那一次渲染之后没有任何东西会让它重画。三处：

| 位置 | 现象 | 落点 |
| --- | --- | --- |
| ``features/conversation/src/ui/components/home-surface.tsx``、``index.tsx`` | 输入框下方的项目名一直显示「选择项目」，切一次页面才对；线程列表的组头空着 | 新增 ``useWorkspacesView``（``features/workspaces/src/ui-api/index.ts``），订阅式读项目名单与当前项目 |
| ``features/conversation/src/ui/index.tsx`` | 侧栏「运行中」标记停在首帧 | 新增 ``useRunningThreadIds``：选 ``byThread`` 这个**稳定引用**，集合在 ``useMemo`` 里派生 |
| ``features/conversation/src/ui/index.tsx`` | 会话页的控件表 / 线程行读快照 | 改用 ``useFeatureStore`` 订阅 |

**由此踩到并修掉的第二个缺陷**：选择器里写 ``new Set(...)`` → 每次渲染交回新集合 → ``useShallow`` 永远判「变了」→
``Maximum update depth exceeded``（内核在 ``useFeatureStoreShallow`` 的头注里警告过同一件事；本轮实际发生了一次）。
修法见上表第二条，并加了 ``features/conversation/src/ui/stores/__tests__/turn-states.test.ts`` 钉住前提。
同时修掉 ``turn-states.ts`` 的 ``set``：内容没变就不换 ``byThread`` 引用（否则同一条状态重复推送会让整棵订阅树白重画）。

**另一处：打开会话时控件表要主动拉一次**。``threads.open`` 只做后台预热、不返回控件表，表要等 Core 的
``controls.changed``；只等通知的话那排选择器（模型 / 思考 / 批准方式）在会话起来之前一直不画。
``openThread`` 现在顺手 ``stores.controls.refresh(threadId)``，通知到了再覆盖。

### 待决问题（本轮新增）

| 编号 | 日期 | 问题 | 阻塞的步骤 | 状态 |
|---|---|---|---|---|
| Q24 | 2026-10-06 | **新对话入口页没有「模型 / 批准方式」选择器**。legacy 用 agent 级控件表（``agentCapabilities({cwd})`` → ``AgentCapabilityPort``：``packages/native-bridge/src/conversation/configuration.ts`` 的 ``createAgentCapabilityBridge``）；新方案没有这一口 —— §0.1 的依赖表、§11.4 的方法表、04 页 §3.8 的端口表都没有 agent 级（threadId 之外的）控件读法，``threads.create`` 只接受 ``posture`` / ``model`` / ``thinking`` 初值 | 入口页选择器 | 按守则 11 **停下、不猜**。可选落点（等方案确认）：① conversation 契约加 ``controls.defaults``（参数 ``workspaceId``，owner core）读默认模型/姿态/思考档；② models 的 ``models.defaults`` 扩成含姿态。方案未定前入口页保持 ``controls={[]}``（与 legacy 的差异记在此） |

## P6 入口页选择器按方案定稿重做 + 文案与按钮修复（2026-10-06 第四轮）

方案（Notion §04 / §05 / §07）对入口页的定稿做法在本轮落地，**取代**上一轮我按 legacy 语义
补的 `controls.defaults`（那一口方案没有，属于自造）：

| 层 | 落点 |
| --- | --- |
| 引擎端口 | `AgentEngine.draftControls(init)`（`packages/engine/src/engine.ts`）：**只读**，不开会话、不写设置、不写文件。规则与会话里一致：可选模型来自 `registry.getAvailable()`，思考档位按当前模型给出（omp 的 `Model.thinking.efforts`，**静态可得**），默认姿态 `auto-edit` |
| omp 适配器 | `packages/engine-omp/src/engine.ts`（转发）+ `ports/draft-controls.ts`（组装：注册表 + `enabledModels` 白名单 + 模型级档位梯子）；`omp-context.ts` 的 `OmpModel` 补 `thinking.efforts` 一格 |
| 契约 | `controls.draft`（owner core，收草稿三格、回 `Controls`）+ 通知 `controls.draftChanged`（模型列表变化时推送） |
| UI | 入口页与会话页**共用同一个选择器组件**；入口页改选择只改本地草稿（`HomeSurface` 的 `DraftSelection`），发送时把选中值带进 `threads.create` 的 `ThreadInit` |
| 测试 | 引擎一致性套件加 `C-DRAFT-CONTROLS`（14 例）；`CV-13`（草稿不开会话、默认姿态 auto-edit、三格回显）、`CV-14`（选中值带进 threads.create 并交给引擎） |

### 本轮修掉的三个真实故障

| # | 现象 | 根因 | 落点 |
| --- | --- | --- | --- |
| 5 | 输入框那一排**没有批准方式**（胶囊与菜单整颗不画） | 两套词表对不上：`PermissionPicker` 与 `configuration/permission-posture.ts` 是逐字从 legacy 迁来的，认**产品值** manual / yolo / auto；而换算层原先把引擎的 ask / auto-edit / full-access 原样交过去，交集为空 → 组件按「这家 agent 不提供批准方式」返回 null | `features/conversation/src/ui/control-shapes.ts` 新增 `POSTURE_TO_CONTROL`（正向）与 `postureOfControl`（反向），会话页与入口页的下发都走它 |
| 6 | 图一：模型选择器弹层样式糟糕（圆角/内边距/阴影/面色全丢） | `session-controls.css` 缺 legacy 顶部的 `@import "../skin/metrics.css"`，以及那一整块 `.assistant-menu-surface`（几何变量 `--am-*` 的定义处）；CSS 里 `var(--am-*)` 于是解析失败 | 已确认两份 CSS 与 legacy **逐行等价**（差异只剩 `@import` 与那块已按归属搬进 `packages/design-system/src/control/menu-surface.css` 的定义），`--cp-model-*` 令牌 40 条齐全 |
| 7 | 引擎横幅「Agent 引擎意外退出，正在重新连接」应删；「需要重新启动」应改成与模型未配置同样的 UI 与位置 | 产品负责人 2026-10-06 | `features/platform/src/ui/core-banner.tsx` 删掉 restarting 与 failed 两档（横幅只剩 starting / stopped）；新增 `core-failure-notice.tsx` 贡献到 `builtinPoints.entryNotices`（与「还没有配置任何模型服务商」同形同位），样式与 `.models-banner` 一致 |

### 本轮修掉的误改（自省）

上一轮我用脚本批量编辑源码时，`features/conversation/src/ui/index.tsx` 被截断、`features/platform/src/ui/index.tsx` 被插入错误的注释块，
两处都已 `git checkout` 回退后重做。**教训**：这套仓库的源码请用逐行、可核对的编辑方式，不要用整段字符串替换脚本。

### 第五轮补充：模型胶囊「看得见」的两个必要条件（2026-10-06）

产品负责人截图：输入框那一排**只有权限胶囊、没有模型选择**。定位到两处：

| # | 问题 | 根因 | 落点 |
| --- | --- | --- | --- |
| 8 | 模型胶囊其实**渲染了但宽度塌成 0** | \`model.current\` 与 \`thinking.current\` 都是 null → \`SessionControls\` 的两个 span 都是空字符串 → 按钮量出来宽度为 0。新装机器上 \`modelRoles.default\` 还没被谁写过，所以 \`defaultModel()\` 返回 null | \`ports/draft-controls.ts\`：没有默认模型时 current 取**目录里第一条可用的**（那条会话真跑起来时 SDK 自己也会挑一条）；档位 current 取该模型自己声明的 \`thinking.defaultLevel\`。显式给了 ref 但目录里找不到时仍照原样报，不替用户换 |
| 9 | 装了 key 回到首页，那排选择器还是旧的那一份 | \`controls.draftChanged\` 定义了通知却**从未 emit** | \`features/conversation/src/core/index.ts\` 订阅 \`engine.models.onDidChange\` → \`ctx.rpc.emit('controls.draftChanged', {})\` |

顺带清掉两处上一轮的残留：\`ConversationCore.defaults()\`（\`controls.defaults\` 的旧实现，契约方法已删）整块移除，
以及它删除时留下的孤立 \`/**\`（那一段把 \`setModel\` / \`setThinking\` 的声明吞进了注释里，\`tsc\` 报 property 不存在）。

回归测试：\`packages/engine-omp/src/ports/__tests__/draft-controls.test.ts\` 七例，
其中「没有默认模型时 current 取目录里第一条可用模型（胶囊才画得出来）」直接钉住故障 8。

## P6 横幅改回通用 Banner + 删除外壳横幅行（2026-10-06 第六轮）

用户报：**退出应用时，顶部栏下方会闪现一次长方形色块，颜色 #383836**。

### 根因

`#383836` 是 `--ui-palette-dark-800`，深色主题下即 `--ui-accent`
（`packages/design-system/src/tokens/dark.css:70`）。全仓只有一处整条铺它：
`.workbench__banner--info`（外壳横幅行的底色，`packages/workbench/src/parts.css`）。

缺陷是**外观可见性与组件内容分家**：

| 谁 | 判据 |
| --- | --- |
| 外壳 BannerHost | `useVisible()` —— 只认 Core 状态（`starting` / `stopped`），为真就**挂出整行**（底色照铺满整宽） |
| 贡献的组件 CoreBanner | 同一份状态，**外加 3 秒宽限**，宽限没到返回 null（不画字） |

退出时 Core 走 `stopping` → `stopped`（`quit.ts` 的 `supervisor.stop()`），外壳按 `stopped`
立刻挂出这一行，组件却因宽限未到不画任何字 —— 窗口销毁前屏幕上只剩一条**没有字的纯
`#383836` 长方形**。启动时同一条路径也存在（首 3 秒），只是退出那一次最显眼。

### 为什么这条横幅本身也不该存在

它是**迁移时自己加的**，legacy 里没有对应物：

- legacy 的外壳栅格只有**两行**（`chrome` / `main`，`apps/desktop/src/shell/layout/workspace-shell.css:35`），
  本仓多出第三行 `banners`；
- legacy 全仓搜 `正在启动 Agent` / `core.status` **零命中** —— 「正在启动 Agent 引擎…」是新仓凭空加的；
- legacy 的横幅一律是 design-system 的通用 `Banner`（`packages/design-system/src/control/banner.tsx`，
  portal 到 body、顶部居中、滑入、自己淡出），不占栅格、不铺满整宽 —— 也就没有「空行还留着底色」这回事。
  该组件本仓**已经迁移且已导出**（`packages/design-system/src/index.ts:23`，带契约测试
  `__tests__/banner-contract.test.ts`），只是横幅没用它。

### 落点

| 层 | 改动 |
| --- | --- |
| `packages/ui-kernel` | 删 `builtinPoints.banners` 与 `BannerItem`；新增 `builtinPoints.overlays`（`OverlayItem`）—— 不占栅格、`useVisible` 为假时连包装都不挂 |
| `packages/workbench` | `parts/banners.tsx` → `parts/overlays.tsx`；栅格回到两行（与 legacy 同形）；删 `.workspace-shell__banners` 与 `.workbench__banner--*` 全部 CSS；「N 个功能加载失败」改为浮层（`position: fixed`，落在页头下方，不再压住可拖拽的标题栏） |
| `features/platform` | 「正在启动 Agent 引擎…」横幅**整条删除**（`core-banner.tsx` 与它的测试一并删）；`FAILURE_TEXT` 与 `coreFailureVisible` 迁进 `core-failure-notice.tsx`（唯一产地） |
| `features/update` | 横幅改回通用 `Banner`（与 legacy 同形）；`update-banner.css` 删除；判据函数一字未动，只补 `persistent` 一格（判据仍是 legacy 的「有没有未了的事」：downloading / ready 常驻，available 自己走） |
| 回归测试 | `workbench.test.tsx` 钉「外壳不再有横幅行」；`ui-kernel/__tests__/builtin-points.test.ts` 钉「`banners` 已不存在、`overlays` 在」；`core-failure-notice.test.ts` 承接原 `core-banner.test.ts` 的失败文案与可见性用例 |

### 删行时踩到的第二处真问题（自省）

删掉横幅行之后，栅格从三行变两行，而两条区域分隔线仍写着 `grid-area: 3 / …`（它们在旧
布局里定位到主体那一行）。两行制里 line 3 就是**末线**，起点与终点同为 3 → 跨度归零 →
真机 Chromium 实测 `getBoundingClientRect().height === 0`，两条分隔线的抓手整条消失。
legacy 的同一份 CSS 也是两行栅格，写的就是第 2 行 —— 改回 `2 / …` 即可。

happy-dom 不做布局，这类错误在原有单测里**量不出来**，所以补了文本契约测试
`packages/workbench/src/__tests__/shell-grid-contract.test.ts`：栅格行数、分隔线起始行、
浮层包装层的 `display: contents` 各一条，越界即红。

`bun run check` 全绿（1211 pass / 0 fail；含上述三条契约测试）。

### 偏差（本轮新增）

| # | 日期 | 事项 | 类型 | 原因 |
| --- | --- | --- | --- | --- |
| 21 | 2026-10-06 | 删除 `builtinPoints.banners` 与外壳的横幅栅格行 | 删（回到 legacy 形制） | 06 页 §6.2 的栅格图有横幅行，但 legacy 没有；该行是 `#383836` 色块闪现的载体，且横幅在 legacy 一律走通用 `Banner` 浮层。产品负责人 2026-10-06 明确要求删掉 |
| 22 | 2026-10-06 | 更新横幅从「栅格整行」改回通用 `Banner` | 迁（对齐 legacy） | legacy `update-banner.tsx` 用的就是 `Banner`；新仓改写成整行属于迁移偏差，一并收回 |

### 待决问题（本轮新增）

| # | 日期 | 问题 | 处理 |
| --- | --- | --- | --- |
| Q22 | 2026-10-06 | 06 页 §6.2 的栅格图仍画着横幅行，与现状（两行）不一致 | 按守则 11 记录，不擅自改设计文档；等 06 页确认后同步图与渲染规则表 |
| Q23 | 2026-10-06 | 07 页 §1E 的表格仍写「`starting` 超过 3 秒才显示『正在启动 Agent 引擎…』」 | 该档已按产品负责人要求整条删除；等 07 页同步 |

## P5/P6 对话主线真机打通（2026-10-07）

目标：**「可以实现正常的 AI 对话」**（发一句话能拿到回复）。原现象是发消息必现
`Error: 这个界面还没有接上助手会话。`。三处接线缺陷 + 采纳产品负责人的五条调整之后，
真机两条路都通了；真机跑通又暴露两处只有「第一句话落地之后」才看得见的新缺陷，一并修掉。

### 三处接线缺陷（「一句都发不出去」的根因）

| # | 位置 | 根因 | 落点 |
| --- | --- | --- | --- |
| 1 | `home-surface.tsx` → `transcript-store.ts` 的 `send` / `#interject` | 入口那一格的键是**草稿键 `''`**（号由 Core 在 `threads.create` 铸出，05 页 §11.4），而这两个入口**先取端口再提交**：`addressOf('').conversation` 取不到号，`#requirePort` 当场抛这句错 | `prepare()` 的返回从 `true/false` 改成 **`{key, port}`**（`PreparedThread`）；两个提交入口一律**先 prepare 铸号、再用交回的键与端口**落笔。草稿键上已写下的时间线条目在这一步迁到新号（`#migrate` + 别名表）。顺序与 07 页 §5E 的「迁移草稿 → 跳转 → 乐观提交」同序 |
| 2 | `ui/index.tsx` 与 `transcript-store.ts` | 端口身份被**两处**同时管：组件 `useMemo` 现建一根、store 的 `ensure(port)` 又认另一根。StrictMode 与「卸载再挂载」都会重建组件 → 下游靠对象身份判「要不要重新订阅」的判据随机失效（多一份订阅、两份事实写同一格） | 新增 **`features/conversation/src/ui/stores/session-registry.ts`**：按 `threadId` 持有，同一条对话永远交回同一个对象；`release` 在 `threads.removed` 时回收。`index.tsx` 不再缓存端口；`ensure` 收窄成「同一个对象重复 attach 什么都不做」 |
| 3 | `stores/session-port.ts` 的 `toQueued` | 队列快照的 id 填的是 `snapshot.items[0]?.id` —— 空队列时是 `''`、非空时是随手挑的一条**消息**号，两个都不是对话号 | 字段改名 **`threadId`**（与契约用词对齐），值取这条对话自己的号；`DroppedPrompt` / `RunFailed` 的 `sessionId` 一并改名。已全局搜过，没有别处从 item id 推线程归属 |

### 真机跑通后暴露的两处新缺陷

| # | 现象 | 根因 | 落点 |
| --- | --- | --- | --- |
| A | `core.log` 每次交互写一条 `request failed method:"controls.get"`（4 条 `too_small`：`model.current.provider` / `.id` / `choices[0].ref.provider` / `.id`），UI 挂「没连上 agent，点击重试」 | `wrapOmpSession` **无条件** `setModel(input.model ?? {provider:'', id:''})`。`null = 使用默认模型` 是常规路径，而这个空 ref 被写进 `modelRef`，`controls()` 把它当 `current` 报上去，`ModelRef` 的 `min(1)` 把**整份** `Controls` 退回 | `omp-session-adapter.ts`：`null` 时**不写**；补 `liveModel` / `liveThinking`（读 `session.model` / `session.thinkingLevel`），`session.ts` 的 `controls()` 改成**现读会话此刻的真相、读不到才退回构造那一份**（12 页 §7.7 的表就是这个语义） |
| B | 第一句话落地、侧栏长出第一行之后，侧栏那一段被错误边界接管（`Maximum update depth exceeded`）。列表为空时看不出来 | 侧栏选择器写成 `useFeatureStoreShallow(store, s => s.items.map(...))`：每次造新的行数组、元素也是新对象，而 zustand 的 `shallow` 比的是**数组元素**（逐项 `Object.is`）→ 每帧判「变了」 | `ui/index.tsx`：选择器改成选 **`s.items` 本身**（store 换数组才换引用），行的形状在外层 `useMemo` 派生 |
| C | 点工作区组名右侧的**加号**（或命令面板 / `Ctrl+N`）当场落一条「新对话」空线程，一句话都没有。点两下库里多两条 `title_source='pending'` 的行 | 那一格实现成 `createThread` + `openThread`（先建号再让用户说话）。legacy 的同一格是**先 `setActiveWorkspaceRoot(workspaceId)`、再打开入口表面**；号要到入口页发出第一句话时的 `prepare()` 才铸（07 页 §5E），没有预建空线程这一步 | `ui/index.tsx` 的 `newThread`：改成 `workspaces.setActive(workspaceId)`（点了名才切）+ `navigation.navigate({surface:'conversation.home'})` |

### 本轮新增的偏差

| # | 日期 | 事项 | 类型 | 原因 |
| --- | --- | --- | --- | --- |
| 26 | 2026-10-07 | 新增 `stores/session-registry.ts`（端口注册表）与 `stores/thread-entry.ts`（入口页铸号机） | 新增（07 页文件清单里没有这两个文件） | 端口身份与「号只铸一次」这两件事实此前**没有归属**：写在组件里就随组件生命周期生灭（StrictMode / 重挂载必翻车），写进 `TranscriptStore` 又会让它同时管两种事实。两台都是无 DOM 的小对象，判据可直接单测；装配留在 `ui/index.tsx` |
| 27 | 2026-10-07 | `TranscriptStore.ensure(port)` → `ensure(threadId)`；新增 `open(threadId)` / `forget(threadId)`；新增 `ThreadId` 别名表与 `#migrate` | 迁（接口换形） | 端口改由注册表持有之后，store 不该再被塞一根外部对象；`open` 补的是「打开已有对话要整读一次时间线」（新架构的 `threads.open` 只预热、不返回时间线，07 页 §5C）；`forget` 与注册表的 `release` 从同一个入口发起，避免「一边忘了一边还记得」的半状态 |
| 28 | 2026-10-07 | `PreparedThread` 新增类型；`AssistantSurface.prepare` 的签名由 `() => Promise<boolean>` 改为 `() => Promise<PreparedThread \| null>` | 迁（接口换形） | 号是 `threads.create` 那一刻才铸出来的，「号 + 端口」两样都只能在那时给；`boolean` 表达不了 |
| 29 | 2026-10-07 | `api.createThread` 补传 `thinking` | 补（契约漏透传） | 契约 `ThreadInit` 三格齐全（05 页 §11.4），UI 原先只透 `posture` / `model` —— 入口页选的思考档位静默丢掉，CV-14 钉的正是这一格 |
| 30 | 2026-10-07 | `omp-session-adapter` 在 `input.model === null` 时**不调用** `setModel` | 修（原先写的是空 ref） | 空 ref 违反 `ModelRef` 的 `min(1)`，让整份 `Controls` 被退回（缺陷 A）。`null` 的语义是「交给 SDK 挑」，不是「写一个空模型」 |
| 31 | 2026-10-07 | `OmpSessionHost` 新增 `liveModel()` / `liveThinking()`；`OmpSession.controls()` 改成 live 优先、构造值兜底 | 迁（补一口读法） | 12 页 §7.7 的表要求 model 读 `session.model`：SDK 自己挑模型 / 自己改档位时只有会话知道真相，构造入参在那一刻已经过期 |
| 32 | 2026-10-07 | `subscribeRunFailed` 在 `session-port.ts` 里不再转接装配层的 `onRunFailed` | 收（去掉第二个失败来源） | 「Core 掉线」由内核的 `CoreStatus` 报（订阅它要 `CoreStatusToken`，只有装配层拿得到），而「这一轮结束了」在 `turns.state`；端口这一层凭空编第二个失败来源只会让同一件事写两遍 |
| 33 | 2026-10-07 | 侧栏线程列表的选择器改选 `s.items` 本身，行形状在外层 `useMemo` 派生 | 修（缺陷 B） | 选择器里 `map` 出对象数组时，`useShallow` 的逐项 `Object.is` 永远判「变了」 |
| 34 | 2026-10-07 | `newThread` 由「建线程 + 打开它」改为「切工作区 + 导航到入口页」 | 修（缺陷 C，回到 legacy 形制） | legacy 的 `assistant-sidebar-panel.tsx` 的 `create` 做的正是 setActiveWorkspaceRoot + openAssistantSurface；号一律由入口页的 `prepare()` 铸。产品负责人 2026-10-07 明确「点击加号图标应该出现的是带着对应工作区的『新建对话』界面」 |

### 待决问题（本轮新增）

| # | 日期 | 问题 | 处理 |
| --- | --- | --- | --- |
| Q25 | 2026-10-07 | 缺陷 B 的回归测试落在 `apps/desktop/src/renderer/__tests__/thread-list-selector.test.tsx`，而不是 conversation 功能自己的测试目录 | 按守则 11 记录：要钉的那段选择器住在 `features/conversation/src/ui/index.tsx`，而它依赖 `@poietica/workbench` 的 `Workbench` / `workbenchFeature` 才能挂起来 —— workbench 不是 conversation 的依赖，功能自己包不出这个测试。等方案给「功能装配层怎么测」的落点（16 页 §4 的三类测试没有这一类）再搬 |
| Q26 | 2026-10-07 | `ConversationStores.composerFor()` 的 `submitNewThread()`（`ui/stores/index.ts:112`）是缺陷 C 的**同一个形状**（`createThread` 再 `restore` 草稿再 submit），但全仓**零调用点**（`rg submitNewThread` 只有声明与实现） | 按守则 11 记录、这一轮**不删**（它不在缺陷 C 的路径上，删它属于顺手改无关代码）。07 页 §5E 的 `ComposerDraft` 只有 `submit()` 一格，没有「新建线程并提交」—— 等入口页那条路定型后确认它是迁移残留，再整块删掉 |

## 目标架构符合性审查与整改（2026-10-07）

对照 02、03 两页做了 60 条逐条取证（报告：`Project Refactoring Plan/Refactoring Progress/目标架构符合性审查进度报告.md`）。
本节记本轮**已修**的部分与**待你裁决**的两项。审查脚本是临时文件，跑完即删，仓库里没有残留。

### 已修（都有方案明文依据，无需新设计）

| # | 事项 | 落点 | 依据 |
| --- | --- | --- | --- |
| 35 | **`omp-confined` 规则此前从未生效**（铁律 2 没有自动闸门） | `tooling/depcruise/config.cjs`：`exclude` 去掉 `dist`，改由 `doNotFollow` 收 `node_modules` / `dist` / `vendor`；两个选项的分工写进注释 | 03 页 §9 的规则表要求这条闸门生效。根因：`@oh-my-pi/*` 的 `types` 条件指向它自己的 `dist/types/`，被 `exclude` 删掉节点后 `valid: false`，规则静默失效（实测：修前全仓 0 条 `@oh-my-pi` 边、修后 29 条） |
| 36 | 新增 `tooling/depcruise/__tests__/config.test.ts`（4 例） | 同上 | 把这个「静默失效」类别钉死：`exclude` 不得含 `dist`、`doNotFollow` 必须含三者、`omp-confined` 规则的例外段不得被改宽 |
| 37 | `features/extensions/src/contract/tsconfig.json` 的预设由 `base` 改回 `neutral` | 同上 | 03 页 §3.2 表格（`contract` 子入口 = neutral）；其余 14 个功能本来就是 neutral |
| 38 | 5 处 `core` / `host` 的业务错误改成 `AppError`（共 9 个抛点） | `attachments/core/service.ts`（1）、`extensions/core/index.ts`（2）、`python/core/index.ts`（1）、`python/core/installer.ts`（3）、`browser/host/relay-client.ts`（2） | 铁律 5 + 09 页 §4 第 5 条。原先把**错误码当字符串**塞进 `Error`（`throw new Error('python.busy')`、`'extensions.skill_not_found'`…），`toAppError` 会把它们一律折成 `kernel.internal` |
| 39 | `python/core/index.ts` 的失败码不再从 message 切前缀 | 同上 | 上一条的对偶：`installer` 既然抛 `AppError`，这里就按 `e.code` 取，不再 `message.split(':')[0]` |
| 40 | `features/extensions/src/core/__tests__/extensions.test.ts` 的断言由 `String(err)).toContain('extensions…')` 改成 `code === 'extensions.skill_not_removable'` | 同上 | 原断言只要求「码出现在文本里」，正是错误码当字符串的那种形状；**断言意图（拒绝删内置技能）不变，只换判据** |
| 41 | 删除 `apps/desktop/package.json` 的 `dev:nosandbox` 脚本 | 同上 | 它指向不存在的 `tooling/desktop/dev-nosandbox.ts`（已被 `tooling/desktop/dev.ts` 取代：`bun run dev` 自己探测沙箱）。**`bun run dev` 本身没有改动** |
| 42 | `packages/workbench/src/parts/sidebar-footer.tsx`：「开发者工具」不再执行两次 | 同上 | 点一下会开两个 DevTools（`SidebarFooter` 传的回调执行一次、`HelpMenu` 内部又执行一次）。现在只在 `HelpMenu` 里执行 |
| 43 | `packages/workbench/src/__tests__/workbench.test.tsx` 新增 1 例：该命令**只执行一次** | 同上 | 已确认它在旧代码上失败、在新代码上通过 |

### 待裁决（按守则 12 停下，不猜）

| # | 日期 | 问题 | 现状 | 处理 |
| --- | --- | --- | --- | --- |
| Q27 | 2026-10-07 | `apps/core/src/serve.ts` 第 5 步 `await import('@oh-my-pi/pi-utils')` **与 03 页 §9 的 `omp-confined` 规则抵触** | **已裁决并落地（2026-10-07）**：产品负责人选了「以 03 页为准」—— `apps/core` 不再出现任何 `@oh-my-pi/*`。触发 `.env` 加载的那次导入移进 `engine-omp` 的 `launchEnv.scrubInjected()` 第一行，顺序仍是「先触发加载、再清洗」；04/12/03 三页的对应小节同步改写 | 已关闭 |

## 目标架构符合性审查第二轮（2026-10-07）

按产品负责人的裁决与本轮指示完成三项：**F2 收口、设置导航分段、错误三类判定**。

### 1. F2 收口（03 页 §9 为准）

| 落点 | 改动 |
| --- | --- |
| `apps/core/src/serve.ts` | 删掉第 5 步的 `await import('@oh-my-pi/pi-utils')`，步骤编号顺延（原 6/7 → 5/6） |
| `packages/engine-omp/src/bootstrap/launch-env.ts` | `scrubInjected()` 第一行改为 `await import('@oh-my-pi/pi-utils')`（触发 `.env` 加载），注释写明「这次导入只能写在这里」 |
| `tooling/depcruise/config.cjs` | F1 的闸门修好后立刻抓到这一条；改完即 0 违规 |

T-ISO-4（`.env` 注入被清掉）在新顺序下仍然通过；`bun run lint` 回到 exit 0。

### 2. 设置导航分段（06 页 §6.2 / §6.3）

外壳不再硬编码任何 `@poietica/feature-*` 的设置页 id（偏差表里那条自造分组表的做法作废）。

| 层 | 落点 |
| --- | --- |
| ui-kernel | 新增贡献点 `settingsGroups`（`SettingsGroupItem { id, order }`）；`SettingsPageItem` 增 `group` 字段；导出常量 `SETTINGS_GROUPS = { app, agent, system }` |
| workbench | `workbenchFeature` 贡献三段（app 100 / agent 200 / system 900）；`settings-regions.tsx` 删掉硬编码的 `SECTION_GROUPS`，改由 `groupSettingsPages()` 按贡献点分段（段内按页 order、空段不渲染、未知 group 进末尾兜底段并记一条 warn、缺省选第一段第一页） |
| 各功能 | 12 个设置页各自声明 `group`；段内 order 按 legacy 的相对次序修正：快捷键 800 → **530**、电脑控制 820 → **540** |
| 测试 | `workbench.test.tsx` 增 13 页 §6 要求的用例：2 段 + 4 页（1 页 group 未注册）→ 3 个 `settings-nav__items`、段内按 order、兜底段在最后 |

### 3. 「已归档」页（方案缺口，按指示补进 conversation）

07 页从未给这一页落点（原 Q22）。按产品负责人 2026-10-07 的指示补到 conversation 的 ui，
**逐字迁移** legacy `packages/settings/src/ui/surface/archived-chats-settings.tsx` 与同名 CSS：
页 / 组 / 行结构、文案、类名、两条确认文案、筛选与「全部删除」的禁用判据一字未改，
`archived-page.css` 逐字照抄 legacy。只换数据来路：

| legacy | 新架构 |
| --- | --- |
| `threads.subscribe` / `archivedSnapshot` | `api.listThreads({includeArchived:true})` 过滤 `archived` + 订阅 `stores.threads.store` 重拉 |
| `threads.archive(id,false)` | `api.setArchived(id,false)` → `stores.threads.upsert` |
| `threads.remove(id)` | `api.deleteThread(id)` → `stores.threads.remove` |
| `groupByWorkspace(items)` | 同一个函数，组名改从工作区表查（线程带的是工作区 id，不是路径） |

注册为 `conversation.archived`（`SETTINGS_GROUPS.agent`，order 710，图标 `Archive`），
段内次序照 legacy：… 用量 700 → 已归档 710 → 存储 900。

### 4. 错误三类判定（铁律 5 的口径；产品负责人 2026-10-07 定）

| 类 | 怎么认 | 怎么写 |
| --- | --- | --- |
| A 业务错误 | 会跨 RPC 边界，或最后会弹成 toast / 界面提示 | `AppError(<feature>Errors.xxx, 文案)` |
| B 程序不变量 | 代码写对了就「不可能发生」（越界、缺 Context、switch 到不该到的分支） | `invariant(cond,msg)` / `assertNever(x)`，内部抛 `InvariantError` |
| C 表单校验 | 用户输入不合法，要在字段旁提示 | **不抛异常**，返回 `{ ok: false, message }` |

硬规则：**用错误码当 `Error` 的 message**（`new Error('python.busy')`）一律算 A 类。

| 改动 | 落点 |
| --- | --- |
| foundation 新增 `InvariantError` / `invariant()`；`assertNever` 改抛 `InvariantError` | `packages/foundation/src/assert.ts` |
| A 类（改 `AppError`） | `attachments/core/service.ts`、`extensions/core/index.ts`、`python/core/{index,installer}.ts`、`browser/host/relay-client.ts`（中文消息经 `rpcResult` 回给 omp → 用户可见，评 A；新增 `browser.relay_tab_missing` / `relay_address_rejected`）、`conversation/ui/transcript/transcript-store.ts`（新增 `conversation.thread_start_failed`） |
| B 类（改 `invariant` / `InvariantError`） | 22 个文件、56 处（transcript 副本与 store、context 守卫、mascot、diagram、review store/derive、automations 等） |
| C 类（改返回值） | `extensions/ui/mcp-config.ts` 的 12 条校验：`validateMcpEntry` / `parseMcpImport` / `mcpEntryFromForm` 返回 `McpValidation<T>`，`mcp-settings.tsx` 的两个调用点改读 `{ ok, message }`；中文文案一字未改 |
| 防回潮（闸门 1） | 新增 `tooling/checks/no-raw-errors.ts`（扫 `features/**` 的 `new Error(` / `new AggregateError(` / `throw '…'`，测试文件豁免），接进 `bun run lint` |
| 防回潮（闸门 2） | `packages/rpc/src/peer.ts`：非 AppError 折成 `kernel.internal` 时把原始 `stack` 一并写进日志；`core-kernel` 新增 K-11 / K-11b 两条测试钉住它 |
| 防回潮（口径） | 09 页 §4 第 5 条补上三类的说明（方案侧同步） |

**验证**：`bun run check` ✅ **1251 pass / 0 fail**（160 文件）；`bun run lint` exit 0
（biome + `no-raw-errors` + depcruise 0 违规）；`bun run typecheck` exit 0。

## 依赖现代化：三项升级与适配（2026-10-07）

产品负责人指示：`@happy-dom/global-registrator`、`croner`、`dependency-cruiser` 升级到最新稳定版并完成适配。
范围只有这三项（`@oh-my-pi/pi-*` 仍按方案锁 18.5.0，`@lydell/node-pty` 仍取最新稳定 1.1.0，两者未动）。

### 升级后的版本

| 包 | 升级前 | 升级后 | 依据 |
| --- | --- | --- | --- |
| `@happy-dom/global-registrator` | 18.0.1 | **20.14.5** | 跨两个主版本（19、20） |
| `croner` | 9.1.0 | **10.0.1** | 主版本，含两项破坏性变更 |
| `dependency-cruiser` | 17.4.3 | **18.5.0** | 主版本 |

三处都只改根 `package.json` 的 catalog（铁律 9），子包一律 `catalog:`，无需改动。

### 1. croner 9 → 10（`features/automations/src/core/schedule.ts`）

croner 10.0.0 的破坏性变更里有两项落在这个文件上：

| 变更 | 影响 | 适配 |
| --- | --- | --- |
| `legacyMode` 更名为 `domAndDow`（旧名仍可用） | 无行为变化 | 改用新名 `domAndDow: false`，并把「已实测两边结果逐字相同（7 表达式 × 4 时区 × 4 时刻）」写进注释 |
| `0/10` 这类「数字前缀 + 步进」由默认可接受改为语法错误，需 `sloppyRanges: true` | **会破坏既有用例**：`preview('0/10 * * * *', …).problem` 原本是 `null`，升级后变 `unreadable` | 打开 `sloppyRanges: true`，恢复 legacy 的 crontab 写法 |
| `?` 由「替换当前时间」改为通配符别名（同 `*`） | **无影响**：本模块在进 croner 之前就把含 `?` 的表达式判为 `unreadable`（legacy 规则），这条变更到不了 croner | 不改 |

**顺带修好的遗留偏差**：croner 10 修了 DST 相关缺陷（上游 Issue #284/#285），秋季回拨那一夜当地 `02:30` 从
「取第二次（01:30Z）」改回「取第一次（00:30Z）」—— **与 legacy 的 Rust croner 逐字一致**。于是 `schedule.test.ts`
里那条原本记录偏差的断言从 `2025-10-26T01:30:00.000Z` 改成 `2025-10-26T00:30:00.000Z`，注释同步改写为
「此处与 legacy 相同，不再是偏差」。春季跳变与 America/New_York 两处落点未变，仍是已知偏差（两侧都是
「这一天照跑一次」，只是落点不同）。

### 2. `@happy-dom/global-registrator` 18 → 20

全部用法只有一处：`tooling/test/preload.ts` 的 `GlobalRegistrator.register({ url, width, height })`。
逐字比对 18.0.1 与 20.14.5 的 `lib/GlobalRegistrator.d.ts`：`register(options?: { width?, height?, url?, settings? })`
与 `unregister()` 的签名完全一致，**调用点不需要改**。适配的实质是回归验证：全仓 UI 测试（design-system /
ui-kernel / workbench / conversation / preferences / terminal / browser / review 都跑在 happy-dom 上）在新版下全绿。

### 3. dependency-cruiser 17 → 18：删掉 swc-tsx.cjs 补丁

`tooling/depcruise/swc-tsx.cjs` 是为 17.4.3 打的补丁（见上文「P3/P4 真问题」第 1 条）。18.5.0 的
`src/extract/swc/parse.mjs` 新增 `getOptionsFor(pFileName)`，对 `.tsx/.jsx` 自动追加 `tsx: true`，补丁失去意义：

| 落点 | 改动 |
| --- | --- |
| `tooling/depcruise/swc-tsx.cjs` | **删除** |
| `tooling/depcruise/config.cjs` | 删掉 `require('./swc-tsx.cjs')`，注释改写为「18 已自带，补丁与 shim 均已删除」 |

（不新增测试：这是删除一个已无必要的本地补丁，不是新增行为，方案里也没有对应条款。）

**效果等价性已验证**：同一棵树上，17.4.3 与 18.5.0 都报 `0 violations / 1015 modules / 3295 dependencies`；
用 JSON 输出逐条核对——仓库里 835 个 `.ts/.tsx` 文件 **0 个**缺席依赖图，`@oh-my-pi` 边 45 条仍在
（`omp-confined` 闸门依旧有效），`couldNotResolve` 为 0。

**保留的一条告警（不修）**：18.5.0 会打
`missing-typescript-transpiler: … (typescript: >=2.0.0 <7.0.0) … Support for typescript@>=7 will follow`。
根因是仓库用 TypeScript 7.0.2（比 18.5.0 声明的上限更新），而本地用的是 `parser: 'swc'` —— **TypeScript
解析器根本没参与跑图**（上面 835/835 的覆盖已实测证明）。降级 TypeScript 有悖「用最新稳定版」，
压制告警又要盖掉一条与事实不符的提示，故按现状保留并在此记录：它是环境自检的保守估计，不是本次升级的缺陷。

### 验证

| 检查 | 结果 |
| --- | --- |
| `bun run check` | ✅ **1252 pass / 0 fail**（162 文件 / 3 snapshots / 4095 断言），exit 0（与升级前的 1252 完全一致，无测试增减） |
| `bun run lint` | ✅ exit 0（biome + `no-raw-errors` + depcruise 0 违规） |
| depcruise 图完整性 | ✅ 835/835 个 `.ts/.tsx` 在图中；`@oh-my-pi` 边 45 条；`couldNotResolve` 0 |
| croner 选项等价性 | ✅ `legacyMode: true` 与 `domAndDow: false` 在 7 表达式 × 4 时区 × 4 时刻上结果完全一致 |

## 04 页（引擎端口 / omp 适配器 / 隔离）符合性审查与整改（2026-10-07）

对照 04 页逐条取证（代码检索 + 可执行探针 + 现成验收命令），判出 **6 项不符**，
全部按方案原文改掉并各留回归用例。完整报告：
`Project Refactoring Plan/Refactoring Progress/04 引擎端口与隔离 符合性审查与整改进度报告.md`。

### 本轮修掉的（都有方案明文，无需新设计）

| # | 事项 | 落点 | 依据 |
| --- | --- | --- | --- |
| 44 | **外来 provider 从未真正被禁用**：`createOmpEngine` 缺 04 §3.7 第 2 步的 `initializeWithSettings(root)`。`disableProvider` 写的是「当前绑定的 Settings」，没绑定时只进进程级集合，**第一条会话建起来就被覆盖** —— 实测开会话前 `getDisabledProviders()` 是 `[]`，假用户目录里的 `~/.claude` / `~/.agents` 技能会被读进来 | `create-engine.ts`：`Settings.init()` 之后补 `initializeWithSettings(root)`；`foreign-providers.ts`：改写设置值 → **调用 omp 的 `disableProvider`** | 04 §3.7 第 2–3 步 + §3.3 第 9 条。新增 **T-ISO-6**（子进程夹具 `fixtures/foreign-providers-run.ts`）；把修复回退后该用例当场红 |
| 45 | **技能只把名字发给模型**：`skillPromptOf` 校验存在性后 `return name`，`buildSkillPromptMessage` 全仓零调用 —— SKILL.md 正文 / `[Skill directory: …]` / `{{userArgs}}` 一个都没进上下文 | `prompt.ts` 拆出 `expandSkillMessage`（异步、读 SKILL.md）；`omp-session-adapter.ts` 走官方 `buildSkillPromptMessage`；`session.skills` 形状补 `filePath` / `baseDir`；插话路共用同一份并带上原图片 | 04 §3.11 + 12 §7.6（迁移 legacy `expandSkills` / `customSkillMessage`）。新增「技能投出去的是 SKILL.md 的正文，不是技能名」 |
| 46 | **发出去的图片没有来源标记**：没有调用 `tagImageAttachmentSource`，SDK 不会注入 image-attachment 伴生消息，agent 拿不到落盘路径 | `prompt.ts` 产出带标记的 `imageContents`，turn 与 steer / followUp 共用 | 04 §3.11 + 12 §7.6（迁移 legacy `bridge.ts` 2204 行）。新增「交出去的图片带着落盘路径标记」 |
| 47 | **模型解析没校验凭据**：只 `registry.find`，未要求 `hasConfiguredAuth(model)` | `create-engine.ts` 的 `resolveModel` 补判定；解不出仍交给 SDK 兜底 | 12 §6.3 第 3 步 |
| 48 | **MCP 状态永远报空**：`ompPorts` 给 `OmpMcpPort` 传的是 `new Set()`，与引擎的活会话表无关 | `create-engine.ts` 建共享 `liveSessions`；`wrapSession` 开会话登记、dispose 摘掉，两端各触发一次 `refreshStatus()` | 12 §3.14「状态从活会话的 mcpManager 汇总」。新增 `__tests__/mcp-sessions.test.ts` |
| 49 | **`auto_retry_start` / `auto_retry_end` 没有上屏**：服务商抖动时的重试在时间线上零字节，看起来像卡死 | `omp-session-adapter.ts` 两支都接上，起 warning、终 info/error | 12 §9.1 的事件分派表。新增 `__tests__/auto-retry.test.ts` 两例 |

### 待决问题（本轮新增；Q28 / Q29 同日已由产品负责人裁决，见下节）

| # | 日期 | 问题 | 处理 |
| --- | --- | --- | --- |
| Q28 | 2026-10-07 | `OmpSession.media(fileId)` 恒抛 `kernel.not_found`：12 §7.8 要求按 fileId 找图片块，但新架构的附件已改成 `attachment.upsert` 的 **data URL 内联**（实时与历史两条路都是），**没有任何 op 会带 fileId** —— 这个方法的输入在新设计里不存在 | 按守则 11 停下。两条出路都会动 04 页端口定义与 05 页契约（**删掉**该端口方法连同 `timeline.media`，或**把附件改回引用制**），属设计决定，等裁决。**已裁决：删掉该端口方法连同 `timeline.media`，图片只走内联**（见下节第 1 条） |
| Q29 | 2026-10-07 | `setPlanMode` / `setGoal` 只改本地一档并 emit controls，**没有**接 omp 的 `setPlanModeState` / `setPlanProposalHandler` / `goalRuntime`；`interactions/plan.ts` 目前只被单测引用；UI 侧也还没有这两个选择器的调用点 | 按守则 11 停下。接法在 legacy 里明确，但新架构把计划审批定成 `kind:'plan'` 卡片（04 §3.12）而 legacy 走授权闸门那张选项表 —— 卡片形状、批准后如何退出计划模式、目标模式的语义都要方案先定一版。**已裁决：按 legacy 接 omp，审批用 `kind:'plan'` 卡片**（见下节第 2 条） |

## 计划模式 / 目标模式接线与 `media(fileId)` 收口（2026-10-07）

产品负责人就上节 Q28 / Q29 各定一版，本节记两件的落地与验收。

### 1. Q28 裁决：删掉 `media(fileId)`，图片只走内联

**定论**：时间线里的图片只有一种表示 —— `attachment.upsert` 里内联的 data URL；实时投影与历史投影都按这一条处理。

落点（04 / 05 / 07 / 12 页各一处，连同为它写的那条取值路径一起删）：

| 页 | 落点 | 改动 |
| --- | --- | --- |
| 04 页端口 | `packages/engine/src/session.ts` 的 `EngineSession.media(fileId)` | 删 |
| 05 页契约 | `features/conversation/src/contract/index.ts` 的 `timeline.media` | 删。**破坏性变更**（删除方法）→ `PROTOCOL_VERSION` 1 → 2，`contract.snapshot.json` 重生成 |
| 07 页处理器表 | `core/handlers.ts` 的 `timeline.media` 注册、`ui/api.ts` 的 `media()`、`ui/agent/transcript.ts` 的 `readMedia` 端口 | 删 |
| 12 §7.8 | `OmpSession.media`（恒抛 `kernel.not_found` 的那一支） | 删 |
| 投影器 | `ui/transcript/transcript-projector.ts` 的 `needsMediaFetch` / media 表 / `TURN_PROJECTIONS` 里的 media 判据 | 删；`imageUrlOf` 只认内联 data URL，给不出像素的（例如只带元数据的条目）如实留在占位 |

**为什么不再改回引用制**（当时的另一条出路）：

1. omp 写会话文件时已把图片外置到它自己的 blob 存储（`blob:sha256:…`），磁盘不会膨胀；
2. 会话加载进内存后，消息里的图片本来就是解析好的 base64，内联不必再取一次字节；
3. 引用制要为**不在附件库里的图片**（工具截图那类）单开一条取字节通道并管它们的生命周期 —— 附件库超过 24 小时回收，历史图片会断链。代价大，收益只是包体积变小。

`packages/transcript/src/upstream/` 里的 `source: { kind: 'session_media', fileId }` **原样保留**：那是上游模型（P1.4 要求与 legacy 逐字节相同）。新引擎不再产出它，投影器也不再为它取字节。

### 2. Q29 裁决：计划 / 目标按 legacy 接 omp，审批用 `kind:'plan'` 卡片

**进计划模式**（`plan-goal.ts` 的 `applyPlanMode`，照搬 legacy `selectPlan` 与 omp 自带 ACP 宿主的次序）：记下当前活动工具集 → `setPlanModeState({ enabled:true, planFilePath: 旧值 ?? 'local://PLAN.md', workflow: 旧值 ?? 'parallel', reentry })` → 工具集收成只读（摘 `bash` / `eval` / `task`，留 `write`）→ `setPlanProposalHandler(title => proposePlan(title))` → 正在流式输出时 `sendPlanModeContext({ deliverAs:'steer' })` → 会话补发一次 `controls`。

**次序是硬要求**：状态必须先落再改工具集 —— omp 按 `planModeEnabled()` 判 `write` 该不该留，反过来 `write` 会在计算工具集时不被认成计划模式要用，模型写不了计划文件。

**proposePlan**：走 omp 的 `resolveApprovedPlan`（`localProtocolOptions` 由 sessionManager 的 artifactsDir + sessionId 构造），配合 `readPlanFile` / `listPlanFiles` 一次解出**路径、正文、标题**；正文既画卡片也交给 autosave，只读一遍。卡片形状 `{ kind:'plan', title, planFilePath, planMarkdown }` —— 04 页的 `Interaction` 为此新增 `planFilePath`（批准前人要看得见这篇计划落在哪）。

**四种答复**：

| 答复 | 卡片状态 | 引擎动作 | 交回模型的工具结果 |
| --- | --- | --- | --- |
| approve | approved | `setPlanReferencePath(path)` → 处理器置 null → `setPlanModeState(undefined)` → 还原工具集 → `autosaveApprovedPlan`（失败只记 warn）→ 补发 `controls` | 计划已确认：`<path>`。按它执行。 |
| revise（带 feedback） | answered | 留在计划模式；路径变了把 `planFilePath` 写回计划状态 | 计划未获批准：`<path>`。用户意见：`<feedback>`。修改计划文件后重新提交。 |
| reject | rejected | 留在计划模式 | 计划被否决：`<path>`。不要执行，也不要重新提交，等待用户指示。 |
| dismiss（超时 / 中止 / 取消） | cancelled | 同 reject | 同 reject |

**批准后怎么退出计划模式**：这次批准就发生在 `write xd://propose` 那次工具调用里，工具结果一返回模型即带着**已还原的**完整工具集在同一轮继续跑，不需要用户再发一句话；模式选择器跟着那一次 `controls` 事件变回「直接执行」—— 模式是在工具调用里变的，不补发事件 UI 就不会跟着变。

**setPlanMode(false)**：待答的计划卡片先按 dismiss 兑现（不兑现那次 `broker.ask` 永远没人结，模型等工具结果、屏幕等一个再也不会来的点击），再处理器置 null → 状态清掉 → 还原工具集。

**setGoal**（照搬 legacy `selectGoal`）：`null` → `goalRuntime.dropGoal()` + `setGoalModeState(undefined)`；字符串 → 契约层 `z.string().trim().min(1)` 先校验 → 把 `goal` 工具加回活动集 → 按情况 `createGoal` / `replaceGoal`（同一目标暂停时 `resumeGoal`，不重建）→ `setGoalModeState` → 正在流式输出时 `sendGoalModeContext({ deliverAs:'steer' })`。omp 的 `goal_updated` 事件触发一次 `controls`；目标状态为 `dropped` 时 `goal` 报 `null`。

**可用性**：`Controls` 新增 `available: { plan, goal }`，取值来自 agent 设置的 `plan.enabled` / `goal.enabled`，每次 `controls()` 现读（`draftControls` 同此，C-DRAFT-CONTROLS 的期望值跟着更新）。不可用时 UI 整颗不画该选择器；引擎侧调用分别抛新增的 `engine.plan_unavailable` / `engine.goal_unavailable`。

**UI 调用点**：计划点了就 `controls.setPlanMode`；新线程在草稿阶段只记本地，`openSession`（铸号）之后、`submit` 之前补调一次。目标沿用「发送时生效」：未激活时打开开关只改本地、面板把那行画成待提交，发送时先 `setGoal(text)` 再 `submit(text)`；**已激活时关掉开关立即 `setGoal(null)`**（那一档不需要正文，等下一句才收等于开关失灵）。

**卡片形状**（沿用授权卡片的外框与按钮，文案照 legacy）：标题「计划待批准：`<title>`」、副行 `planFilePath`、正文 `planMarkdown` 用现有 Markdown 渲染器且**默认折叠**（`<details>`，限高滚动）、按钮「批准 / 修改…（展开反馈输入框）/ 否决」，答过之后三颗按钮让位给「已批准 / 已要求修改：`<feedback>` / 已否决」。`plan-dock.css` 与授权卡片共用 `assistant-approval` 外框，只补竖排、正文块、反馈框与终态那一行。

### 3. 本轮补掉的两处真实缺陷（写回归用例时当场暴露）

| # | 缺陷 | 根因 | 落点 |
| --- | --- | --- | --- |
| 50 | **进计划模式 / 设目标当场抛 `kernel.internal`** | `planSessionOf` / `goalSessionOf` 的 `setActiveToolsByName: async (names) => (await session.setActiveToolsByName?.(names)) ?? missing()` —— `await` 一个 void 方法恒得 `undefined`，于是「方法在、正常返回」也被判成「这条会话不支持」 | 缺席判据改落在**方法本身**上（`const apply = …; if (apply === undefined) missing(); await apply(names)`），两个桥都改 |
| 51 | **计划文件一份也解不出来** | 适配器从 `AgentSession` 上读 `artifactsDir` / `cwd` —— 真实形状里它只有 `sessionManager`（`agent-session.d.ts`），那两个属性恒是 `undefined`，`local://` 于是退到 `os.tmpdir()/omp-local/<id>`，`resolveApprovedPlan` 找不到 agent 写的那份计划 | 改读 `session.sessionManager` 的 `getArtifactsDir()` / `getSessionId()` / `getCwd()`（与 omp 自己的 `#localProtocolOptions` 同一处） |

两处都是**只在真人路径上**才成立、手工搭的假对象碰不到的缺陷。`__tests__/plan-goal-e2e.test.ts` 走 `wrapOmpSession` + 一份真计划文件（`<artifactsDir>/local/auth-plan.md`）把它们钉住：批准 / 要求修改 / 否决三条计划路与设置 / 清除两条目标路各一条用例；把任一处改回去，用例当场红（前一条实测）。

### 4. 测试与验证

新增 / 改写：`plan-goal.test.ts`（进模式先落状态再改工具集的次序、退出与批准后工具集原样还原、四档答复的工具结果文本与计划状态、revise 换路径回写状态、两条不可用错误码、目标四条路径 + steer）；`controls.test.ts`（`setPlanMode(false)` 把待答卡片按 dismiss 兑现；夹具改成有状态的 `applyPlanMode` / `applyGoal` —— 恒返回 false 的桩会让「切了模式但控件表没跟着变」看起来是通过的）；`plan-goal-e2e.test.ts`（三条计划路 + 两条目标路走 `wrapOmpSession`，见上节）。

| 检查 | 结果 |
| --- | --- |
| `bun run check` | ✅ **1280 pass / 0 fail**（166 文件 / 3 snapshots / 4188 断言） |
| `bun run lint` | ✅ exit 0（biome + `no-raw-errors` + depcruise 0 违规；1031 模块 / 3367 条依赖） |
| 契约快照 | ✅ 只动四处：删 `timeline.media`、`Controls` 加 `available`、`Interaction` 的 plan 加 `planFilePath`、`controls.setGoal` 的 `goal` 加 `minLength: 1`（`z.string().trim().min(1)`）；`PROTOCOL_VERSION` 1 → 2 |

## 05 页（通信）符合性整改（2026-10-07）

对照 05 页 §1–§13 做逐条机检：用 `contractSnapshot(appContract)` 对 05 §10/§11 的名单、owner、timeoutMs、
字段形状逐项比对（临时脚本，跑完即删）。共发现 21 处不符，20 处按方案原文改掉；`timeline.media` 一处是
2026-10-07 Q28 裁决的有意删除（见上一节），不改、只记录。

### 已改（都有 05 明文）

| # | 位置 | 不符（改前） | 改为 | 依据 |
| --- | --- | --- | --- | --- |
| 1 | platform 契约 | `dialog.pickFolder/pickFiles/pickSavePath` 未声明 timeoutMs（默认 30s） | `timeoutMs: 0` | 05 §10「dialog.* 0（不超时）」 |
| 2 | review 契约 | `git.review` / `git.commit` 默认 30s | `timeoutMs: 60_000` | 05 §10 |
| 3 | extensions / python 契约 | `skills.install` / `plugins.install` / `python.install` 默认 30s | `timeoutMs: 300_000` | 05 §10 |
| 4 | extensions 契约 | `skills.setEnabled/remove/read` 参数名 `id` | `skillId` | 05 §11.8 |
| 5 | extensions 契约 | `plugins.install/uninstall/setEnabled` 参数名 `id` | `pluginId` | 05 §11.8 |
| 6 | extensions 契约 | `skills.install` 结果 `{skill}`；`plugins.install` 结果 `{plugin}` | 直接返回 `SkillInfo` / `PluginInfo` | 05 §11.8 |
| 7 | extensions 契约 | `mcp.status` / `mcp.statusChanged` 字段 `statuses` | `servers` | 05 §11.8 |
| 8 | extensions 契约 | `skills.list` 的 `workspaceId` 必填可空 | 可省（`.optional()`），Core 侧 undefined 当全局 | 05 §11.8 `{workspaceId?}` |
| 9 | review 契约 | `git.filePatch` 参数多一个 `untracked` | 从契约删掉；跟踪状态由 Core 服务自判（`ls-files --error-unmatch` 退出码 1 = 未跟踪，07 §10C） | 05 §11.10 |
| 10 | review 契约 | `git.createBranch.from` 必填可空 | 可省（`.optional()`），Core 侧 `?? null` | 05 §11.10 `from?` |
| 11 | conversation 契约 | `controls.draft` 三格均可省 | 必填可空（null = 默认值），Core 侧 `posture ?? DEFAULT_POSTURE` | 05 §11.4 + 07 §5E |
| 12 | protocol | 缺 `ownerOf` | 按 05 §8 完整代码导出 | 05 §8 |
| 13 | protocol | 版本常量内联在 index.ts，规则写成「只有破坏性变化才 +1」 | 拆出 `src/version.ts`；规则改成 05 §8/§13.6 的「任何契约形状变化都要 +1」；本轮形状变化 → 2 → 3；README 与快照测试文案同步 | 05 §8 / §13.6 |
| 14 | protocol 测试 | 缺 05 §10/§11 的机检 | 新增 `src/__tests__/contract-05.test.ts`（18 例） | 16 页测试策略 |

### 只记录、不改的

| 事项 | 说明 |
| --- | --- |
| `timeline.media` | 05 §11.4 / 07 §5C / 12 §7.8 都列了它，但 2026-10-07 Q28 裁决为「删掉，图片只走内联 data URL」（本文件上一节）。本轮确认代码与裁决一致；计划正文未同步改写，属文档与裁决的差异，按裁决不改代码。 |
| JSON-RPC `-32700` | 05 §2 的映射表写了「无法解析的消息 → -32700」，但 05 §4 自带的 `FrameDecoder` 完整代码把解析不了的行当 stray 交给 `onStray`、不回复 —— 方案内部不一致。本轮不发明新回复路径（守则 12），留待方案定夺。 |

### 验证

- 机检脚本（临时，跑完即删）整改后 PASS；唯一输出是 `timeline.media present: false`（上表已记录）。
- `bun run typecheck` → exit 0。
- `bun test features/extensions features/review features/conversation packages/protocol` → 126 pass / 0 fail；新增的 `contract-05.test.ts` 18 pass。
- `bun test packages/host-kernel packages/ui-kernel packages/core-kernel` → 157 pass / 0 fail。
- `bun run protocol:snapshot` 已重生成快照；`PROTOCOL_VERSION` 2 → 3，Core 产物需 `bun run core:build` 重建。

- 全量 `bun run check` → **1299 pass / 0 fail**（167 文件 / 4231 断言；含 typecheck、biome、no-raw-errors、depcruise），exit 0。
- `bun run core:build` → exit 0（`PROTOCOL_VERSION` 2 → 3 后重建 `apps/core/dist/poietica-core.exe`）。
- 顺带删除 6 个误提交进源码目录的 `.d.ts.map`（python / usage 的 contract；全仓零引用）。

### 05 轮顺带的总体审查（非 05）

- 测试里的 2 处 `@ts-expect-error` 按铁律 3 去掉：`contract-kit/define.test.ts` 改成类型层「不可赋值」断言，
  `runtime-layout/data-layout.test.ts` 改成 `as unknown as` 视图；现在全仓 0 条 `@ts-*` 指令。
- 生产代码仍有 12 条 `biome-ignore`（10 个文件，全部是 `noConsole`）：logging 的 console-sink 3、
  engine-omp 的 stdout-guard 1、foundation/event 1、ui-kernel 3、design-system/use-copy 1、
  conversation/mascot 1、test-kit/test-logger 1、protocol/scripts 1。铁律 3 禁止 `biome-ignore`，而 10 页 P0.7
  的 biome.json 只给 tooling/scripts/tests 关了 `noConsole`（「日志只能经 Logger」）。这些位置要么就是
  Logger 的控制台 sink 本身、要么发生在 Logger 不可达的引导/兜底路径，属方案没覆盖的取舍，**留给产品负责人**：
  （a）在 biome.json 给这批「sink/引导」文件加显式 allowlist，或（b）改成不写 console 的结构。
- 「单个源码文件不超过 400 行」仍有 29 个文件超限（最大 1257 行），沿用之前记录的 F6，等指示再拆。
## 05 轮后续裁决落地（2026-10-07）

产品负责人就「05 轮留下的两个冲突」定了口径，并给了 console/biome 例外与文件拆分的新政策。本轮落地如下。

### 1. `timeline.media`：保留「删掉、图片只走内联」，改计划正文（不改代码）

05 §11.4、07 §5C、12 §7.8 里的那三行已删除；代码保持 Q28 裁决（`attachment.upsert` 内联 data URL，时间线不走引用制）。
### 2. JSON-RPC `-32700`：表里删掉，解码器保持「不回复」

- 05 §2 映射表删掉「无法解析的消息」一行；
- 05 §4 帧代码后补「坏帧规则」：坏行不回复、经 `onStray` 记 warn、后续帧照常解码；丢失的响应靠请求超时兜底，丢失的通知靠 `seq` 缺口 + `timeline.catchUp` 兜底；
- 新增回归用例 `packages/rpc/src/__tests__/frame.test.ts`「坏帧不回复、不毒化帧流」：坏行进 stray（带 `[bad frame]`）、前后帧照常交付、对端零回复、坏帧之后的请求仍能拿到回复。
### 3. console 收敛 + 精确 allowlist + 禁止 `biome-ignore`

- 新增 `packages/foundation/src/last-resort.ts`：日志系统不可用时的最后通道（启动早期 / logger 初始化失败 / 致命退出前）。
- 12 条 `biome-ignore` 清零：Emitter、ui-kernel 的 channel / error-boundary、design-system 的 use-copy、conversation 的 mascot 改走 Logger 或 `lastResort`；protocol 快照脚本删掉唯一一行输出；收敛不掉的三个 sink 与 stdout 守卫按精确路径进 allowlist。
- `biome.json` 的 `overrides` 新增**精确路径** allowlist（无 glob）：`foundation/src/last-resort.ts`、`logging/src/console-sink.ts`、`test-kit/src/test-logger.ts`、`ui-kernel/src/services/logging.ts`、`engine-omp/src/bootstrap/stdout-guard.ts`；五个文件头注释写明原因。
- 新增闸门 `tooling/checks/no-biome-ignore.ts`（扫全仓 ts/tsx/js/jsx/mjs/cjs，命中即失败），已接进 `bun run lint`。
- 主方案铁律 3 改写；10 / 11 页的配置与说明、06 页三处内嵌代码同步。
### 4. 「单文件 400 行」改为按职责拆分 + 函数复杂度硬门

- 主方案铁律 9 与 09 页迁移审查第 11 条改写：按职责拆分，不按行数；非豁免文件 >800 行要在 refactor-log 写「为什么它是单一职责」；豁免：测试文件、`*.generated.ts`、`vendor/**`、`packages/transcript/src/upstream/**`、纯数据表、契约 schema；迁移时不为了行数改结构。
- biome 开启 `complexity/noExcessiveCognitiveComplexity`（阈值 15）。开启后全仓现有 **62 个函数 / 51 个文件**超阈值。
- 存量按现状**分档冻结**（≤20 / ≤25 / ≤30 / ≤40 / ≤52，精确文件路径）在 `biome.json` 的 `overrides` 里：档内不再按 15 报错、也不会回退变差；**未登记的其余文件一律按 15 报错**。
- 待办：51 个文件的 62 个函数逐轮拆到 ≤15；清单可用 `bunx biome check . --max-diagnostics=400` 复现。
### 5. 本轮验证

- `bun run check` → **1300 pass / 0 fail**（167 文件 / 4238 断言 / 3 snapshots），exit 0（含 biome 0 error、no-raw-errors、新增的 no-biome-ignore、depcruise）。
- `bun run tooling/checks/no-biome-ignore.ts` → 全仓 0 命中（848 个 ts/tsx/js/jsx/mjs/cjs 文件）。
- 新增帧用例 8 pass；受影响包 296 pass；`bun run core:build` 与 `core:probe`（5/5）通过。
### 6. 编辑器工程映射补口（2026-10-07）

`tooling/checks/` 此前不在任何 tsconfig project 里：新增的检查脚本在编辑器里落到 inferred project，报 6 个 TS 错误（`node:path` / `import.meta.dir` / `Bun` / `process` / 隐式 any）。已把 `checks` 加进 `tooling/tsconfig.json` 的 include，并显式 `types: ["bun", "node"]`；`no-biome-ignore.ts` 的 `(part)` 补显式 `string`。`bun run refs` / `bun run typecheck` / `bun run lint` 全过；10 页 P0.6 的项目块同步。

## 对话页右上角控件与右坞还原（2026-10-07，产品负责人报障）

用户报障两条：① 进入具体对话后右上角没有那两枚开关（截图 1）；② 右侧面板的样子与逻辑
和 legacy 不是一回事（截图 2/3：只有一枚「×」关掉整条坞，没有启动器、没有加号、没有全屏，
终端还被放在底坞）。逐条查源后确认**不是样式问题**，而是三块结构在新架构里根本没落：

| # | 缺什么 | legacy 的实现 | 新架构当时的形状 |
| --- | --- | --- | --- |
| 1 | 主区 / 窗口右上角控件 | `workspace.tsx` 把 `ConversationControls` 交给 `parts.main.controls`，`workspace-shell.css` 用 `.workspace-shell__conversation-control` 定位两格 | `WorkspaceFrame` 没有 `mainControls` 槽位，`ui-kernel` 没有对应贡献点，conversation 也从未贡献 |
| 2 | 右坞的归属与逐归属面板表 | `auxiliary-panel-store.ts`（按 owner 分账 panes/focus/menu）+ `auxiliaryThread === activeConversationId` 才在场 | `LayoutService.right` 只有 `{open,activeId,size}`，没有 owner、没有分账，conversation 从不认领 |
| 3 | 右坞的壳 | `auxiliary-panel.tsx`：空态启动器四枚 → 有格时共享标签条（悬浮换脸 / Delete / 方向键 / 加号菜单 / 全屏） | 一个通用 `PanelTabStrip`（全面板 + 一枚整体关闭叉），启动器写死 `offers={[]}` 画成「还没有任何面板」 |

**落地**（按新架构、外观逐字照 legacy）：

| 落点 | 改动 |
| --- | --- |
| `packages/ui-kernel` | 新增 `builtinPoints.mainControls`（`slot: 'main' \| 'window'`）；`LayoutState` 增 `auxiliary { owner, activeOwner, fullscreen }` 与逐 owner 的 `panes` Observable；右坞在场 = `owner === activeOwner && owner !== null`；`openPanel/togglePanel/closePanel` 改走归属 |
| `packages/workbench` | `WorkspaceFrame` 增 `mainControls` 槽位；`workbench.tsx` 渲染贡献（wrapper `.workspace-shell__conversation-control[data-slot]`，定位逐字迁 legacy）；右坞按 legacy 重写（启动器 / 共享标签条 / 加号菜单 / 全屏 / 逐归属记忆）；`styles.css` 迁 legacy 的两格定位与全屏让位 |
| `features/conversation` | 贡献 TodoToggle（ListTodo）+ AuxiliaryToggle（PanelRight），只在 `conversation.thread` 出现；表面在 effect 里声明 `setActiveOwner`；迁移任务浮层（`conversation-todo-popover`）；新增右坞「辅助对话」面板 |
| `features/review` | 面板名回 legacy 的「审查」（启动器与标签条读同一个 title） |
| `features/terminal` | 面板由底坞改回**右栏**（order 15，辅助对话 5 / 审查 10 / 终端 15 / 浏览器 20） |
| `features/browser` | 标签页交给右坞标签条（新增 `PanelItem.dockTabs`），面板本体不再自画标签条 |

### 偏差（本轮新增）

| # | 日期 | 事项 | 类型 | 原因 |
| --- | --- | --- | --- | --- |
| 44 | 2026-10-07 | 新增内置贡献点 `builtinPoints.mainControls` | 新增（03 页 §4 的贡献点表里没有它） | 会话页右上角那两枚开关在 legacy 是外壳的 `parts.main.controls`，新架构里这条格子没有归属 —— 不补就没有任何落点（用户报障 ①）。组件只出内容，定位仍归外壳 |
| 45 | 2026-10-07 | `PanelItem.location` 去掉 `'bottom'`；**底坞整块删除**（`LayoutState.bottom`、`LAYOUT_LIMITS.bottom`、`SplitterRegion` 的 `'bottom'` 档、`BottomDock`/`PanelTabStrip` 两个组件、`.workspace-shell__bottom*` 全部样式、`workbench.toggleBottomPanel` 命令与 Ctrl+J） | 删 | **产品负责人 2026-10-07 明确：「07 页 §11E 把终端落在底坞？这个设计不要了，删除这个，就是还要原来的在右侧侧边栏上」**。legacy 的栅格里从来没有底坞（它的 dock 只有右栏一列，终端/审查/浏览器/辅助对话都是那一列里的格），06 页 §6.2 的布局图是新增设计 —— 按用户决定以 legacy 为准 |
| 46 | 2026-10-07 | 终端面板落点由 `location: 'bottom'` 改为 `'right'`（order 15） | 迁（改落点） | 同 #45：legacy 的 `AUXILIARY_LAUNCHER` 四枚里就有终端，它在右栏。07 页 §11E 原文与 legacy 形制不符，以 legacy 为准 |
| 47 | 2026-10-07 | 终端面板**挂载即开一条终端**，且只有一条时不画标签条 | 迁（行为对齐） | legacy 的 `TerminalPane` 在挂载那一刻就 `port.attach(...)`，用户点「终端」看到的是一块能敲的 shell。新架构原先要用户再点一次「+」才开 PTY，屏幕上是一块空面板 + 一枚加号（用户报障：「点击终端怎么只有一个加号图标」） |
| 48 | 2026-10-07 | `apps/desktop/electron.vite.config.ts` 的 main 增加 `ssr.external: ['@lydell/node-pty', '@lydell/node-pty-win32-x64']` | 修（真机缺陷） | `externalizeDepsPlugin()` 只读**应用自己**的 dependencies，从 `features/terminal` 源码进来的 `@lydell/node-pty` 仍被内联进 `out/main/index.cjs`；内联后它的 `requireBinary()` 解析起点变成 `out/main`，平台二进制包（`@lydell/node-pty-win32-x64/conpty.node`）找不到 —— 每次开终端都以 `terminal.spawn_failed` 失败，界面显示「终端没能接上」（真机日志逐条可查）。留在外部后 `main.log` 出现 `terminal opened ... pid=...` |

## 线程标题栏「N 个文件改动」按钮删除（2026-10-07，产品负责人报障）

产品负责人贴出截图（线程标题栏右端的「33 个文件改动」按钮，以及鼠标悬停时弹出的
「打开改动面板」气泡）并要求「删除这个 ui」。追问后**明确：按钮与气泡一起删**，
不是只删气泡。

| 落点 | 改动 |
| --- | --- |
| `features/review/src/ui/index.tsx` | 删掉 `threadHeaderItems` 的 `review.threadChanges` 贡献（order 10）；随之不再需要的 `Thread` 类型 import 一并删 |
| `features/review/src/ui/surface.tsx` | 删 `ThreadChangesButton`（按钮 + 悬停气泡）与其取数钩子 `useChangeCount`；import 收窄（`cn` / `Tooltip` 三件套 / `Thread` / `LayoutService` / `ReviewApi` 都不再被这个文件用到） |
| `features/review/src/ui/tsconfig.json` | `bun run refs` 生成：去掉不再需要的 `conversation/src/contract` 引用 |

**保留**：`threadHeaderItems` 贡献点本身（usage 的「累计用量」还在用）、命令
`review.openChanges`（Ctrl+Shift+G）与右坞启动器「审查」—— 打开审查面板仍有两条路。

**验证**：`bun run check` → **1311 pass / 0 fail**（169 文件 / 4272 断言），与改动前的
基线数字逐项一致（改动未删任何测试，也没有测试引用这枚按钮）。

### 偏差（本轮新增）

| # | 日期 | 事项 | 类型 | 原因 |
| --- | --- | --- | --- | --- |
| 49 | 2026-10-07 | 删掉 07 页 §10E 里 conversation `threadHeaderItems` 的「N 个文件改动」按钮（含悬停气泡） | 删 | **产品负责人 2026-10-07 明确：「删除这个 ui」**（截图：按钮 + 「打开改动面板」气泡；追问后确认两块一起删）。07 页 §10E 的落点表里有这一枚，本条与它不一致 —— 按用户决定执行。打开审查面板改由命令 `review.openChanges` 与右坞启动器承担 |

## 用量页还原（2026-10-07，产品负责人报障「这个用量的 ui 完全损坏了」）

截图里坏了四处：趋势图是一块**黑斑**、七个日期（10/1…10/7）飘到设置页最顶上、
概览六个读数挤成一片小字、时间范围选择器整块不见。逐条查源后分成两类，都不是样式微调。

### 一、design-system 漏了 6 条规则（外观坏掉的直接原因）

与 legacy `packages/settings/src/ui/surface/settings-surface.css` 逐条对表（机检：解析两份表、
按选择器比对正文）后发现，P6 迁「设置词汇」时按**主类名**迁，用量页那 6 条以组合/后代
选择器写的整条漏了。漏掉的两条后果最重：

| 漏掉的规则 | 症状 | 为什么 |
| --- | --- | --- |
| `.settings-trend__line` | 趋势图一块黑斑 | `<path>` 的默认填充是**黑色**，`fill: none` 正是唯一一条取消它的声明。d 是一条从左到右再回程的曲线轮廓，于是被当闭合多边形涂满 |
| `.settings-trend__axis` | 日期飘到设置页最顶上 | 刻度是 `position: absolute` 的 `span`，容器不 `position: relative` 就一路往上找到 `.settings-content`（它也 relative）—— 图底下还空着一行 |
| `.settings-metric__value` | 六个读数挤成小字 | 漏 22px/550，读数退回与正文同档字号 |
| `.settings-metric__value[data-unrecorded]` | 占位符与真读数分不出 | 缺 `--ui-placeholder` + 常规字重 |
| `.settings-trend__swatch` | 第一个模型的图例是空行 | 尺寸与 0 档底色都在这条里（`[data-series="1..5"]` 只给 1–5 档） |
| `.settings-heatmap__legend .settings-heatmap__cell` | 图例方块塌成 0 宽 | 图例的方块不在栅格里，宽度得自己给 |

全部逐字照抄 legacy（值一个未改），并新增 `features/usage/src/ui/__tests__/usage-css.test.ts`：
逐条断言**那一条规则本身**（只看类名在不在是不够的 —— 上面几条的名字在别处都有定义）。
已实测：把 `fill: none` 拿掉，用例当场红。

### 二、接线与口径（数字不对的原因）

| # | 事项 | 落点 |
| --- | --- | --- |
| 1 | **时间范围选择器整块没画**：`useState` 的 setter 写成 `_setSpan`、`SegmentedControl` 的 import 与 `headerAction` 全被删掉 —— legacy 的两档（最近 7 天 / 30 天）无从切换 | `ui/usage-settings.tsx` 补回，`SPANS` 加 `satisfies readonly SegmentedOption[]` |
| 2 | **概览三项全是 0**：`threadTimes` 写死成 `[]`（对话数/活跃天数/连续天数只能得 0） | `ui/index.tsx` 读 `threads.list`（含已归档，与 legacy 把两个快照并起来一致），订阅 `threads.updated` / `threads.removed` 重读 |
| 3 | **「最常用模型」显示 provider/id**：`labelModels` 是个恒等函数（注释写着「待后续补充」） | `model-labels.ts` 实现真查表（名字产地只有 models 目录，ADR 0017），`ui/index.tsx` 读 `models.catalog` 并订阅 `models.changed`；usage 的 `dependsOn` 加 models，package.json 补 feature-models |
| 4 | **窗口算式差一天**：`今天 - span * 86400000` 是 span + 1 天，合计会把第 8 天也算进去 | `ui/api.ts` 新增 `windowOf()`（`span - 1` 起算，与 legacy `token_days_through` 的 `offset = span - 1` 同式），三个读函数共用 |
| 5 | **读函数每帧现造**：三个 read* 定义在 component 里 —— 表面的 `useRead` 以它为 effect 依赖，读回 → setState → 重渲染 → 又一个新函数，页面会一直重读 | 三个读函数移到 `ui/api.ts` 的 setup 期对象上（引用终身不变）；线程时刻与模型名走 `useLive` 一次性读 + 订阅重读 |
| 6 | **消息数量口径错**：数的是模型采样条数（一次模型调用一行），legacy/ADR 0039 的口径是**用户发出去的句子数**，两者差一个数量级 | 见下节 |

### 三、消息数量改回 legacy 口径（产品负责人裁决）

08 页给的实现是 `usage.messageCount` 数 `usage_events` 的行，并在注释里写明「一次模型调用 =
一条采样 = 一条消息」。legacy 的 `crates/ledger` 与 ADR 0039 的口径是 `turn_admissions`
——**用户发出去的句子数（含插话）**。追问后产品负责人裁「改回 legacy 口径」。

落点（新架构的接法，不是照搬 legacy 的表）：

- `features/conversation/src/core-api/index.ts`：新增 `userMessageSubmitted` 事件 ——「用户发出去了一句话」只有 conversation 知道（它拿着回合准入）。
- `features/conversation/src/core/conversation.ts`：`submit` 里**在 `await session.submit` 之后**发它。次序是硬要求：写在 await 之前的话，引擎自己拒收的那一次（会话已关闭、provider 报错）会在账上留下一句没说过的话。
- `features/usage/src/core/migrations.ts`：v2 建 `usage_messages`（按天的准入账）。**不去猜**哪些采样属于同一次输入 —— 那是启发式，猜错就是把数字改错。
- `features/usage/src/core/repo.ts`：`insertMessage` / `messageCount` 改读准入账；`usage_events` 一行未动。
- 契约**形状**没变（仍是 from/to → days 数组），只是描述与语义改了；`PROTOCOL_VERSION` 3 → 4（迁移动了落库形状），快照已重生成。

### 四、验证

| 检查 | 结果 |
| --- | --- |
| `bun run check` | ✅ **1339 pass / 0 fail**（172 文件 / 4316 断言），exit 0 |
| 新增用例 | `usage-css.test.ts`（10 例，逐条钉那 6 条规则）、`usage-window.test.ts`（9 例：窗口含今天/跨年/模型名查表）、`messages.test.ts`（7 例：准入账而不是采样数、日界、v2 迁移）、`conversation-core.test.ts` 的 US-7 两例 |
| 反向验证 | 把 `fill: none` 拿掉 → CSS 用例红；把计数挪到 `await` 前 → US-7 第二例红（两条都实测） |
| CSS 对表 | 用量相关的规则**零缺失、零正文差异**（与 legacy 机检逐条比对） |

### 偏差（本轮新增）

| # | 日期 | 事项 | 类型 | 原因 |
| --- | --- | --- | --- | --- |
| 50 | 2026-10-07 | `usage.messageCount` 的口径由「模型采样条数」改为「用户发出去的句子数」，落库从 `usage_events` 的行数改为新表 `usage_messages` | 改（口径） | **产品负责人 2026-10-07 裁决**。08 页 §14C 的原文与注释写的是「一次模型调用 = 一条消息」，legacy 与 ADR 0039 是 turn_admissions。两者相差一个数量级（一次用户输入引出多次模型调用），屏幕上的数字对不上 legacy。契约形状未变，`PROTOCOL_VERSION` 3 → 4 |
| 51 | 2026-10-07 | usage 的 `dependsOn` 由 conversation 改为 conversation + models；package.json 补 feature-models | 新增（依赖） | 「最常用模型」与趋势图图例要显示模型**名**而不是账上的 provider/id（ADR 0017：名字的产地只有模型目录）。models 契约本来就是给这件事用的公开面，走 ctx.rpc(modelsContract) 属守则 3 允许的协作 |

> 真机验证待办：Core 产物需 `bun run core:build` 重建（本次改动含 v2 迁移与 `PROTOCOL_VERSION` 4）。
> 本机构建时 `apps/core/dist/poietica-core.exe` 被正在运行的应用占用（EPERM），需先退出 Poietica 再重建。
## P6 记忆 / 个性化两页还原（2026-10-07）

产品负责人报障：设置里「记忆」页画出了**整份 agent 设置目录**，「个性化」页则**完全空白**；
另有 `sharpshooter.model` 变成自由输入框（应是从模型目录现算的下拉）。三处都在「归属与选项
由谁算」这一层。

### 根因

| # | 位置 | 缺陷 | 后果 |
|---|---|---|---|
| 1 | `features/agent-settings/src/ui/agent-page.tsx` | 归属由界面**按组名里的关键词猜**（`/persona|personal|个性|性格|风格|人格/`），而组名在引擎端口那头**已经译成中文**（「提示词」「思考」「通用」），一个都匹配不上 | 个性化页每组都判 false → 过滤完 0 组 → 全空白；记忆页 `!persona` 恒为真 → 整份目录都画 |
| 2 | `packages/engine-omp/src/ports/settings-catalog.ts` | 目录「只删不标」：`CONTROLLED_ELSEWHERE` 把 13 格从**目录里删掉**，而 legacy 的原文是「**只标不删**：值照报，行不画」；另有 6 条前缀判据（`plan.` / `goal.` / `advisor.` / `autolearn.` / `ttsr.` / `snapcompact.`）把整族误杀 | 读它们值的 `condition` 永远为假，相关行**静默消失**；记忆栏 30 格只剩 28 |
| 3 | `packages/engine-omp/src/ports/settings.ts` | legacy 的 `SettingChoicesOf`（现算选项表）**没有迁** —— 没有 `sharpshooter.model` 那一格的模型下拉 | 那一格退成自由输入框；而它填的值必须是目录里的 `provider/id`，拼法不同就选不中，模型解析静默回落 smol |

### 修法（判据搬到引擎端口，界面只做等值比较）

| 层 | 落点 |
|---|---|
| 引擎值对象 | `SettingDescriptor` 补齐 legacy `AgentSettingEntry` 的那几格：`groupLabel` / `warning` / `condition` / `owned` / `section` / `secret` / `hasValue`；`options` 由 `string[]` 改成 `{value,label,description}`（旧形状把中文选项名整层丢掉） |
| engine-omp | 过滤表逐条对齐 legacy：`IRRELEVANT` 按 legacy 原文重列（`plan.autosave` 等回到目录）；`ownedElsewhereOf` 只标不删；新增 `sectionOf`（记忆按 omp 自己的 **tab**、个性化按 **path 名单**）与 `modelSelectorSettingOf`；目录次序改取 `orderedSettings()`（omp 面板排列）；中文标签/说明/选项表整份迁自 legacy；设置端口收**同一个 registry** 现算 `sharpshooter.model` 的选项（含「自动」空串档） |
| 契约 + core | 分组按 **group 键**归并、标题取 `groupLabel`（译名不当键：两条不同的键会撞上同一个名字）；enum 校验改判 `option.value`（`label` 是给人看的那一列） |
| UI | 删掉关键词猜测，改读 `descriptor.section`；补回 `condition` 求值（`ui/settings-conditions.ts`，逐条抄 omp 的 `CONDITIONS`）、`owned` 不画行、`warning` 上屏、选项画中文 label、凭据格「已配置/未配置」 |

### 偏差

| # | 日期 | 事项 | 决定 | 理由 |
|---|---|---|---|---|
| 52 | 2026-10-07 | `SettingDescriptor` 形状变化（新增 7 格、`options` 换形状） | 改（契约） | 旧形状答不出「这一格归哪一页」「它由别处管吗」「此刻显不显示」三个问题，而这正是两页画法的**全部**判据。`PROTOCOL_VERSION` 4 → 5，快照已重生成 |
| 53 | 2026-10-07 | `SettingsPort.groupOrder` 由「标签序列」改成「`group` 键序列」 | 改（契约） | 界面按 `group` 键归并，次序表必须同源。译名与键在本端口里**不是一一对应**（认不出的节原样交回英文），拿译名当键会让两条不同的键合成一格且屏幕上看不出错 |
| 54 | 2026-10-07 | 分节次序取 `orderedSettings()` 的**首次出现**，**不用** pi-tui 的 `TAB_GROUPS` | 迁（对齐 legacy） | 两者都「有来源」但并不相同（实测：`TAB_GROUPS.memory` 把 Sharpshooter 排最后，`orderedSettings` 排在 `mnemopi.*` 之前）。legacy 的 `catalog-rows` 用的是后者，界面要与 legacy 一致就只能取它 |
| 55 | 2026-10-07 | `SettingsPortDeps` 增加**可选**的 `registry` | 新增（依赖） | `sharpshooter.model` 的选项要现算（上游 schema 只给了 string），而选项的产地只有模型目录。自己写一份「有钥匙的 provider 的模型」就是第二个事实 —— 与 `models` 端口必然分叉。可选：不传时那一格没有选项，而不是编一张选不中的假清单 |

### 必测（本轮新增）

- `packages/engine-omp/src/ports/__tests__/settings.test.ts`：owned 的格子**留在目录里**、记忆 30 / 个性化 10、`condition` 与 `options` 原样带出、`sharpshooter.model` 用模型目录现算选项（含「自动」空串档）、没有目录时不编假清单
- `packages/engine-omp/src/ports/__tests__/settings-catalog.test.ts`：过滤表判据、曾被前缀误删的格子回到目录、归属两个判据互斥
- `features/agent-settings/src/ui/__tests__/agent-page.test.tsx`：两页各画自己那一段、组标题取 `groupLabel`、`owned` 不画行、`condition` 按整份目录求值、认不出的条件名不显示、`warning` 上屏、选项画中文 label

> 真机验证待办：Core 产物需 `bun run core:build` 重建（本次改动含 `SettingDescriptor` 新形状与 `PROTOCOL_VERSION` 5）。
> 本机构建时 `apps/core/dist/poietica-core.exe` 被正在运行的应用占用（EPERM），需先退出 Poietica 再重建。

## 输入框的上下文用量圆环不显示（2026-10-07，产品负责人报障）

产品负责人贴出两张截图：新树里输入框**没有任何用量显示**，而 legacy（参考实现）点开同一位置
有「上下文已用 3% · ~27.2K / 1M」那张七行面板。

组件本身是好的 —— `context-gauge.tsx` 逐字自 legacy 迁入，`context-gauge.css` 与 legacy
**逐字节相同**（机检：两份文件 Compare-Object 为空）。问题全在**数据线上**，两处：

### 一、引擎适配器读错了字段名（根因）

`packages/engine-omp/src/omp-session-adapter.ts` 的 `OmpAgentSessionLike` 把
`getContextUsage()` 声明成 `{ usedTokens?, windowTokens? }`，而 omp 真报的是
`{ tokens, contextWindow, percent }`（`@oh-my-pi/pi-tui` 的 `status-line/types.d.ts`）。

于是每一次调用都命中「两个字段都 undefined」那条分支 → 恒返回 `null` → `Controls.context`
恒为 `null` → `sessionUsageOf()` 交 `undefined` → `ContextGauge` 按 `usage === undefined`
整颗不画。**类型检查抓不到它**：那份错的声明是本仓自己写的（按结构收窄），与 SDK 对不上也不报错。

修法：字段名照 SDK 声明改回 `tokens` / `contextWindow`；映射抽成纯函数
`packages/engine-omp/src/context-usage.ts` 的 `toContextUsage()`，单测直接拿真实 SDK 形状喂进去
（按旧字段名读会红）。

### 二、构成明细恒为 null（第二处）

`control-shapes.ts` 原先写死 `breakdown: null`（P5 的偏差 #15：当时记的理由是「legacy 的构成
由原生侧算，新引擎端口没有对应报数」）。复核后**这个理由不成立**：omp 自己有
`computeSessionContextBreakdown`（`pi-coding-agent/session/context-usage-runtime`），
legacy 的 bridge.ts 调的就是它。新树接上同一个产地，七行面板因此画得出来。

### 三、用量搭错了车（跑完一轮不刷新）

用量原先只随 `controls.changed` 到达，而契约把那条通知定义成「控件状态变化」（模型 / 档位 /
姿态 / 模式）—— 跑完一轮读数涨了却不重画。legacy 是**两条独立通道**（`reselect` 与
`reportUsage`）。

新增 `controls.contextChanged` 通知（上下文用量单独一条），引擎侧在 `message_end` 与轮终各报
一次（与 legacy 的 `reportUsage` 时机逐条对齐）。UI 侧 `ControlsStore` 里用量**单独一格**
（`usage`），不与控件表同格 —— 否则每条用量通知都会换掉整张控件表（含模型候选清单）。

**名字落在 controls 名下**：`usage.*` 是 usage 功能（用量统计）的命名空间，已由它的契约占用
（`composeContracts` 判命名空间唯一）。上下文占用本来也就是 `controls.get` 报出来的那一格。

### 偏差（本轮新增）

| # | 日期 | 事项 | 类型 | 原因 |
| --- | --- | --- | --- | --- |
| 50 | 2026-10-07 | 删掉 07 页 §14E 里 conversation `threadHeaderItems` 的「累计 token 与费用」按钮（含它的悬停明细卡），连同 `usage.thread` 方法、`usage.updated` 通知、`ThreadUsage` 实体、core 侧 1 秒合批与 `repo.thread()` 一起 | 删 | **产品负责人 2026-10-07 明确：「删除这个，删除干净」**（截图：标题栏那枚 `8.8K · <$0.01` 按钮 + 输入/输出/缓存读/缓存写/费用五行的悬停卡）。07 页 §14E 的落点表里有这一枚，本条与它不一致 —— 按用户决定执行。删后 usage 功能只剩设置页那三张图（它们查账，不靠推送），conversation 的 `threadHeaderItems` 贡献点保留但不剩贡献者 |
| 51 | 2026-10-07 | `Controls.context` 由 `{usedTokens, windowTokens}` 扩成 `{usedTokens, windowTokens, breakdown}`；新增 `controls.contextChanged` 通知；engine-omp 新增 `context-usage.ts` 与 `contextUsage` 引擎事件 | 新增（04 页 §7.7 的控件表没有 breakdown 这一格） | 面板那七行要构成明细，而 04 页 §7.7 的表只规定了 `session.getContextUsage() → { usedTokens, windowTokens }`；omp 自己的 `computeSessionContextBreakdown` 是 legacy 用的同一产地，接上它才画得出与 legacy 一致的七行。用量单独一条通知同理由：契约把 `controls.changed` 定义成「控件状态变化」，用量每轮都在涨 |
| 52 | 2026-10-07 | 复用 P5 偏差 #15 时留下的 `SessionUsagePort` 端口**没有接线**，改为走 `controls.contextChanged` + `ControlsStore.usage` 那一格 | 迁 | `configuration/session-controls-store.ts` 里那根端口（`usage` / `#usageReported` / `usageOf`）从来没有装配点，也没有读者 —— 界面读的是 `stores.controls` 那台 FeatureStore（`ui/index.tsx` 的 `useFeatureStore`）。按新架构既有的那条数据线接，而不是再架一台没有读者的 store |

## 「Git 工具」那一格不显示（2026-10-07，产品负责人报障）

产品负责人贴出两张截图：会话页右上角任务浮层里**只有一条空壳**（连「Git 工具」都没有），
而 legacy（参考实现）同一个位置画着「Git 工具 / 更改 +0 -0 / 分支 / 提交或推送」三行。
同一轮还点明第二件事：**这一格的数据必须与右侧「审查」面板同步**，那是 legacy 就有的老毛病。

### 根因（两处，都在数据线上）

| # | 位置 | 缺陷 | 后果 |
|---|---|---|---|
| 1 | `features/conversation/src/ui/components/assistant-surface.tsx` 的 `TodoPopoverLayer` | 浮层那一层**只传了 `expanded` / `onCollapse` / `threadId`**，`git` 与 `gitPicker` 两个 prop 一个都没有交。两个调用方（会话页、入口页）也从来没有交过 | `TodoPanel` 收到 `git === undefined` → `showGit` 恒假 → `GitStatusSection` **恒不渲染**。屏幕上的表现就是「那一格永远不存在」，与仓库有没有改动无关 |
| 2 | 同上 + `features/review/src/ui/composer-branch.tsx` | 全仓唯一读到 git 的地方是输入框下方那枚分支 chip（review 贡献的 `ComposerBranchChip`），它自己 `createReviewApi` + `api.status()` **单独读一份**；而 `AssistantSurface` 那条 `<GitBranchPicker {...git} />` 又从来没有数据可传（`git` prop 零调用方） | git 事实**没有归口**：谁想画就自己再问一遍 git。这正是 legacy 的老毛病（宿主建一个 `useWorkspaceGitStatus`、审查面板自己再建一个），产品负责人点出的「要同步」就是这个 |

### 修法：一处事实，两个消费者

| 层 | 落点 |
|---|---|
| 形状与投递口 | 新增 `features/conversation/src/ui-api/git-status.ts`：`WorkspaceGitStatus`（**由 ui 搬到 ui-api**，两个功能都要用）、`WorkspaceGitFacts`、`workspaceGitContext` / `useWorkspaceGitFacts()`、贡献点 `workspaceGitProviders`。与既有的 `composerProviders` / `attachment-intake` 同一形制（跨功能只能经 contract / core-api / ui-api 协作，守则 3） |
| 事实源 | 新增 `features/review/src/ui/workspace-git-source.tsx`：review 贡献一个 Provider，读**当前活动工作区**的审查 store，把 `reading` 映射成事实投到 Context 上。没有工作区时投 `null`（这一格不存在） |
| 单一真相 | 新增 `features/review/src/ui/review-store-holder.ts`：**每个工作区只有一份 review store**，按引用计数共享（渲染期 obtain、effect 里 retain 才 `start()`，最后一个消费者走掉才停）。「审查」面板与状态面板读的是**同一个对象** |
| 判据 | 新增 `features/review/src/ui/workspace-git-facts.ts` 的 `workspaceGitFactsOf(reading, picker)`：只有 `phase === 'ready'` 才交事实。`notARepository` / `asking` / `unreadable` 一律 `null`（面板整格不画）；**干净仓库是 ready**，交出去就是 `+0 -0` |
| 面板 | `todo-panel.tsx`：`TodoPanel` 自己从 Context 读事实（不再经 props 转手）；`GitStatusSection` 的两个数**不再可空**（`added` / `removed` 由 `number \| null` 收紧成 `number`）—— 原先「不知道」与「没改」在屏幕上长得一样（都是不画 / 都像 0），这正是报障的一半 |
| 分支 chip | `composer-branch.tsx` 由「自己读一份」改成读同一个 Context：现在它与「审查」面板、状态面板同源 |
| 删掉的重复 | `assistant-surface.tsx` 里那条 `<GitBranchPicker {...git} />` 与它的 `git` prop（零调用方，且与 review 贡献的 chip 是同一件事的两份写法）；`ui/components/goal/workspace-git-status.ts`（形状搬去 ui-api） |

### 顺带修掉的第二处：浮层的默认展开算错了一次

`TaskPanelContent` 原先用 `Accordion` 的 `defaultValue={expanded}`。而**每一格的数据都是异步到的**
（git 那一份要走一次 RPC），所以「这一格该不该默认展开」在首帧常常还没有答案：`defaultValue` 只在
挂载那一刻算一次，晚到的那一格挂上来就是**收起的** —— 屏幕表现是「面板里什么都没有」。
改成**受控**：新出现的一格补进开着的名单（只补一次，之后人在它上面收起来就一直是收的）。

### 偏差（本轮新增）

| # | 日期 | 事项 | 类型 | 原因 |
| --- | --- | --- | --- | --- |
| 56 | 2026-10-07 | `WorkspaceGitStatus` 由 `features/conversation/src/ui/components/goal/` 搬到 `src/ui-api/git-status.ts`，并新增 `WorkspaceGitFacts` / `workspaceGitContext` / `workspaceGitProviders` | 迁（接口换位） | 这一格的事实有两个主人：面板住在 conversation、事实属于 review。功能之间只能经 contract / core-api / ui-api 协作，形状与投递口因此只能住在 ui-api（与 `composerProviders` 同一条理由）。原来的落点（`ui/components/goal/`）只有 conversation 自己够得着 |
| 57 | 2026-10-07 | 新增 `features/review/src/ui/review-store-holder.ts`（按工作区共享的 review store） | 新增（07 页文件清单里没有这个文件） | 「审查面板与状态面板必须同源」是产品负责人 2026-10-07 的明确要求（legacy 各建一份，是它原有的缺陷）。共享必须是**同一对象**而不是「两边都 refresh 一下」——后者在任一次读失败时立刻分叉。引用计数顺手把 `git.watch` 的次数也收成一次 |
| 58 | 2026-10-07 | `WorkspaceGitStatus.added` / `removed` 由 `number \| null` 收紧成 `number` | 改（形状） | 旧形状把两种完全不同的处境压成同一个屏幕表现：「读到了、干净」（0）与「还没读到 / 读失败」（null，整格不画）。收紧之后不变量变成「有事实 ⇒ 两个数都是事实」，判据只剩一处（`workspaceGitFactsOf` 的 phase 闸门） |

### 必测（本轮新增）

- `features/review/src/ui/workspace-git-facts.test.ts`：**干净仓库照样有事实（+0 -0，不是「这一格不画」）**、有增删照实报、不是仓库 / 还没读到 / 读失败都不给事实、分支与两个数同出一份读数
- `features/conversation/src/ui/components/todo/git-status-section.test.tsx`：面板这一层「干净仓库照画标题 + 更改行 + 加 0 减 0」「有增删照实报」「没有事实时整格不画」

## 06 微内核符合性整改（2026-10-08）

以 06 页为绝对权威，对三个内核 + workbench 外壳逐条取证（不靠读文档下结论）。形状本身
成立（拓扑装配 / 服务令牌 / RPC 绑定 / 进程内事件 / 工具冻结 / RpcHub 路由 / CoreSupervisor
状态机 / UI 契约访问控制 / 贡献点 / 设置的段与页）。本轮把找出的**不符项**改掉如下。

### 一、A-K1 的专名闸门此前不存在

06 页 §0 铁律 2 与 §8 A-K1 都点名 `workbench-agnostic` 规则，但 `tooling/depcruise/config.cjs`
里只有语义等价的 `packages-no-features`。执行者（和以后来的人）只能靠推断认定「哪条规则等效」，
而 A-K1 的验证方式写的是按规则名查。已补一条**同名规则**（范围 = `packages/(workbench|core-kernel|host-kernel|ui-kernel)`，
禁止的东西 = `^features/`）。

**实测**：造一个 `packages/ui-kernel/src/__probe_ak1.ts` 去 import 功能的 contract，
depcruise 同时报出 `workbench-agnostic` 与 `packages-no-features` 两条（探针文件已删）。
`tooling/depcruise/__tests__/config.test.ts` 增一条用例把规则名与范围钉住（规则改名即红）。

### 二、贡献组件缺 Suspense 与 PartSkeleton

06 页 §6.2 渲染规则表第一行要求「所有贡献组件一律包在 `FeatureScope` 里，**再包**
`<Suspense fallback={<PartSkeleton/>}>`（懒加载组件）」。此前只有主区那一处有 Suspense，
而且 fallback 是 `null`；`PartSkeleton` 这个组件根本不存在。

落地：新增 `packages/workbench/src/parts/part-skeleton.tsx`（中性灰块，复用既有的
`.workbench__skeleton` 规则），外壳的每一个贡献点宿主都补齐 `FeatureScope` + `Suspense`：
主区、侧栏（导航行与面板段）、标题栏三段、主区 / 窗口控件、右坞正文、设置内容、浮层。

### 三、Core 的顶层致命错误没有兜底

06 页 §2.7 明文：「`start()` 抛出的任何错误由 `apps/core/src/serve.ts` 外层捕获；`main.ts`
顶层注册 `process.on('uncaughtException')` / `unhandledRejection` → 写一条 `fatal` 日志 →
`process.exit(1)`」。`apps/core/src/main.ts` 此前**一条都没注册**，`serve()` 的 reject 直接冒泡。

落地：`main.ts` 顶层注册两个处理器 + 给 `await serve(launchEnv)` 包 try/catch，统一走
`fatal(scope, error)` —— 按 Core 的 stderr JSONL 约定写一行（带 `code` 与 `stack`），
随后 `process.exit(1)`。Host 的 `CoreLogSink` 逐行收进 `core.log`。

**实测（A-K6）**：临时从 `apps/core/src/modules.ts` 摘掉 `usage` 模块 → 重建 Core →
启动 → 退出码 **1**，`core.log` 里出现 `fatal` 一行，`code` 为 `kernel.unhandled_method`，
error 为「以下 owner='core' 的方法没有实现：usage.tokenDays, usage.modelDays, usage.messageCount」。
探针改动已还原，Core 已重建、`core:probe` 重新全绿。

### 四、Host 退出用的是 process.exit 而不是 app.exit

06 页 §4.9 的 `quit.ts` 完整代码里，两处终止进程都写 `app.exit(0)`（Electron 的退出路径）。
本仓此前为「便于测试注入」写成 `process.exit(code)`，与 06 页不一致 —— `process.exit`
会跳过 Electron 自己的清理，而且 `finalize`（update 的 `quitAndInstall`）那条路本就是
「在正常的 quit 事件里拉起安装程序」，只能走 `app.exit`。

落地：`createQuitCoordinator` 改为顶层 `import { app } from 'electron'`，默认 `exit = app.exit`；
保留 `exit?` 注入缝（测试用假实现）。

### 五、host-kernel 的 electron 是 devDependency，不是 peer

06 页 §4.1 写「electron（**peer**，版本来自 catalog）」。已加 `peerDependencies: { "electron": "catalog:" }`
（bun 支持 peer 里写 `catalog:`，已实测解析成功），devDependencies 里不再重复列它。

### 六、CSP 与 06 页 §4.8 的表不一致

06 页 §4.8 给了完整的 CSP 表（含 `media-src`、`worker-src`、`form-action`），实现里缺后三格。
已按表补齐安装版与开发版（开发版只额外放开 script 的 `unsafe-inline` 与 localhost websocket）。

### 七、其它小项

- 新增 `packages/core-kernel/src/__tests__/services.test.ts`：06 页 §2.1 的文件清单列了这个文件，
  此前不存在（通用规则在 foundation，但「接进内核 ctx 之后」的判据没有落点），新增 3 例。
- `packages/core-kernel/src/module.ts` 的 `engine` 注释改为 06 页 §2.2 的措辞（注册工具走
  `ctx.agentTools`）—— 该注释描述使用规矩，而不是类型系统里的事实（类型上仍是完整的 `AgentEngine`）。
- `packages/host-kernel/src/__tests__/core-supervisor.test.ts` 补 **S-10d**：06 页 §4.5 的 8 个场景里
  「UI 取消排队中的请求 → `kernel.cancelled`」此前只由 rpc-hub 的透传用例间接覆盖，现直接钉住。
- `packages/workbench/src/parts.css`：删掉 `.workbench__panel*`（底坞自绘面板）与
  `.workbench__status*`（状态栏）两批**全仓已无消费者**的规则 —— 它们随底坞（偏差 #45）与
  状态栏（偏差 #7）的删除失效，留着会让人以为外壳还有这两块家具。

### 八、逐条复核后保留的现状（与 06 页原文的差异，均有用户裁决）

| 项 | 06 页原文 | 现状 | 依据 |
| --- | --- | --- | --- |
| 状态栏 / `statusItems` 的渲染 | §6.2 布局图与渲染规则表要求 StatusBar | 不设状态栏；`builtinPoints.statusItems` 定义保留、无宿主 | 用户 2026-10-05 裁决（偏差 #7） |
| 底坞 / `toggleBottomPanel` | §6.2 布局图有 Bottom 坞、§6.3 有 `Ctrl+J` | 底坞整块删除，终端回右栏 | 用户 2026-10-07 裁决（偏差 #45/#46） |
| 横幅（`banners` 行） | §6.2 布局图有横幅行 | 删除该行，横幅走 design-system 通用 `Banner` 浮层 | 用户 2026-10-06 裁决（偏差 #21/#22） |
| 命令面板宽度 | §6.2 写「居中，宽 640」 | `max-w-xl`（576px，与 legacy `command-palette.tsx` 一字不差） | 09 页 §3.4「外观与 legacy 逐一对齐」；方案只给了近似值 |
| `createCoreHarness` 多一格可选 `clock` | §2.8 的签名没有它 | 保留 | 12 页 §1.2 的 FakeEngine 按注入 Clock 排下一拍；不共用同一个 fakeClock 时「时间线增量永远不来」——这一格是两个时钟必须同源才加得出来的缝（文件里有头注） |
| `core-kernel` 的 K-7 用真实时钟 | §2.7 表写「5 秒（fakeClock）」 | 真实时钟，8 秒余量 | 06 页 §4.7 的 S-* 才是注入时钟的那一层（`CoreSupervisor(clock)`）；kernel 的 shutdown 超时是常量、没有时钟注入缝 |

### 验证

| 命令 | 结果 |
| --- | --- |
| `bun run typecheck` | ✅ exit 0 |
| `bun run lint`（biome + no-raw-errors + no-biome-ignore + depcruise） | ✅ exit 0，depcruise **0 违规** |
| `bun run check` | ✅ **1394 pass / 0 fail**（180 文件 / 4596 断言） |
| `bun run core:build` + `core:probe` | ✅ 全绿（隔离自检 + 假用户目录零写入 + 优雅退出） |
| A-K5（真机） | ✅ 临时摘掉 `terminal.open` 的处理器 → 启动退出码 1，`logs/main.log` 写着「未实现的 Host 方法：terminal.open」 |
| A-K6（真机） | ✅ 见上文 |



## 08 数据与存储符合性审查与整改（2026-10-08）

以 08 页为绝对权威逐条取证，整改 8 类不符；详见
`Project Refactoring Plan/Refactoring Progress/08 数据与存储 符合性审查与整改进度报告.md`。

### 偏差（本轮新增）

| # | 日期 | 事项 | 类型 | 原因 |
| --- | --- | --- | --- | --- |
| 59 | 2026-10-08 | `usage_events` / `usage_messages` 去掉 `AUTOINCREMENT`（DDL 与 08 §5 逐字一致）；`automations` 两份 DDL 的列对齐与空格还原为 08 §5 原文 | 改（回到方案原文） | 08 页 §5 要求全部 DDL **原样**作为迁移的 `sql` 字段。`AUTOINCREMENT` 会多建 `sqlite_sequence` 表（越过模块前缀闸门，也非方案形状）；对齐与空格是「原样」的字面要求 |
| 60 | 2026-10-08 | `ui-state.json` / `keymap.json` / `window-state.json` 三个文件改为走 `createJsonDocument`（08 §6.1/§6.2） | 改（回到方案原文） | 方案点名这三个文件的读写只经 `createJsonDocument`；旧实现自写 `readFileSync` + `JSON.parse`，坏文件静默忽略，且绕过 `writeFileAtomic` 的「临时文件 → fsync → 改名」 |
| 61 | 2026-10-08 | `UiState` schema 移入 `features/preferences/src/contract/entities.ts`，键为封闭枚举；`ui-state-service` 只做读写 | 迁 | 08 §6.2 的文件表把 schema 位置写在契约实体；枚举外的键按 §6.1 的剥离语义丢弃 |
| 62 | 2026-10-08 | `platform` 增加对 `@poietica/feature-browser/contract` 的依赖（用 `BROWSER_PARTITION` 清内置浏览器分区） | 新增（依赖） | 07 §1D 要求 `storage.clear` 清**浏览器分区**；分区的唯一产地是 browser 的 contract 常量。03 §5.4 的依赖图未列这条边 —— 见进度报告「保留的已知差异 B」，等方案确认 |
| 63 | 2026-10-08 | `root`、`logsDir` 的创建从 host-kernel 的启动步骤提前到 `configureAppIdentity` | 迁 | 08 §1 的「谁创建目录」表明确两者由 Host `app-identity.ts` 在启动第一步（日志之前）创建 |
| 64 | 2026-10-08 | 撤销 workspaces 在 `onReady` 预创建 `scratchDir` | 迁 | 08 §1 表：`scratch` 由对应 Core 模块**第一次写入时** `ensureDir` |

### 待决问题（本轮新增）

| 编号 | 日期 | 问题 | 现状 | 处理 |
| --- | --- | --- | --- | --- |
| Q30 | 2026-10-08 | 07 §2B 的 `UiStateKey` 列了 5 个键，实现里有 8 个（多 `conversation.permissionPosture`、`mascot.autoTour`、`mascot.followPointer`） | 保留现状（P6 的产品需求引入） | 按守则 11：`ui-state.json` 的键是封闭枚举，增键必须改契约；是否把这 3 个键补进 07 §2B 原文由方案确认 |
| Q31 | 2026-10-08 | 03 §5.4 的 UI 依赖图未列 `platform → browser/contract` | 已按 07 §1D 实现（见偏差 #62） | 等方案确认：补边、或另给 `BROWSER_PARTITION` 一个不跨功能的落点 |
| Q32 | 2026-10-09 | `~/.agents/skills`（如 `hindsight-coding-agent`）在加号面板里不出现：本仓按 12 页 §5.2 把 `agents` 也列进了 `FOREIGN_PROVIDERS`（14 个），而 **legacy 只禁 11 个、没有 `agents`**，所以 legacy 读得到这份技能、现在读不到（真机取证见上文「真机复测第二版」的表） | 加号面板的技能组因此恒少一份；`A` 保持现状（用「从文件夹安装」导入）/ `B` 回到 legacy（把 `agents` 从禁用表拿掉，§5.2 同步改） | **已裁决：选 B**（产品负责人 2026-10-09：「这个是全局的 skill，应该放开」）。`FOREIGN_PROVIDERS` 去掉 `agents`（14 → 13）；新增 `RELEASED_PROVIDERS` + `releaseForeignProviders`，启动时先把旧版本写进 `disabledProviders` 的 `agents` 撤掉（真机配置里已有这一格，只改常量会让修复当场失效）；T-ISO-6 改为「`.claude` 仍被挡、`.agents` 已放行」。详见「外来 provider 放行」一节 |

## 07 功能包详细设计符合性审查与首批整改（2026-10-08）

以 07 页为绝对权威逐功能取证（15 个功能 × 契约/行为/必测），审查结论与逐条证据见
`Project Refactoring Plan/Refactoring Progress/07 功能包详细设计 符合性审查报告.md`。

按产品负责人指示，本轮先做**最重两条**：python 安装链路（U1–U4）与 conversation 通知（U5）。

### 本轮整改（回到 07 页原文）

| # | 日期 | 事项 | 证据 |
| --- | --- | --- | --- |
| 65 | 2026-10-08 | 新增 `scripts/pin-python.ts`（07 §13C 完整代码）并跑出真实校验和：`release.generated.ts` 由全 0 占位改为 `52124cee…6aaa`；`release.test.ts` 增加「不是占位值」断言，堵住假绿 | 07 §13C / §13G PY-7；此前该常量是 64 个 0，`release.test.ts` 的正则被它通过，而每一次真实安装都会在校验处失败 |
| 66 | 2026-10-08 | `installer.ts` 下载改为**按字节**落盘（不再 `Blob.text()`），加 `AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)`、按 URL 删掉校验不符的文件、失败码区分 `download_failed` / `checksum_mismatch`、进度按 250ms 节流上报 | 07 §13C 步骤 1–3；原写法把 tar.gz 按 UTF-8 重编码，解压必炸 |
| 67 | 2026-10-08 | `python/core/index.ts` 的 `onReady` 补「清理 `python.staging-*` / `python.old-*`」与「解释器设置指向本目录且标记不符 → 清空」；判据抽成 `onReadyPlan` 便于断言 | 07 §13C 的 onReady 一行；为此在引擎端口加 `getPythonInterpreter()`（engine / engine-omp / engine-testkit 三处同步） |
| 68 | 2026-10-08 | python 必测补齐：`installer.test.ts`（PY-1/2/3/5 + 字节原样落盘）、`module.test.ts`（PY-4 busy、onReady 不误改设置、失败不写解释器） | 07 §13G PY-1…PY-6 |
| 69 | 2026-10-08 | conversation 补「一轮结束」系统通知：`turns.state` 从 running/awaiting 回 idle 时按 `completionBody` 发 `notify.show`（判据抽成 `isTurnSettled`，首帧 idle 不算结束） | 07 §5E 通知表；`completionBody()` 此前写好但**零调用点** |
| 70 | 2026-10-08 | conversation 补 `notify.clicked → openThread` 导航（threadId 为空时不跳） | 07 §5E 通知表最后一行 / 14 页 §9 第 7 条 |
| 71 | 2026-10-08 | conversation 补 `threads.close`：新增 `ui/thread-lifecycle.ts`（挂载预热 / 卸载释放，StrictMode 双渲染净零）并接进 `conversation.thread` 表面 | 07 §5E surfaces 一行；`api.closeThread` 此前零调用点 |
| 72 | 2026-10-08 | 新增 `scripts/tsconfig.json` 并把 `scripts/tsconfig.json` 登记进 `tooling/refs/sync.ts` 的 `PROJECT_PATTERNS` | 编辑器工程映射：`scripts/pin-python.ts` 此前不属于任何 project，VS Code 报 6 条 TS2591/TS2339（`node:fs`、`process`、`import.meta.dir`）。判据与偏差 #17 同款；`bun run refs` 会自动生成 `scripts → features/python/src/core` 的引用 |

### 本轮裁决（产品负责人）

| # | 日期 | 事项 | 裁决 |
| --- | --- | --- | --- |
| D1 | 2026-10-08 | usage 的 `tokenDays` / `modelDays` 聚合为 `{day,tokens}` / `{day,model,tokens}`，**无 `cost` 字段**，与 05 §11.14 / 07 §14C 原文的字段形状不一致 | **故意如此**（产品负责人 2026-10-08）：相关 UI 已删除，费用不再上屏。07/05 原文的字段表按此追认；U9 不再算不符 |

### 本轮未做（等指示）

- 07 符合性报告里的 U6（conversation core 三文件拆分）、U8（models 默认模型入口）、U10（extensions 两个错误码不可达）、U11（review 未跟踪文件行数）、U12（workspaces 错误码与侧栏贡献点）等，按「先做最重两条」执行，未动。

## 07 第二批整改（U11 → U12 → U10 → U6，2026-10-08）

按产品负责人指定的顺序执行第二批。

### 整改

| # | 日期 | 事项 | 依据 |
| --- | --- | --- | --- |
| 73 | 2026-10-08 | review 的未跟踪文件不再恒报 `+0 −0`：按文件自身行数计（末尾无换行也算一行）；含 NUL 字节或非法 UTF-8 记 `binary: true`、行数 0；读失败同样记二进制而不炸整次 review | 07 §10C「未跟踪文件的行数用文件行数计」；新增 3 例（行数 / 二进制 / 空文件） |
| 74 | 2026-10-08 | workspaces `rename` 空名改抛 `kernel.invalid_params`（原为 `workspaces.not_found`，文案却是「工作区名字不能为空」）；测试钉住错误码 | 07 §3C。**同条的 UI 一半不动**：§3E 要求的工作区选择器 `sidebarSections` 与产品负责人 2026-10-05/06 的裁决（选择器按 legacy 落在会话列表组头、设置页删除）冲突 —— `ui/index.tsx` 原注释称「已记入 refactor-log」但检索不到，本次补齐记录，不再新增侧栏段落 |
| 75 | 2026-10-08 | extensions 补两枚不可达错误码：引擎的 `kernel.invalid_params`（没有 SKILL.md）→ `extensions.invalid_skill_package`；`kernel.not_found`（插件不存在）→ `extensions.plugin_not_found`。翻译放在 Core 调用处（同 07 §10C 的 git 错误码转换形制），只认那一枚码、别的错原样透传 | 07 §8B/§8C；新增 3 例（两条翻译 + 一条「别的码不吞」） |
| 76 | 2026-10-08 | conversation 的 Core 按 §5C 拆成三份文件：`thread-service.ts`（线程 CRUD / fork / export / 删除 / 工作区级联 / 会话池接线）、`turn-service.ts`（submit / cancel / queue / controls / interactions / timeline）、`event-router.ts`（EngineSessionEvent → 通知与 Core 事件，含回合运行时）；`conversation.ts` 只做装配与转发 | 07 §5C 的文件清单与两张服务行为表。562 行 → 装配 283 行 + 三个职责文件（242 / 237 / 171）；对外 API 一字未改，119 例 conversation 测试全绿 |

### 验证

| 检查 | 结果 |
| --- | --- |
| `bun run check` | ✅ 见提交信息（typecheck / biome / no-raw-errors / depcruise / 全仓测试） |
| conversation | ✅ 119 例（拆分前后同一套，未改断言） |
| review / workspaces / extensions | ✅ 新增 6 例，全部通过 |

## P7 打包发布 + P8 收尾（2026-10-08）

按 15 页 §10–§11 执行。本机实测到安装包（187 MB）与 `desktop:build` 全绿。

### 新增产物

| # | 文件 | 依据 |
| --- | --- | --- |
| 77 | `apps/desktop/resources/icon.ico`（6 档：16/24/32/48/64/256）+ `icon.png`（512×512），**入库** | 03 页 §3.1「图标 icon.ico（入库！legacy 的图标在被忽略的 build/ 里，没有提交）」；15 页 §10.4 的 `directories.buildResources: resources`。图标本体取自 legacy 历史里的 Tauri 版应用图标（`apps/desktop/src-tauri/icons/`，commit `12a8332b5`），与 legacy 现行托盘的品牌一致 |
| 78 | `tooling/release/set-version.ts` + `bun run version:set <x.y.z>`；`tooling/release/__tests__/versions.test.ts` | 15 页 §10.1（版本唯一来源是 apps/desktop，apps/core 必须相同；测试随 `bun run check` 跑）；实测 0.5.0 → 0.5.1 → 0.5.0 往返正确 |
| 79 | `apps/core/scripts/verify-dist.ts` + `bun run core:verify-dist` | 15 页 §10.2（逐产物 sha256 与 manifest 比对 + 断言 `probe === false` + omp 版本与 catalog 一致）；实测通过 |
| 80 | `apps/desktop/scripts/smoke.ts` + `bun run desktop:smoke <安装包>` | 15 页 §10.6 的七步（静默装 → 起 → core.pid 与进程名 → 隔离比对用户目录 → core.log 无 error → 不带 /F 退出 → 静默卸载后数据根仍在） |
| 81 | `.github/workflows/release.yml` + `docs/release-notes/0.5.0.md` | 15 页 §10.5（tag `v*` 触发：校验 tag 与 version → check → core:build/probe → verify-dist → desktop:build → electron-builder → smoke → 建草稿并上传 3 个文件） |
| 82 | `docs/ARCHITECTURE.md` 重写（现状文档，九个章节）、`AGENTS.md` 增补（九步新增功能 / 升级 omp / 禁止事项 / 新命令）、`README.md` 重写（安装、开发命令表、文档索引） | 15 页 §11.1 |
| 83 | 清掉 16 条 lint warn（未用参数 / 未用私有成员 / 可选链 / 字面键；两条 CSS 规则按精确路径登记进 `biome.json` 的 overrides） | 15 页 §11.2 第 4 条「`bun run check` 的输出中没有任何 warn 级别的 lint 告警」（连 legacy 原文里那条深色焦点规则的降序特异性 warn 也一并处置） |

### 偏差（本轮新增）

| # | 日期 | 事项 | 类型 | 原因 |
| --- | --- | --- | --- | --- |
| 84 | 2026-10-08 | `apps/desktop/package.json` 的 `electron-updater` 写**字面版本** `^6.8.9`，不写 `catalog:` | 例外（铁律 9） | electron-builder 直接读这个字段做版本判据，遇到 `catalog:` 会中止打包（实测报「At least electron-updater 4.0.0 is recommended … Received \"catalog:\"」）。`tooling/release/__tests__/versions.test.ts` 加一条测试钉住它与根 catalog 同源，改一处忘另一处就红 |
| 85 | 2026-10-08 | `apps/desktop/package.json` 补 `description` 与 `author` | 新增 | electron-builder 警告缺这两个字段（`description is missed` / `author is missed`），NSIS 的版本资源读它们；不补将来「任务管理器显示 Poietica」那一栏的元数据会缺格 |

### P8 §11.2 逐条状态

| 条 | 状态 |
| --- | --- |
| 1. refactor-log 的「待决问题」与「待处理」清零 | ⚠️ **未清零**：余下 Q17–Q31 是「等方案确认」的设计问题（详见下面「交接」）。它们需要产品负责人/方案方裁决，按守则 11 执行者不能自行关闭 |
| 2. 09 页映射表标记「删」的 legacy 条目在仓库里全部不存在 | ✅ legacy 代码不在新树（只有 `docs/` 与 `Project Refactoring Plan/` 的文档提到它） |
| 3. `rg "TODO|FIXME|XXX"` 没有结果 | ✅ 无命中（`todo-*`、`CONVERSATION_TODO_*` 是待办面板的正式命名，不是遗留标记） |
| 4. `bun run check` 输出无 warn 级 lint 告警 | ✅ biome 零 error、零 warn（本轮清掉 16 条） |
| 5. 根 package.json 的脚本都有用 | ✅ 逐个核对：`typecheck` / `refs` / `lint` / `test` / `check` / `format` / `dev` / `core:build` / `core:probe` / `core:verify-dist` / `desktop:smoke` / `protocol:snapshot` / `desktop:build` / `dist` / `version:set` / `desktop:dev` / `new:package` / `new:feature` / `python:pin` 全部指向存在的文件 |

### P8 补漏：两处工程映射缺口（2026-10-08）

编辑器报出的 19 条 TS2591/TS2339/TS2534/TS7006 全部指向同一个根因 —— **有源文件不属于任何
tsconfig 工程**，于是编辑器回落到无类型定义的推断工程（`node:*` 解析不到，`process` 不存在，
连 `process.exit` 都不被认成 `never`、回调参数推断成隐式 `any`）。仓库自己的
`bun run check` 一直是绿的，因为 `tsc -b` 根本没把这些文件收进程序。三处缺口：

| # | 日期 | 事项 | 依据 |
| --- | --- | --- | --- |
| 86 | 2026-10-08 | **`apps/core` 此前完全没有 `tsconfig.json`**：`apps/core/src` 的四个源文件（`main.ts` / `serve.ts` / `modules.ts` / `version.ts`）从未被 `tsc -b` 检查过，而 10 页的 `PROJECT_PATTERNS` 里明明列着 `apps/core/tsconfig.json`。补建（extends `tooling/tsconfig/bun.json`，`include: ["src","scripts"]`，`types: ["bun","node"]`），`bun run refs` 自动接上它对 9 个功能 core 与 8 个平台包的引用 | 03 页 §3.2 的预设表（apps/core 用 bun 预设）；03 页 §3.1 的目录树要求 `apps/core/tsconfig.json` 存在 |
| 87 | 2026-10-08 | `apps/*/scripts/**` 下的脚本（`apps/core/scripts/build.ts`、`probe.ts`、`verify-dist.ts`、`apps/desktop/scripts/smoke.ts`）此前不属于任何工程。`apps/core/scripts` 随 #86 一并收进 `apps/core` 工程；`apps/desktop/scripts` 另建工程（extends `tooling/tsconfig/node.json`，与 renderer 的 dom 预设分开），并把它加进 refs 的 `PROJECT_PATTERNS` | 10 页 §3.1 的「编辑器工程映射」判据（测试/脚本要有往上找得到的 project）；`tsconfig.tests.json` 里早已列了 `apps/*/scripts/**/*.test.ts`，说明脚本目录本就该被纳管 |

**影响**：修前 `apps/core/src` 的全部代码（Core 的入口与组装层）只有 `bun test` 与
`core:build` 两道间接保护，没有类型闸门；修后两者都在 `tsc -b` 里。强制全量检查
（`tsc -b apps/core apps/desktop/scripts --force`）零错误 —— 说明这些代码本身是好的，
缺的是**闸门**。

## 加号面板的「技能 / MCP」两组恒为空（2026-10-09，产品负责人报障）

**现象**：点输入框左下角那枚加号，面板里只有「添加文件」与「模式」两组，
「技能」与「MCP」两组永远不出现（真机截图）。

**根因**：07 页 §5E 迁移时**没给技能 / MCP 名册留数据落点**。面板那两组由
`skills.length > 0` / `mcpServers.length > 0` 决定显隐（`composer-actions.tsx`），
而名册来源 `AgentCapabilityStore` 在 `ui/composition.tsx` 里只被 `new` 出来 ——
全仓没有 `.start(port)`，也没有 `AgentCapabilityPort.readToolkit` 的实现，于是
`useAgentToolkit()` 恒读一份空表。legacy 里这两处分别由 `packages/conversation/src/runtime.ts`
与 `apps/desktop/src/workbench/connections.ts` 接线，迁移时整条线丢了。

**修法（A 案：贡献点，协议不变）**：新增
`conversation.composerToolkitSources`（`ui-api/composer-toolkit.ts`）——
与 attachments 的 `composerProviders`、review 的 `workspaceGitProviders` 同一形制。
extensions 是数据的持有者（`skills.list` / `mcp.status` / `mcp.statusChanged` 都在它那儿），
由它贡献一台来源（`features/extensions/src/ui/composer-toolkit.ts`）：技能按工作区缓存、
只列 enabled 且非 builtin 的；MCP 全局一份，先读一次状态再只吃推送。conversation 侧
`useAgentToolkit(workspaceId)`（`ui/configuration/composer-toolkit.ts`）合成各来源并
换算成面板认的那套字段（`status` / `lastError`）—— **组件与视觉一行未改**。

不选「conversation 契约转发一份」：那会让同一份数据有两个主人（skills / mcp 的
所有权在 extensions），且要么 conversation 的 Core 反向依赖 extensions、要么在
conversation 里重复调引擎，协议还要 +1。贡献点方案协议一行不改。

**顺带删除**：`ui/configuration/capability-store.ts`、`ui/agent/capability.ts`、
`ui/components/configuration/agent-controls-context.ts`（以及 composition 里的 `new`）——
`controls` 那一半早已由 `controls.draft` / `controls.*` 取代，名册那一半由上面的贡献点
取代，这三个文件已无读者。

**必测（新增）**：conversation 侧 `composer-toolkit.test.ts`（合并 / 去重 / 换算 /
`read` 引用稳定）、`composer-toolkit-hook.test.tsx`（无来源为空、来源在上屏、换工作区
触发 ensure、数据不变不重渲）、`composer-submit.test.tsx`（面板点技能 → 正文落一枚记号
→ 提交时 `skills` 里带着名字）；extensions 侧 `composer-toolkit.test.ts`（内置 / 停用
过滤、按工作区缓存、MCP 全局一份、`skills.changed` 重读、`mcp.statusChanged` 整份替换、
Core 重启重读、读失败保留旧值下次重试、数据没变不叫订阅）。

**顺带修掉一条全仓性的渲染死循环（found while fixing this）**：`home-surface.tsx` 里
`const draft = stored ?? {}` 每次渲染都造一个新对象，而它是 `readDraft` 的依赖 ——
引用一换，取草稿表的那条 effect 每帧重跑，`setControls` 每次交回新数组，于是
渲染 → effect → setState → 渲染地转个不停。真机上的表现是入口页反复重取
`controls.draft`；测试里的表现更硬：React 的 `act()` 要等更新队列清空，这条循环让它
永远等不到（全仓 33 例 DOM 用例连带超时，二分定位到 5f2bc2fe「Core 即时回显」引入）。
改用模块级的 `NO_SELECTION` 常量收掉，`bun run check` 由 38 红转全绿（1491 例）。

**动效与 happy-dom**：`composer-submit.test.tsx` 用 `MotionConfig skipAnimations` 按住
面板开合的动画 —— happy-dom 的 `Element.animate` 不推进时间轴，动画中途被取消时 motion
会 reject 一个没人接的 `finished` promise，足以判用例失败（真机不会）。改系统偏好那条路
不行：motion 首次读取时会把它缓存住。

### 真机复测第二版：MCP 恒空、技能恒空（2026-10-09，产品负责人报障）

第一版上线后真机仍然两组都不出现。逐条探到**两个各自独立的原因**：

**一、MCP：名册读错了端口（这一版修）。** 上一版只调 `mcp.status()`，而它汇总的是
**活会话**的 `mcpManager`（12 页 §3.14）——一条会话都没跑过时恒为空数组。真机上
「设置里明明有 chrome-devtools、加号里却不出现」就是这个：名单在**配置**里
（`<ompAgentDir>/mcp.json`，`mcp.list` 才读它），状态只在会话起来之后才有。

修法：`Promise.all([mcp.list(), mcp.status()])` —— 名单决定画几行（次序跟配置走），
状态按名字贴上去；状态表里没有的（还没开会话）画「未连接」而不是不画。停用的服务器
同样画「未连接」（面板这一层只说「这一句用不上它」，启用与否归设置页）。
`ToolkitMcpServer.state` 由 `disabled` 改成 `disconnected`，与面板的四档对齐。
新增两例：还没跑过会话时配置里的服务器照画（就是这一处报障的形状）、停用的画成未连接。

**二、技能：新版比 legacy 多禁了一个 provider，把 `~/.agents/skills` 一起挡掉了（待裁决）。**
真机取证（`packages/engine-omp` 里跑一次性探针，隔离根 = 真配置的副本）：

| 配置 | `discoverSkills` 结果 |
| --- | --- |
| `disabledProviders` 不含 `agents`（**legacy 的表**，11 个） | `[{name:'hindsight-coding-agent', level:'user'}]` ✓ |
| 含 `agents`（**本仓的表**，14 个） | `[]` |

把技能装进 `<ompAgentDir>/skills/` 则两种配置都能发现 —— 这一点与第一版结论一致。

也就是说：**legacy 读 `~/.agents/{skills,rules}`（它只禁了 11 个），本仓按 12 页 §5.2 补齐到
14 个时把 `agents` 也加了进去，那份技能因此不再出现。** 真机 legacy 的
`%APPDATA%\Poietica\agents\config.yml` 里正是那 11 个（无 `agents`），是这条判断的直接证据。

按守则 11 **不猜**：12 页 §5.2 把 `agents` 归进「跨工具的用户目录，全部禁用」是有据的
（本仓只认自己的配置），而「legacy 能读到、现在读不到」是一次真实的行为回退。两者
只能由产品负责人选一个，故记入待决问题：

- **A（保持现状 / 方案原文）**：`agents` 继续禁用。用户要用那份技能，走设置页「从文件夹安装」
  （`skills.install` → 复制进 `<ompAgentDir>/skills/`）。加号面板这一版不动。
- **B（回到 legacy 行为）**：把 `agents` 从 `FOREIGN_PROVIDERS` 里拿掉，`~/.agents/{skills,rules}`
  照旧可读。代价是「产品只认自己的配置」这条隔离承诺松一格，且 12 页 §5.2 的表要同步改。

Q32 已裁决选 B，见下面「待决问题」与「外来 provider 放行」一节。

### 外来 provider 放行 `agents`（2026-10-09，产品负责人裁决）

Q32 裁决选 **B**：`~/.agents/{skills,rules}` 是跨工具共享的**用户级**目录（全局技能的家），
legacy 照读，本仓也照读。

- `FOREIGN_PROVIDERS` 去掉 `agents`（14 → 13 个）。
- 新增 `RELEASED_PROVIDERS = ['agents']` 与 `releaseForeignProviders()`：老用户的
  `config.yml` 里已被旧版本写进 `disabledProviders`（真机就是这一格），只改常量会让修复
  当场失效 —— 启动时在 disable **之前**先逐个 `enableProvider` 并 flush 一次；幂等，
  没写过就不写盘。
- T-ISO-6 改为断言「`~/.claude` 技能被挡、`~/.agents` 技能被读」，仍钉住
  「开会话之前就已生效」。
- 代价：omp 的 provider 只能整开整关，`~/.agents` 的用户级 skills/rules 与项目级
  `.agent(s)` 会一起放行；12 页 §5.2 的「14 个」按此追认为 13 个。

## 目标模式设置目标当场报错、计划模式发送后一片空白（2026-10-09，产品负责人报障）

**现象**：在输入框点「目标」再发消息，顶部挂出
`AppError: undefined is not an object (evaluating 'this.#tools')`；点「计划」再发消息，
用户气泡与 AI 回复都没有，只剩一片空白（能打字的界面在，但转录区什么都没有）。

**根因**：`packages/engine-omp/src/omp-session-adapter.ts` 的 `planSessionOf` / `goalSessionOf`
两处把 omp 会话的 `setActiveToolsByName` **从会话对象上摘下来再裸调**：

```ts
const apply = session.setActiveToolsByName
if (apply === undefined) missing()
await apply(names)   // ← this 丢了
```

omp 的 `AgentSession.setActiveToolsByName` 是类方法（`agent-session.ts:6011`），内部读自己的
私有字段 `this.#tools`。方法一离开接收者，`this` 就是 `undefined`，Bun 抛出的正是截图里的原句
（已用最小脚本复现同一句话）。两条症状同源：

- 目标：`session-port.prompt` 在提交前先 `api.setGoal(threadId, 正文)` → 进 `applyGoal` →
  `setActiveToolsByName` 当场抛错 → 发送流程中断，顶部错误横幅就是它。
- 计划：入口页的「计划」开关在 `prepare()` 里铸号之后补调 `api.setPlanMode` → 进
  `applyPlanMode` → 同一处抛错。此时线程号**已经铸出来**、界面已切到新线程，而失败记录
  落在提交前那个空键上 —— 新线程页什么都画不出来，就是那块空白。

**为什么此前没被抓住**：`plan-goal-e2e.test.ts` 的假 AgentSession 用**箭头函数**写
`setActiveToolsByName`（箭头函数没有自己的 this，怎么调都不炸），于是这条缺陷从
单测里溜过去了 —— 同类缺陷的判据要落在「方法是不是真的读了 this」上。

**修法**：判空仍然落在方法本身（保留上一次修复的判据），调用改成**可选成员调用**，
接收者（this）随方法一起保留：

```ts
if (session.setActiveToolsByName === undefined) missing()
await session.setActiveToolsByName(names)
```

`AgentSession` 其余被用到的口（setPlanModeState / setGoalModeState / setPlanProposalHandler /
setPlanReferencePath / sendPlanModeContext …）在适配器里本来就是成员调用，不受影响；
`createPlanner` 里批准之后那次还原用的也是 `d.session.setActiveToolsByName?.(...)`，无需动。

**回归用例**：`plan-goal-e2e.test.ts` 的假会话把 `setActiveToolsByName` 改成
**读 this 的方法**（`this.appliedToolSets += 1` 做探针），修复前 5 条端到端用例全红且栈帧
直指适配器两处，修复后全绿 —— 这批用例从此能钉住「别把会话方法摘下来」。

**验证**：`bun run check` 1493 pass / 0 fail（194 文件 / 3 snapshots / 4880 断言），
类型检查与 lint（biome + no-raw-errors + no-biome-ignore + depcruise）全过。

## 测试文件在编辑器里恒报 `bun:test` / `Bun`（2026-10-09，产品负责人报障）

**现象**：`apps/desktop/src/renderer/__tests__/archive-thread.test.tsx` 的编辑器问题面板 6 条红 ——
`TS2307 Cannot find module 'bun:test'` 加 5 条 `TS2868 Cannot find name 'Bun'`；`bun run check` 全绿。
换一个测试文件还是这样（"老是有测试文件这样"）。

**根因**（用仓外的 tsserver 5.9.3 复现，判据落在"这个文件属于哪个工程"上）：
`tooling/tsconfig/base.json` 把 `**/__tests__/**`、`**/*.test.ts(x)` 一律 exclude（测试规则更松，
也不进 `tsc -b`）。编辑器的工程映射是**从文件往上找第一个「包含它、且没排除它」的 `tsconfig.json`**；
一路找不到，文件就落到没有类型定义的推断工程（`/dev/null/inferredProject*`），第一行 `bun:test`
当场 TS2307，`Bun` 报 TS2868。所以每个测试文件都要有一个"往上找得到、且包含它、且 `types` 里有 bun"
的工程 —— 偏差 #17 给 `features/`、`packages/` 补过容器工程，这次缺的是 `apps/` 与 `tooling/`。
（`tsserver` 的 `projectInfo` 直接给出归属文件，是这条判据的可执行形式。）

| 文件 | 修前归属 | 修后归属 |
| --- | --- | --- |
| `apps/desktop/src/renderer/__tests__/archive-thread.test.tsx` | `inferredProject1*`，6 条红 | `apps/tsconfig.json`，0 条 |
| `tooling/refs/__tests__/sync.test.ts` | `inferredProject2*`，同样红 | `tooling/tsconfig.json`，0 条 |
| `packages/foundation/src/__tests__/errors.test.ts` | `packages/tsconfig.json` | 同左（#17 的修法确实有效） |
| `features/conversation/src/core/__tests__/title.test.ts` | `features/tsconfig.json` | 同左 |
| `apps/core/src/main.ts`（非测试，对照） | `apps/core/tsconfig.json` | 同左 |

**修法（两个缺口，两种写法）**：

1. 新增 `apps/tsconfig.json`：extends 根 `tsconfig.tests.json`，include 只收
   `*/src/**/__tests__/**/*`、`*/src/**/*.test.ts(x)`、`*/scripts/**/*.test.ts(x)` ——
   与 `packages/tsconfig.json`、`features/tsconfig.json` 同款容器工程。它不在 `refs` 的
   `PROJECT_PATTERNS` 里、也不被根 `tsconfig.json` 引用，所以 `tsc -b` 与 `bun run refs` 不受影响。
2. `tooling/tsconfig.json`：容器目录与工程同名，没法再放第二个容器工程，于是把 exclude 覆盖成
   `["${configDir}/.tsbuild"]`，把测试留在工程里。#17 当年"往 include 补测试 glob"是**无效的** ——
   include 命中后还要再过一遍继承来的 exclude，等于没加。代价：tooling 的测试从此进 `tsc -b`
   （与工程同一套规则，已强制全量验证 0 错）；其余测试仍只走 `tsconfig.tests.json`。

**闸门**：新增 `tooling/checks/editor-project-map.ts`，接在 `bun run lint` 里。它对仓里 213 个测试
文件逐个做同一套"往上找"判定，要求覆盖它的工程解析后的 `types` 含 `bun`；不满足就 exit 1 并列出
文件与两种修法。反向验过三轮：抽掉 `apps/tsconfig.json` 的测试 glob → 红（列 4 个文件）；拿掉
`tooling/tsconfig.json` 的 exclude 覆盖 → 红（列 7 个）；在 `scripts/` 新建一个测试文件 → 红（列 1 个）；
恢复后绿。另修掉闸门自己的一个洞：最初按目录名跳过 `release/`、`out/`、`dist/`，把**源码目录**
`tooling/release/` 一起跳过了（4 个测试文件不在扫描范围），改成只跳过已知产物路径。

**验证**：tsserver `semanticDiagnosticsSync` 对上述测试文件 0 条诊断（修前 6 条）；`bun run typecheck` 与
`bun run lint`（biome + no-raw-errors + no-biome-ignore + editor-project-map + depcruise）全过；
`bun test` 1508 pass / 1 fail —— 唯一那条 `T-PROTO-SNAPSHOT`（契约快照与代码不一致）在本次改动**之前**
就是红的（工作区里 `packages/protocol` 一行未改，git 里也没有未提交改动），与本项无关：它要维护者先定
是否提升 `PROTOCOL_VERSION`，再跑 `bun run protocol:snapshot`，按守则 11 不替产品负责人猜。

顺带：`bun x biome check --write .`（即 `bun run format`）修掉 4 个**已提交**文件里的格式与 import 排序
（`features/conversation/src/ui/index.tsx`、`ui/control-shapes.ts`、`ui/components/skill-document-store.ts`、
`packages/engine-omp/src/__tests__/controls.test.ts`）—— 纯排版、无语义变化；这 4 条在改之前也让 `lint` 红着。

## R-01 排队 / 插话链路：附件丢失、撤回错条、换层丢内容、认领表泄漏（2026-10-09）

**来源**：产品负责人交办的缺陷报告 `R-01 排队 插话链路：附件丢失、撤回错条、换层丢内容、认领表泄漏.md`
（外部输入，不入库）。六个缺陷 A–F 共用一条根因：队列项的**身份**与**完整内容**只在
`OmpSession.ledger` 里，而端口没有按项操作、UI 又把 id 丢了。

**改法**（严格按报告 §3 的设计）：

1. **投递正文唯一产地**：`prompt.ts` 新增 `wireTextOf()`（原文 + 每个文件一行 `@绝对路径`），
   `preparePrompt` 与 adapter 的 `host.steer` 共用它。排队 / 插话从此**不再丢文件**（缺陷 A）。
2. **按项操作**：`OmpSessionHost` 删掉 `popLastQueued` / `clearQueue`（清空 + 重投的兜底路径
   **一并删除**，不留），换成 `removeQueued(text, deliverAs)` → omp 的
   `removeQueuedMessage(text, queue)`。撤回不再依赖「最后一条」的假设（缺陷 B、C）。
3. **账本带 id 与完整输入**：`QueueEntry` 扩成 `{id, text, wireText, skill, deliverAs, createdAt, input}`，
   `reconcileQueue` 按 `wireText` 匹配、对不上不丢弃而是搬进 `consumed`；`enqueue` / `moveQueued`
   走同一条 `serial()` 串行链，账本顺序 = omp 队列顺序（缺陷 B 的顺序 / 漏账）。
4. **换层落到服务端**：`EngineSession.moveQueued(queueItemId, deliverAs)` + 契约新增
   `queue.move`（`PROTOCOL_VERSION` 7 → 8）。用账本里的原始输入重新入队，图片 / 文件 / 技能
   全保留；Core 用 `pool.peek`（不开冷会话），`queue.withdraw` 同样改成 `peek`。
5. **认领有生命周期**：`injected: string[]` → `consumed: QueueEntry[]` + `ownPrompt`。
   本轮自己的 prompt 按 `wireText` 排除；会话回到 idle 时两格全清（abort 丢弃的队列项也在
   这里作废）；`message_start` 与 `queue_update` 两种到达顺序都只画一次（缺陷 F 的重复气泡）。
6. **技能插话上屏**：`isUserSkillMessage()` 从 `projector/history.ts` 搬到 `prompt.ts`（只有一份），
   `handleOmpEvent` 的 `message_start` 同时认 `role === 'user'` 与用户技能消息（缺陷 F 的后半）。
7. **UI 保留 id**：`QueuedMessages.steering/followUp` 从 `string[]` 改成 `QueuedItem[]`，
   `AgentSessionPort.withdraw(itemId)` 按号点名，新增 `move(itemId, deliverAs)`；
   `prompt-queue` 换层改调 `queue.move`，**不再撤回 + 重新提交**（缺陷 D、E）。

**必须实测的一条（报告 §3.4 的 aside）**：技能插话在 omp 的 `getQueuedMessages()` /
`queue_update` 里报的是不是 `queueChipText`。结论：**是**。依据 `@oh-my-pi/pi-coding-agent@18.5.0`
的源码（`packages/engine-omp/node_modules/.../src/session/agent-session.ts`）：

- `#queueCustomMessage` 在 `options.queueChipText !== undefined` 时把它写进
  `details.__queueChipText`（第 8213 行附近）；
- `getQueuedMessages()` → `.map(queueChipText)`（第 8591 行），而
  `queued-messages.ts` 的 `queueChipText(message)` 对 `role === "custom"` **先读**
  `readQueueChipText(message.details)`、读不到才退回正文（第 100 行附近）；
- `removeQueuedMessage(text, queue)` 的匹配器 `#findQueuedUserMessage` 先比「原始提交正文」
  再比 `queueChipText`（第 8634 / 8672 行附近），两条都能命中。

因此技能分支的 `wireText` 取 `submit.text`（= 我们传的 `queueChipText`）：对账、撤回、
认领三处同一份字符串。普通 steer / followUp 的 `message_start` 正文也等于 `prepared.text`
（omp 只在有 prompt template 时改写；`@路径` 原样保留，`expandPromptTemplate` 对非 `/` 开头的
文本是恒等函数）—— 这一点由新的 `queue.test.ts` 用真适配器钉住。

**测试**：

- `packages/engine-omp/src/__tests__/queue.test.ts`：Q1–Q10 十条（文件附件、撤回中间项、
  撤回 steer 不动 followUp、技能换层、撤回后重发只画一次、技能插话上屏、两种事件顺序、
  已消费项抛 `engine.queue_item_consumed` 且仍上屏、串行顺序、abort 后同文不重画），
  外加 Q1b：带文件的插话按 `wireText`（含 `@路径`）认领、屏幕上画的是用户原文。
- `packages/engine-testkit/src/conformance.ts`：`C-QUEUE-MOVE`、`C-QUEUE-WITHDRAW-MISSING`
  （FakeEngine 与 OmpEngine 两个实现都要过）。
- `features/conversation/src/core/__tests__/conversation-core.test.ts`：`queue.move` 换层，
  以及无活会话时 `withdraw` / `move` 抛 `kernel.not_found` 且 `engine.opened` 长度为 0。
- `features/conversation/src/ui/components/__tests__/prompt-queue.test.tsx`、
  `ui/stores/__tests__/session-port.test.ts`：UI 按号撤回 / 换层。

**本轮偏差**（记入偏差表）：`prompt-queue` 的撤回 / 换层两枚按钮仍然只画在**最后一行**。
底层现在支持任意一行，但「每行都加按钮」是产品选择、报告 §3.8 明确不在本页范围
（“按钮的位置与样式不动”），所以保持原样，只把语义改成「操作它所在的那一行」。
