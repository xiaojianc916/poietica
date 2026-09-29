# 事件报告：bun dev 链 os error 5 与 webview 启动失败（2026-09-26 已恢复，2026-09-29 破案）

> 读者注意：本文写给零上下文的接手者（人或 AI）。事实、推断、未知三类信息
> 明确分开标注；所有结论都附实验证据。日期均为 2026-09-26（另有标注除外）。

## 一句话结论

`bun dev` 曾被三个互相叠加的问题压死：**①仓库目录被打了 Windows 强制完整性
标签 Low**（见下节，2026-09-29 破案）—— 已清除，绕行全部还原；**②应用对日志
初始化失败零抵抗**——已改代码降级；**③崩溃风暴遗留的僵尸 msedgewebview2 + 写坏
的 WebView2 用户数据目录**——已清理。三层全部处理后 `bun dev` 完整验收通过
（setup 458ms 走完，窗口正常）。

### ①的元凶（2026-09-29 定案）

决策与理由见 ADR 0058；本节是证据与复发处置。

**根因是 NTFS 对象的强制完整性标签（Mandatory Integrity Label），不是 DACL、
不是 SACL、不是防病毒、不是 minifilter。**

```text
D:\xiaojianc\poietica         Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
D:\xiaojianc\poietica-target  Mandatory Label\Low Mandatory Level:(I)(OI)(CI)(NW)
```

Windows 按**镜像文件所在目录的完整性标签**决定新进程令牌的完整性级别。镜像落在
Low 标签目录里 → 进程是 Low（S-1-16-4096）→ 往 Medium/High 对象
（`%LOCALAPPDATA%`、`%TEMP%`、`.rustup`）写就是 write-up，被 `NW`
（No-Write-Up）拒掉，表现为 os error 5。

**三步对照实测**（同一个 `bun.exe`，只改目录标签）：

| 目录标签 | 进程完整性 | 写 `%TEMP%` |
| --- | --- | --- |
| 无 | High (12288) | **通过** |
| **Low** | **Low (4096)** | **拒（EPERM）** |
| Medium | Medium (8192) | 通过 |

用系统自带的 `cmd.exe` 复现同款结果（仓内拷贝 Low、仓外拷贝 High）→ 与具体
可执行文件无关，只与镜像所在目录的标签有关。

**这一条同时解释了本文原先所有"反常"观测**，无需"标记跟随文件本体"这套说法：

| 观测 | 标签机制下的解释 |
| --- | --- |
| 同卷移动到仓外仍拒 | 同卷改名保留标签（实测：标签随 rename 走） |
| 拷贝到仓外则放行 | 拷贝按**目标目录**重新打标（实测：新副本无标签） |
| 经 junction 调用仍拒 | 标签在目录对象上，junction 解析后仍是同一目录 |
| 提权无效 | 完整性级别不是权限，提权不改令牌 IL |
| WMI 启动仍拒 | 父进程与令牌 IL 无关 |
| 仓内读写正常 | 同级写（Low → Low）不被 No-Write-Up 拦 |
| 与用户身份无关 | 同上，判据是对象标签 |

**元凶**：OpenAI Codex 桌面版（ChatGPT 应用）的 Windows 沙箱。
`CodexSandboxService.OpenAI.Codex`（显示名 "ChatGPT"）以 LocalSystem 常驻，
其 `codex-windows-sandbox-service.exe` / `codex-windows-sandbox-setup.exe`
内含 `CodexSandboxUsers`、`SetTokenInformation`、`--write-roots-json`、
`deny-write path` 等字符串；仓库 DACL 上还留有该工具两组组 SID 的 ACE。
该应用在 2026-09-29 已从本机卸载，服务与本地组一并消失。

**排除方法（本文原先漏掉的一整类）**：`icacls <dir>` 看输出里的
`Mandatory Label\...` 行。注意 `Get-Acl -Audit` 的 `.Audit` 集合**看不到**它
（实测 `Audit.Count == 0`），SDDL 也只显示 `S:AI` —— 必须用 `icacls`。

**清除**（2026-09-29 已对 `poietica` 与 `poietica-target` 执行，1,166,707 个对象）：

```powershell
icacls "D:\xiaojianc\poietica"        /setintegritylevel "(OI)(CI)M" /T /C
icacls "D:\xiaojianc\poietica-target" /setintegritylevel "(OI)(CI)M" /T /C
```

子对象继承，**无需** `/T` 也能让新文件打对；`/T` 只是为了清掉已经固化的旧标签。


