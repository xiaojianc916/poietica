# 开发机写入拦截与当前绕行布局

2026-09-26 起，本机的 `bun dev` 全链被一台机器级异常和它的连锁反应压住过。
本文记录三层原因、当前生效的绕行布局、每个故障签名的处置命令，以及元凶破案后
的还原步骤。代码侧的对应改动都有 `ponytail:` 注释锚点。

## 故障签名速查

| 症状 | 原因层 | 处置 |
| --- | --- | --- |
| `tauri-plugin-log` 初始化 panic / `file log unavailable (拒绝访问。 (os error 5))` | 一 | 见「绕行布局」，确认产物是仓外新生成 |
| SQLite `拒绝访问` / `disk I/O error`，ledger 打不开 | 一 | 同上；确认数据根是 `.dev-data` |
| `failed to receive message from webview`（日志里伴随 `could not adopt the persisted theme`） | 三 | 杀 msedgewebview2 + 删 EBWebView，见下 |
| 构建产物路径变了、IDE 报错找不到 target | 二 | 检查两个 junction 是否还在 |

## 第一层：机器级写入拦截（未破案，已绕行）

**规律**：镜像文件诞生于 `D:\xiaojianc\poietica\**` 的进程，对仓库外路径
（`%LOCALAPPDATA%`、`%TEMP%`）的写入被拒绝（os error 5）。**标记跟随文件本体**：
同一 exe 经 junction 调用、改路径直调都仍被拒；把文件拷贝到仓外再跑则一切正常。
2026-09-25/26 两天内间歇复现，09-26 起转为确定性复现。

**已排除（勿重查）**：装版并存（装版数据根在 exe 旁，与 dev 零交集）；
ZCode（无服务、无驱动、无 .sys）；Defender 配置面（受控文件夹访问关、
Smart App Control 关、ASR 规则空、C:/D: 整盘排除完好、无检测记录）；
UCPD / bfs / WinSetupMon / storqosflt / CldFlt（逐个 `fltmc unload` 实测不变）；
用户态注入 DLL（被拒进程的模块列表与正常环境逐条相同）；IFEO；AppLocker /
CodeIntegrity 事件；ACE 反作弊（驱动 Stopped）。ProcMon 抓到的拒绝行里没有任何
第三方进程碰过这些路径。**未测**：WdFilter、bindflt、Wof 的卸载（实验两次被
取消，未取得授权前不要再动）。

**当前绕行布局**（让所有自建镜像诞生在仓库外）：

| 项 | 现状 |
| --- | --- |
| cargo 产物目录 | `D:\xiaojianc\poietica-target\`（原 `target/` 原地改名过去，增量缓存保留） |
| `repo/target` | junction → `D:\xiaojianc\poietica-target`（cargo/IDE 的旧路径照常工作） |
| `src-tauri/binaries` | junction → `D:\xiaojianc\poietica-target\sidecar-binaries`（tauri.conf 与 agent:build 零改动） |
| `CARGO_TARGET_DIR` | 已 `setx` 为 `D:\xiaojianc\poietica-target`（第二道保险） |

junction 重建命令（被 cargo clean 或工具误删时）：

```cmd
mklink /J D:\xiaojianc\poietica\target D:\xiaojianc\poietica-target
mklink /J D:\xiaojianc\poietica\apps\desktop\src-tauri\binaries D:\xiaojianc\poietica-target\sidecar-binaries
```

**复发处置**：凡是「仓内诞生过的 exe」永远带标记——删掉产物让它重链
（新产物经 junction / CARGO_TARGET_DIR 落在仓外，即恢复干净）。不要直接在
仓库内跑产生 exe 的构建。

## 第二层：应用韧性改动（已进代码，随仓库走）

- `structured_log.rs`：日志文件落点启动时预检，被拒则降级 stdout/webview，
  不再让日志插件拖死应用。
- `composition.rs`：log 插件注册失败降级为无插件运行（`print_stderr` 带 allow）。
- `paths.rs`：开发构建数据根 = 仓库旁 `.dev-data/`（`installed_root` 的 debug
  分支，带 `ponytail:` 注释）。旧开发数据（账本、会话、agent home、凭据）
  已整体迁入；`.dev-data/` 在 `.gitignore`。**注意：`git clean -fdx` 会连
  `.dev-data` 里的 omp 凭据一起删。**

## 第三层：WebView2 连锁损伤（清理即愈）

连日崩溃风暴遗留僵尸 msedgewebview2 进程（锁着用户数据目录）和写坏的
EBWebView，症状是每次启动 webview 握手必死。WebView2 用户数据目录由
identifier 决定（`%LOCALAPPDATA%\com.poietica.Poietica.dev\EBWebView`），
不随 `paths.rs` 走。处置：

```powershell
taskkill /F /IM msedgewebview2.exe
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\com.poietica.Poietica.dev\EBWebView"
```

EBWebView 是纯缓存，删除只丢 webview 本地状态。

## 还原步骤（元凶破案后）

1. `paths.rs` 的 debug 分支改回 `app_local_data_dir`，把 `.dev-data` 数据迁回
   `%LOCALAPPDATA%\com.poietica.Poietica.dev`（应用须停机）。
2. 删两个 junction，把 `D:\xiaojianc\poietica-target` 改名回 `repo/target`、
   `sidecar-binaries` 改名回 `src-tauri/binaries`。
3. `reg delete "HKCU\Environment" /v CARGO_TARGET_DIR /f`，重开终端。
4. 本文档与 `data-layout.md` 的对应段落改回「开发落点在平台目录」。

四步各自独立、各自一分钟，做之前确认没有 poietica 进程在跑。
