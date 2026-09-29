# 0058 — 写入被拒是完整性标签，不是 ACL；绕行按其还原条件撤除

## 状态

已接受，**已落地**。证据链与复发处置在
`docs/runbooks/dev-write-interception.md`（E7/E8 与「复发处置」两节），本文只记
决策与理由。

## 背景

2026-09-25/26 起 `bun dev` 间歇失败，错误形态是 `os error 5`（拒绝访问），
但失败挑对象：

- 从仓库里诞生、或被拷进仓库的可执行文件，其派生进程往**仓外**
  （`%LOCALAPPDATA%`、`%TEMP%`、`.rustup\tmp`）写才被拒；
- 同一份文件拷到仓外就放行；经 junction 调用仍被拒；
- 提权无效、换父进程（WMI）仍拒、与调用时刻无关；仓库内写入始终正常。

当时没找到元凶，只锁定了行为规律，于是留下了一批**机器级绕行**：cargo 产物目录
与 dev 数据根全部移出仓库（两条 junction + 一个用户级环境变量），`paths.rs` 的
debug 分支改指向仓内 `.dev-data`。还原条件当时就写进了 runbook。

2026-09-29 破案。元凶是 **NTFS 对象的强制完整性标签（Mandatory Integrity
Label）**：`D:\xiaojianc\poietica` 与 `D:\xiaojianc\poietica-target` 两个目录对象
带 `Low Mandatory Level:(OI)(CI)(NW)`。Windows 在**进程创建时按镜像文件所在路径**
读取该标签定令牌完整性级别；镜像在 Low 目录里的进程就是 Low，写 Medium/High 对象
属 write-up，被 No-Write-Up 拒。

标签是 OpenAI Codex 桌面版（ChatGPT 应用）的 Windows 沙箱服务打的
（`CodexSandboxService.OpenAI.Codex`，LocalSystem 常驻；服务二进制含
`CodexSandboxUsers`、`SetTokenInformation`、`--write-roots-json` 等串，仓库 DACL
上还留着该工具两个组 SID 的 ACE）。该应用已从本机卸载，服务与本地组一并消失。

## 决定

1. **判据是完整性级别，不是权限。** "ACL 看着没问题、操作却报 EPERM/拒绝访问"
   这类案子，第一步查 `icacls <path> | Select-String 'Mandatory Label'`。

   此前的排除清单（见 runbook「已排除清单」，共 10 行，其中一行整组覆盖 5 个
   minifilter 的卸载对照）**全部落在权限层与过滤器层，一条都没有读完整性标签**。
   这是整整一类机制被漏掉，不是某一项查得不够细：`Get-Acl -Audit` 的 `.Audit`
   集合看不见它（实测 `Audit.Count == 0`，`GetSecurityDescriptorSddlForm('Audit')`
   只回 `S:AI`），只有 `icacls` 会打印那一行。查法是本决定的一部分，不是附注。

2. **绕行按自己写下的还原条件撤除，一次换干净**（AGENTS.md §8）。元凶清除后
   同一次改动撤掉全部机器级绕行：删两条 junction；`poietica-target` 改名回
   `repo\target`（23.6GB 缓存同卷改名带回，无损）；`src-tauri\binaries` 恢复为
   真实仓内目录；删用户级 `CARGO_TARGET_DIR`；dev 数据根 `robocopy /MOVE` 回
   `%LOCALAPPDATA%\com.poietica.Poietica.dev`；`paths.rs` 的 `installed_root`
   debug 分支回到 `None`（→ `app_local_data_dir`）；`.gitignore` 与
   `docs/architecture/data-layout.md` 一并改回。**不留开关双活、不留过渡分支。**

3. **两项改动不撤，因为它们从来不是环境绕行。** `structured_log.rs` 的落点预检 +
   降级（日志初始化失败退到 stdout/webview，而不是 panic）与 `composition.rs` 的
   log 插件注册降级，是**通用健壮性**：与完整性标签无关，任何机器上都可能遇到
   不可写落点，符合 ADR 0006 的功能降级处置。保留。

4. **架构闸门的产物排除必须按名字，不能靠"恰好没被遍历到"。** 还原前
   `src-tauri\binaries` 是 junction，遍历器把 junction 当非目录跳过，所以那份
   36MB 生成 bundle 从没进过判据；一变回真实目录，闸门立刻报 15 条伪违规（把
   bundle 当源码解析动态 import 与相对依赖）。已把 `binaries` 加进
   `tools/architecture/imports.ts` 与 `tools/architecture/charters.ts` 的跳过清单，
   与 `dist` / `target` 同类（产物，不是源码）。

   这不是"为还原让路"——它补的是闸门**原本就有**的盲点：同一份产物是否被审，
   取决于它在磁盘上是不是 junction，这本身就是缺陷。

## 后果

1. 本机 `bun dev` 与 `bun run check` 全链恢复（后者退出码 0），布局回到常规形态：
   `repo\target` 与 `src-tauri\binaries` 都是真实目录，dev 数据根回到平台目录。
2. **"把产物移出仓库"这一类布局绕行今后不必再考虑。** 根因既然只是一个可清除的
   目录标签，搬走产物只是掩盖症状，还额外换来 junction、环境变量与代码分支三份
   机器状态 —— 正是 §8 要消灭的那种债。
3. 复发可一条命令判定、一条命令清除（runbook「复发处置」）。打标签的嫌疑方按
   `CodexSandboxUsers` 本地组、`CodexSandboxService.*` 服务、以及仓库 DACL 上带组
   SID 的 ACE 三个特征找。
4. 闸门对 `binaries` 的排除只影响那一处：全仓只有 `apps/desktop/src-tauri/binaries`
   一个同名目录（实测），且它就是构建产物。

## 本决定之外（机器状态，仅为复盘）

- 本机 Rust 原先装在一个乱码名 profile 下且缺 `rustup.exe`，PATH 指向的空
  `.cargo\bin` 让 `cargo` 不可达（`tauri dev` 因此报
  `cargo metadata: program not found`）。已用官方 `rustup-init`（SHA256 对官方
  校验和验证）重装到 `%USERPROFILE%\.cargo`——正是 PATH 上已有的那一条，故无需
  改 PATH。这是机器维护，不是本仓决策。
- 搬动 cargo 产物目录时，23.6GB 缓存里有 370 个 build-script 的 `output` 烘焙着
  旧绝对路径，导致 `tauri-build` 读不到权限文件（`os error 3`）。已清掉这些条目
  及其 fingerprint 让 cargo 重建。教训：`target/` 不是可随意搬动的纯缓存，
  build-script 输出里的绝对路径会让搬动后的增量复用出错。