## 现象全录（按出现顺序）

| # | 症状（原文） | 阶段 |
| --- | --- | --- |
| P1 | `failed to initialize plugin 'log': 拒绝访问。 (os error 5)` → app panic (exit 101) | 9/25-9/26 上午，间歇 |
| P2 | `file log unavailable (拒绝访问。 (os error 5)); falling back to stdout/webview`（降级生效后） | 9/26 09:52 起 |
| P3 | `SQLite 拒绝了操作：unable to open database file: %LOCALAPPDATA%\com.poietica.Poietica\ledger.sqlite3`（新建库被拒，独立运行） | 9/26 09:29-09:43，确定性 |
| P4 | 同上但路径为 `...com.poietica.Poietica.dev\ledger.sqlite3`（**已存在的库**打开被拒） | 9/26 09:52-10:19 |
| P5 | `SQLite 拒绝了操作：disk I/O error`（用户在自己 PowerShell 里跑出，错误形态变异） | 9/26 ~10:19 |
| P6 | `Failed to setup app: ... runtime error: failed to receive message from webview`，日志伴随 `could not adopt the persisted theme on the window surface` | 9/26 10:32-10:51，文件层修好后暴露 |
| P7 | 任务管理器累积 8 只僵尸 `msedgewebview2.exe` | 与 P6 同期 |

关键事实：**用户在自己的 PowerShell（非本 AI 会话内）运行同样失败** → 排除
「AI 执行环境沙箱」假设。

## 时间线（精确到事件）

| 时间 | 事件 |
| --- | --- |
| 9/25-9/26 凌晨 | 前一会话排查 P1（cargo 锁文件、log 插 init 两处游走），未破案，用户叫停；留下已排除清单 |
| 09:07 | 核查发现 dev 日志文件 08:47 刚被创建（0 字节）→ 拒绝是瞬态的 |
| 09:29-09:43 | 独立运行非 dev 构建三次：log 打开成功、**ledger 新建被拒**（P3），ProcMon 抓到拒绝现场（见证据 E4） |
| 09:52 | 全链 bun dev：log 降级（P2）+ dev 根**已存在**的 ledger 打开被拒（P4）→ 拦截不限于新建 |
| ~10:19 | 用户自跑复现 P2+P5 |
| 10:2x-10:3x | 落地降级修复 + dev 数据根迁仓内 `.dev-data/`（robocopy 398MB）→ 文件层全通 |
| 10:32-10:51 | 连续三轮 bun dev 死于 P6（webview 握手）；杀 8 只僵尸后仍失败；杀豆包/WorkBuddy/Snipaste/GameViewer 后仍失败 |
| ~11:00 | 装版应用（`D:\WindowsApp\Poietica\poietica.exe`）实测**正常启动** → 机器本身没坏，问题限于 dev 链；检查发现 dev 的 EBWebView 里 LOCK 与 8 月初的陈旧目录 |
| 11:00 | 删除 `%LOCALAPPDATA%\com.poietica.Poietica.dev\EBWebView`（纯缓存） |
| 11:02 | bun dev 验收通过：`startup surface adopted: preference Dark, resolved Dark`、`native setup finished 458 ms after build start`、24 个 msedgewebview2 进程、poietica.exe PID 11780 存活 |

## 三层原因（事实 → 结论 → 状态）

### 第一层：目录完整性标签 —— 已破案并清除（2026-09-29）

**事实（实验证据，见下节）**：
1. 镜像文件位于 `D:\xiaojianc\poietica\**` 时，进程对仓外路径
   （`%LOCALAPPDATA%`、`%TEMP%`）的文件写入被拒（os error 5）。
2. 判据是**镜像所在目录的完整性标签**，不是可执行文件本身：同一个 exe 放在带
   `Low` 标签的目录里就是 Low 进程（写仓外被拒），放在无标签/Medium 目录里就是
   High/Medium 进程（放行）。系统自带的 `cmd.exe` 复现同款结果。
3. 这一条解释了全部观测：同卷移动带走标签（故"移动后仍拒"）、拷贝按目标目录
   重打标（故"拷到仓外则过"）、junction 解析到同一目录对象（故"经 junction 仍拒"）。
4. 与用户身份、父进程、调用时刻无关（完整性级别不是权限，提权与改父进程都不改它）。
5. 仓库内自身的读写正常：Low → Low 是同级别写，不受 No-Write-Up 约束。

