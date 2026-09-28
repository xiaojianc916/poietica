# 事件报告：bun dev 链 os error 5 与 webview 启动失败（2026-09-26 已恢复）

> 读者注意：本文写给零上下文的接手者（人或 AI）。事实、推断、未知三类信息
> 明确分开标注；所有结论都附实验证据。日期均为 2026-09-26（另有标注除外）。

## 一句话结论

`bun dev` 曾被三个互相叠加的问题压死：**①本机一个未破案的写入拦截机制**（仓库内
诞生的进程/文件对仓外路径写入报 os error 5，标记跟随文件本体）——已用「构建产物
全部移出仓库」绕行；**②应用对日志初始化失败零抵抗**——已改代码降级；**③崩溃风暴
遗留的僵尸 msedgewebview2 + 写坏的 WebView2 用户数据目录**——已清理。三层全部
处理后 `bun dev` 完整验收通过（setup 458ms 走完，窗口正常）。①的元凶**没有找到**，
只锁死了行为规律和规避方法。

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

### 第一层：机器级写入拦截 —— 元凶未破案，已绕行

**事实（实验证据，见下节）**：
1. 镜像文件诞生于 `D:\xiaojianc\poietica\**` 的进程，对仓外路径
   （`%LOCALAPPDATA%`、`%TEMP%`）的文件写入被拒（os error 5）。
2. **标记跟随文件本体，不跟调用方式**：同一 exe 无论从 junction 路径调用、
   还是移动到仓外后按真实路径调用，都被拒；把它**拷贝**到仓外则放行。
3. 拦截与用户身份无关（提权无效）、与父进程无关（WMI 启动仍拒）、与调用时刻
   大体无关（后期确定性复现）。
4. 仓库内自身的读写（cargo/rustc/bun 构建、`.dev-data` 写入）始终正常。

**结论（推断，非实锤）**：某个内核组件在文件创建时按「创建路径是否位于
`D:\xiaojianc\poietica`」打标，命中者（或其派生进程）对仓外写入拒绝。
flmtc 里没有任何第三方 minifilter 在挂载，故若为内核组件，可能是未在
fltmc 里出现的路径（legacy filter）或未被卸载测试覆盖的 Microsoft 过滤器。

**状态**：绕行已固化（见「当前绕行布局」）。**复发条件**：任何 exe 在仓库内
被创建后直接运行。**规避铁律：让链接产物只生成在仓外。**

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

最后两行是「标记跟随文件本体」的直接证据；bash 的 `touch`/`echo >>` 对同样
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

## 未解释 / 未测（下一个调查者的入口）

1. **WdFilter、bindflt、Wof 三个过滤器从未做卸载实验**（两次实验被用户取消，
   未获授权不要再动）。其中 WdFilter 是唯一具备行为阻断能力的在挂载过滤器，
   嫌疑最大。若获授权：`fltmc unload WdFilter → 立即跑探针（MsMpEng 会秒级
   重载，要抢窗口）→ fltmc load WdFilter`。
2. **ProcMon PML 里的内核栈未提取**。PML（603MB）已删除；如需重抓，ProcMon
   GUI 打开拒绝行的 Stack 即可看到返回 ACCESS_DENIED 的过滤器 altitude——
   这是最直接的定凶手段。
3. 拦截的判定依据未定位到具体机制（文件 ID？USN 日志里的创建路径史？）。
   一个可做的判别实验：把被标记文件**改名**（同卷 rename，file ID 不变）后
   运行——已证明「移动+按新路径调用」仍拒，rename 大概率同样拒，价值不大；
   更有价值的是反向实验：在仓内创建一个新 exe 但**从未运行**，观察其 USN/属性，
   确认「打标发生在创建时」还是「进程启动时回溯判定」。
4. 9/25 之前本机开发一直正常；故障开始前装了什么/更新了什么未回溯（Defender
   平台版本 4.18.26080.4、引擎 1.1.26080.3 为 2026-08 批次）。机器上运行中的
   非系统软件：MSPCManager ×3、豆包 ×12、网易 GameViewer、腾讯 WorkBuddy/
   WorkBuddyAI、宏碁全家桶、Snipaste（杀进程实验未改变拒绝，但它们可能只是
   不是元凶而非无嫌疑）。

## 当前绕行布局（机器状态改动，勿随意还原）

| 项 | 现状 | 性质 |
| --- | --- | --- |
| cargo 产物目录 | `D:\xiaojianc\poietica-target\`（原 `repo\target` 8.4GB 同卷改名，缓存无损） | 机器改动 |
| `repo\target` | junction → `D:\xiaojianc\poietica-target`（`mklink /J`） | 机器改动 |
| `src-tauri\binaries` | junction → `D:\xiaojianc\poietica-target\sidecar-binaries` | 机器改动 |
| `CARGO_TARGET_DIR` | 已 `setx` = `D:\xiaojianc\poietica-target`（用户级；junction 已覆盖此功能，属第二道保险） | 机器改动 |
| dev 数据根 | 仓库旁 `.dev-data\`（robocopy 自 `%LOCALAPPDATA%\com.poietica.Poietica.dev` 迁入 398MB，EBWebView 除外） | 机器改动 |
| WebView2 | 僵尸已清、EBWebView 已删（现由应用自动重建） | 一次性清理 |
| 被杀进程 | 豆包/WorkBuddy/Snipaste/GameViewer/msedgewebview2（可自行重启） | 一次性清理 |

junction 校验：`dir D:\xiaojianc\poietica` 中 target 应显示 `<JUNCTION>`；
被工具误删后用 `mklink /J` 重建（target 与 sidecar-binaries 两条命令见上文速查）。

**注意**：`.dev-data` 含 omp 凭据与全部开发数据，已在 `.gitignore`；
`git clean -fdx` 会删掉它。

## 仓库改动清单（全部未提交，待用户审阅）

| 文件 | 改动 | 层 |
| --- | --- | --- |
| `apps/desktop/src-tauri/src/diagnostics/structured_log.rs` | 落点预检 + 降级；`LOG_FILE_STEM` 单一产地；两个单测 | 二 |
| `apps/desktop/src-tauri/src/composition.rs` | log 插件注册失败降级（`print_stderr` 带 reason allow） | 二 |
| `apps/desktop/src-tauri/src/paths.rs` | `installed_root` debug 分支返回 `repo\..\..\.dev-data`，带 `ponytail:` 注释与还原条件 | 一(绕行) |
| `.gitignore` | 加 `.dev-data/` | 一(绕行) |
| `docs/architecture/data-layout.md` | dev 数据根段落与现状对齐，链接到本文 | 文档 |
| `docs/runbooks/dev-write-interception.md` | 本文 | 文档 |

验证状态：`cargo test --lib diagnostics::structured_log` 2 过；clippy、fmt 干净；
bun dev 全链验收通过（11:02）。**发布版行为唯一变化**：log 插件初始化失败从
panic 改为降级（无日志继续跑）。

## 还原步骤（元凶破案后，四步独立各一分钟）

1. `paths.rs` debug 分支改回 `app_local_data_dir`；停机后把 `.dev-data` 数据
   迁回 `%LOCALAPPDATA%\com.poietica.Poietica.dev`。
2. 删两个 junction；`D:\xiaojianc\poietica-target` 改名回 `repo\target`、
   `sidecar-binaries` 改名回 `src-tauri/binaries`。
3. `reg delete "HKCU\Environment" /v CARGO_TARGET_DIR /f`，重开终端。
4. 本文与 `data-layout.md` 对应段落改回「开发落点在平台目录」。

操作前确认无 poietica / msedgewebview2 进程存活。