**结论（已被 E7/E8 实证）**：`D:\xiaojianc\poietica` 与 `D:\xiaojianc\poietica-target`
两个目录对象带着 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`。Windows 在
进程创建时按镜像路径读取该标签并据此定令牌完整性级别，`NW`（No-Write-Up）再禁止
向更高级别对象写入。标签由 OpenAI Codex 桌面版的 Windows 沙箱服务所打。

**状态**：标签已清除（`icacls ... /setintegritylevel "(OI)(CI)M" /T /C`），绕行
布局全部还原。**复发处置见文末。**

### 第二层：应用对日志失败零抵抗 —— 已改代码（永久保留）

- `structured_log.rs`：启动时预检日志文件落点（`open(create+append)`），
  失败则去掉 Folder target（降级 stdout/webview）并 eprintln；
- `composition.rs`：log 插件注册从 `?` 改为 `if let Err` + eprintln（兜底）。

改动前，第一层的瞬态拒绝会让整个应用 panic。改动符合架构宪法的功能降级处置。

### 第三层：WebView2 连锁损伤 —— 已清理修复（复发可重做）

崩溃风暴遗留 8 只僵尸 msedgewebview2 + 陈旧/损坏的
`%LOCALAPPDATA%\com.poietica.Poietica.dev\EBWebView`（内有 8 月初的陈旧目录与
LOCK 文件），导致 WebView2 浏览器进程初始化后与宿主的 IPC 通道死亡：
tauri-runtime-wry 的窗口 getter（`window.theme()` 等）走 `channel().recv()`，
对端应答者被丢弃 → `FailedToReceiveMessage`（「failed to receive message from
webview」）→ `WindowSurface::adopt` 仅 warn，但 `restore_initial_geometry(&main_window)?`
把同一错误带进 setup → panic。

**处置（已验证有效）**：

```powershell
taskkill /F /IM msedgewebview2.exe
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\com.poietica.Poietica.dev\EBWebView"
```

EBWebView 是纯缓存，删除只丢 webview 本地状态（localStorage 等）。

## 证据链（实验与原始数据）

**E1 探针二分矩阵**（rustc 编译 15 行探针，`OpenOptions read+write+create`）：

| 进程镜像位置 | 目标路径 | 结果 |
| --- | --- | --- |
| `repo\target\debug\fs-probe.exe` | `.dev\ledger.sqlite3`（已存在） | **拒** |
| `repo\target\debug\fs-probe.exe` | 非 dev 根 `ledger-probe.sqlite3`（新建） | **拒** |
| `repo\target\debug\fs-probe.exe` | 非 dev 根 `logs\probe-x.log`（新建） | **过** |
| `repo\target\debug\fs-probe.exe` | `%TEMP%\probe-ctrl.log` | **拒** |
| 同文件拷到 `%TEMP%\fs-probe2.exe` | `.dev\ledger.sqlite3` | 过 |
| 同文件拷到 `D:\xiaojianc\fs-probe3.exe`（仓外） | `.dev\ledger.sqlite3` | 过 |
| 仓内非 target 位置 `repo\fs-probe4.exe` | `.dev\ledger.sqlite3` | **拒** |
| 经 junction 调用（镜像解析后在仓外） | `.dev\ledger.sqlite3` | **拒** |
| 同一物理文件按仓外真实路径直调 | `.dev\ledger.sqlite3` | **拒** |

最后两行当时被读作「标记跟随文件本体」；真实机制是**标签在目录上**，同卷改名
带走标签、拷贝按目标目录重新打标（见 E7）。bash 的 `touch`/`echo >>` 对同样
路径始终成功（对照：拒绝按进程镜像身份，不按用户令牌）。

**E2 ProcMon 抓捕**（600MB PML → CSV，247MB；拒绝时刻 09:43:50）：

```text
poietica.exe QueryOpen  ...\ledger.sqlite3  FAST IO DISALLOWED
poietica.exe CreateFile ...\ledger.sqlite3  NAME NOT FOUND  (Read Attributes; Open For Backup)
poietica.exe CreateFile ...\ledger.sqlite3  ACCESS DENIED
    Desired Access: Generic Read/Write, Disposition: OpenIf, Attributes: N,
    ShareMode: Read, Write, AllocationSize: 0
```

CSV 全量检索：**没有任何其他进程**碰过 `com.poietica.*` 路径；同进程几秒前对
同目录 `logs\poietica.log` 的同型 CreateFile 成功。PML 里有内核栈但无 CLI 导出
手段（未提取）。

**E3 模块注入检查**：csc 编译模块枚举器，被拒环境与放行环境各跑一次，
模块清单 33 项逐条相同 → 无注入 DLL。

**E4 过滤器卸载排除法**（`fltmc unload X → 探针 → fltmc load X`）：
bfs、WinSetupMon、UCPD、storqosflt、CldFlt 逐个卸载后探针**仍被拒**。
（注意：本组测试输出曾被重定向，storqosflt 卸载后实例数归零可佐证其真实卸载；
其余四个未复核卸载是否生效。）

**E5 防护软件配置面（只读核查）**：Defender `EnableControlledFolderAccess=0`、
`SmartAppControlState=Off`、ASR 规则清单为空、`ExclusionPath` 含 C:\ 与 D:\ 整盘、
`Get-MpThreatDetection` 最近一条为 2024 年、Defender/CodeIntegrity/AppLocker
事件日志无相关拦截、IFEO 无相关条目、UCPD 经查证只护注册表 UserChoice 键。

**E6 装版对照**：装版（identifier `com.poietica.Poietica`，数据根 = exe 旁目录，
9/26 07:30 还正常写过 6.8KB 日志）在排查中段实测**仍可完整启动** → 机器不是
对所有进程坏了，问题锁死在「仓库内诞生的镜像」上。

**E7 完整性标签三步对照（2026-09-29，定案实验）**：同一个 `bun.exe`，只改所在
目录的完整性标签：

| 目录标签 | 进程令牌 IL | 写 `%TEMP%` |
| --- | --- | --- |
| 无标签 | High (S-1-16-12288) | 通过 |
| `Low` | Low (S-1-16-4096) | **拒（EPERM）** |
| `Medium` | Medium (S-1-16-8192) | 通过 |

用系统 `cmd.exe` 交叉验证（仓内拷贝 = Low，仓外拷贝 = High）→ 与可执行文件无关。

**E8 标签的继承与迁移语义**（解释 E1 的表）：

| 操作 | 标签行为 |
| --- | --- |
| 在带标签目录下新建文件/子目录 | 继承（`(I)`） |
| 父目录改标签 | 已存在的子对象跟着变（无需 `/T`） |
| 同卷 rename / move | **标签跟着走**（→ E1「移动后仍拒」） |
| 跨目录拷贝 | 按**目标**目录重新打标（→ E1「拷到仓外则过」） |
| `Get-Acl -Audit` 读 SACL | **读不到**（`Audit.Count == 0`，SDDL 只有 `S:AI`）；只有 `icacls` 看得见 |

## 已排除清单（每项含排除方法，勿重查）

| 嫌疑 | 排除方法与证据 |
| --- | --- |
| 装版与开发版并存抢文件 | 路径核对：装版数据根 = exe 旁（`D:\WindowsApp\Poietica\`），dev 根 = `%LOCALAPPDATA%\.dev`，零交集；失败期间无 poietica 进程存活 |
| tauri-plugin-log 自身（rotate/KeepOne 自竞争） | 读 2.9.0 源码：默认 `FileOpenStrategy::Append` + 0 字节文件 + KeepOne → rotate/remove 路径不可达，唯一可疑点就是 open 本身 |
| 单实例失效导致双实例竞争 | 读 2.4.3 源码：第二实例在插件 setup 内同步 `SendMessageW → process::exit(0)`，到不了 log 初始化 |
| AI 执行环境沙箱（ZCode） | 用户自有 PowerShell 复现；WMI 启动（父进程= WmiPrvSE）仍拒；ZCode 无服务/驱动/.sys |
| Defender（CFA/SAC/ASR/行为阻断） | 见 E5 全套只读核查 |
| UCPD/bfs/WinSetupMon/storqosflt/CldFlt 过滤器 | 见 E4 卸载实测（含未复核卸载生效性的保留意见） |
| 用户态注入 DLL | 见 E3 |
| 第三方进程碰路径 | 见 E2 全量 CSV 检索 |
| IFEO / AppLocker / CodeIntegrity | 注册表与事件日志核查为空 |
| ACE 反作弊（Tencent，机器上有残留驱动） | 驱动 State=Stopped，且拒绝持续存在期间它不在运行 |

**排查盲区（别再漏）**：上面整张表连同 E1-E5 全都在查 DACL / SACL / 过滤器 /
杀软，**没有任何一项读完整性标签**。`Get-Acl -Audit` 的 `.Audit` 集合看不到它
（实测 `Audit.Count == 0`），SDDL 也只有 `S:AI`；只有 `icacls` 输出的
`Mandatory Label\...` 行看得见。今后这类「权限正确却 EPERM」的案子，
第一步就该是 `icacls <dir> | Select-String 'Mandatory Label'`。

## 未解释 / 未测（下一个调查者的入口）

**这一节的内容已被 E7/E8 取代（2026-09-29 破案），无需再测。** 保留作记录：
WdFilter/bindflt/Wof 的卸载实验、ProcMon 内核栈提取、「打标时机」实验都不必做了
—— 机制不在 minifilter 层，也没有"打标"动作：判定完全由目录对象的完整性标签
在**进程创建时**由内核读取。原先列为"未解释"的观测（移动后仍拒、拷贝后放行）
由 E8 的标签迁移语义解释完毕。

故障开始前的安装史也回溯到了：元凶是 OpenAI Codex 桌面版的 Windows 沙箱
（`CodexSandboxService.OpenAI.Codex`），该应用现已卸载。

## 绕行布局：已全部还原（2026-09-29）

元凶清除后按本文原「还原步骤」全部还原，机器回到常规布局：

| 项 | 现状 |
| --- | --- |
| cargo 产物目录 | `repo\target\`（真实目录，23.6GB 缓存由同卷改名带回，无损） |
| `repo\target` | 不再是 junction |
| `src-tauri\binaries` | **真实目录**（随包运行时落在仓内，由 `agent:prepare` 现备） |
| `CARGO_TARGET_DIR` | 用户级变量已 `reg delete`；新终端下 cargo 默认写 `repo\target` |
| dev 数据根 | 回到 `%LOCALAPPDATA%\com.poietica.Poietica.dev`（含 omp 凭据与全部开发数据，robocopy /MOVE 已带回） |
| `paths.rs` | `installed_root` debug 分支回到 `None`（→ `app_local_data_dir`） |
| `.gitignore` | `.dev-data/` 条目已删 |
| `D:\xiaojianc\poietica-target` | 已不存在 |

验收：还原后 `bun dev` 全链通过（`native setup finished 479 ms`，窗口正常），
数据根落在 `%LOCALAPPDATA%`，未再生成 `.dev-data`。

**仍保留的两项不是绕行**（改动时间早于本次事件，机制也不同）：

- `.cargo/config.toml` 把链接器的 `TMP`/`TEMP` 指向 `.cargo/link-tmp`（2026-09-24）
  —— 防的是共享 `%TEMP%` 被清理程序动过导致 MSVC 的 `LNK1104`，与完整性标签无关。
- `turbo.json` 的 `globalPassThroughEnv` 含 `CARGO_TARGET_DIR`（2026-07-26）
  —— 只是允许用户自带该变量透传，本身不设值。

## 仓库改动清单

| 文件 | 改动 | 层 |
| --- | --- | --- |
| `apps/desktop/src-tauri/src/diagnostics/structured_log.rs` | 落点预检 + 降级；`LOG_FILE_STEM` 单一产地；两个单测 | 二（永久保留） |
| `apps/desktop/src-tauri/src/composition.rs` | log 插件注册失败降级（`print_stderr` 带 reason allow） | 二（永久保留） |
| `docs/architecture/data-layout.md` | 已改回「开发落点在平台目录」 | 文档 |
| `docs/runbooks/dev-write-interception.md` | 本文，已补 E7/E8 与破案结论 | 文档 |

验证状态：`cargo test --lib diagnostics::structured_log` 2 过；clippy、fmt 干净。
**发布版行为唯一变化**：log 插件初始化失败从 panic 改为降级（无日志继续跑）——
这一条与本机环境无关，是通用健壮性改进，故不回退。

## 复发处置（若再次出现 os error 5）

决策见 ADR 0058。一条命令判定：

```powershell
icacls "D:\xiaojianc\poietica" | Select-String 'Mandatory Label'
```

出现 `Low Mandatory Level` 即命中本机制，清除：

```powershell
icacls "D:\xiaojianc\poietica" /setintegritylevel "(OI)(CI)M" /T /C
```

然后找谁打的标签：查 `CodexSandboxUsers` 本地组、`CodexSandboxService.*` 服务、
以及仓库 DACL 上带组 SID 的 ACE（`icacls` 输出的 `S-1-5-21-...` 行）。
本机 2026-09-29 的元凶是 OpenAI Codex 桌面版（已卸载）。

操作前确认无 poietica / msedgewebview2 进程存活。
