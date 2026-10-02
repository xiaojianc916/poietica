# 0029 — Python 内核按需下载，落我们的受管目录，经 agent 自己的设置指路

## 状态

已接受，**已落地**。新增能力 crate `crates/python-runtime`（host-agnostic）与三条 IPC 命令
（`python_kernel_status` / `python_kernel_install` / `python_kernel_remove`）。不改传输线上
形状，不改 agent 受控 home 的形态。

## 背景

`eval(language: "py")` 是产品写明的一档能力，而它要求一个能跑的 Python 3.10+。omp 对这一项的
就绪判据是 `checkPythonKernelAvailability`（`CA/src/eval/py/kernel.ts`），解析顺序见
`CA/src/eval/py/runtime.ts:222-227`：项目 venv → 受管 `~/.omp/python-env` → PATH。三条全落空时
如实报 `Python executable not found on PATH`。

上游**故意没有安装器**，`CA/src/cli/setup-cli.ts:102-105` 逐字：

> Python installation helper removed: the subprocess runner has no Python package dependencies
> beyond a working interpreter. `omp setup python --check` remains as a probe.

所以要产品里这一档能用，装的那一步只能在宿主这一侧做。同一个文件也说明了为什么这一步很便宜：
内核走 `Bun.spawn([python, "-u", scriptPath])`（`kernel.ts:308`）跑一份 **NDJSON over
stdin/stdout**、**只用标准库**的 runner（`CA/src/eval/py/runner.py`），
不需要 pip、不需要 venv、不需要任何 Python 包。

## 决定

### 一、不随包发，按需下载

一个可重定位的 CPython 约 21MB（压缩）/ 60MB（解包）。随包发会让每个用户为一项可能不用的能力
付这份体积与每次升级的重下；而下载路径只在下第一档时走一次。

下载源钉在 python-build-standalone 的具体 release tag 上，**校验和只从该 release 的 API 元数据取**
（asset 的 `digest`），源码里不写哈希常量 —— 写死哈希就是第二个事实，上游重发时必然分叉。
tag 与版本各是一个常量，资产名由它们拼出来（`crates/python-runtime/src/release.rs`）。

**判据是名字逐字相等，不是子串包含**：`20261001` 那一批里含 `x86_64-pc-windows-msvc` 且以
`install_only_stripped.tar.gz` 结尾的有 9 条（3.10 / 3.11 / 3.12 / 3.13 / 3.13-freethreaded /
3.14 / 3.14-freethreaded / 3.15rc / 3.15rc-freethreaded），子串判据必然不唯一。

### 二、字节落在 `<data_root>/tools/python`，**不是** `~/.omp/python-env`

omp 确实有一个受管 Python 位置（`PU/src/dirs.ts:703-706` 的 `getPythonEnvDir()`），但它
在 Poietica 里落不到我们的受控 home，而且语义不对：

1. **它不受 `PI_CODING_AGENT_DIR` 管辖。** `dirs.ts:330-334`：`configRoot` 来自 profile，
   `agentDir` 才吃 `PI_CODING_AGENT_DIR` 这个 override；而 `getPythonEnvDir()` 走
   `rootSubdir(…)`，基础是 **configRoot**。实测（`PI_CODING_AGENT_DIR=D:\…` 时）
   `getPythonEnvDir()` 仍返回 `C:\Users\<用户>\.omp\python-env` —— 用户真实 home 里，不在受控 home 内。
2. **它是给 venv 准备的。** `runtime.ts:247-254` 对受管候选调 `applyVenvEnv`，会设
   `VIRTUAL_ENV` 并按 venv 处理。而 python-build-standalone 的 `install_only` 是独立发行版，
   树根没有 `pyvenv.cfg`，不是 venv。
3. **它不属于会话。** 受控 home 是可以整体重建的；把 60MB 解释器放进去，等于把一份应用数据
   挂在一条随时会换的路径上。

`tools/python` 属于应用数据根、生命周期独立，且它的顶层就是解释器家目录
（`python.exe` 与 `Lib/`、`DLLs/` 同级）—— 用户点「打开所在位置」看到的就是解释器本身，
而不是又一层同名目录。

### 三、指路走 `python.interpreter`，不改 PATH

`python.interpreter` 是 agent 自己 schema 里的键（`CA/src/config/settings-schema.ts:4099`），
描述逐字：*Optional path to an exact Python executable. **When set, automatic Python runtime
discovery is skipped.*** `CA/src/eval/py/runtime.ts:203-220` 对绝对路径原样采用、不做探测。

选它而不是 PATH 前置，理由是确定性与归属各一条：
- **确定性**：写了这个键就不再枚举，不受 shell 快照、不受 `unsetEnv` 摘除、不受 venv 误判
  （见决定二第 2 条 —— 若走 PATH，omp 仍可能把它当成 venv 而设错 `VIRTUAL_ENV`）。
- **归属**：配置真身是 agent 受控 home 自己的配置，我们只经它**官方写入面**改它
  （AGENTS.md §2）。写设置复用既有命令 `agent_set_setting`，不新开设置命令 —— 一类状态只有
  一条写入路径。

### 四、状态从盘上推导，不存第二份

五档（未安装 / 安装中 / 就绪 / 已损坏 / 本平台不支持）全部由盘上事实判定：
解释器在且能跑（`-I -c "import sys"`）才是就绪，解包成功不算。**没有一份"已安装"的记录需要
与磁盘对账**，因此也不会有它过期的一天。

### 五、中间态只留"设置缺席"这一种

装：先落字节、后写设置；删：先清设置、后删字节。两边都只留「设置指向的解释器不存在」之外的
那一种中间态。反过来（设置指向一棵不存在的树）会让 agent 当场报错，而"目录在、设置没指过来"
最多白占一份空间，下次装机覆盖它。

解包一律落在受管目录**同级**的暂存目录（同卷，换入才是一次 rename）；换入时旧树先让位到
`.replaced`、新树 rename 入、最后删旧树 —— Windows 不能 rename 到一个已存在的目录，
单次 rename 换不掉。任何时刻要么是一棵完整的旧树、要么是一棵完整的新树。

## 后果

1. 第一次用到 Python 时要下约 21MB，装完约 60MB。装是后台任务带进度，不阻塞界面。
2. **进度只能是不确定进度条**：crate 的下载不吐字节进度，`percent` 恒为 null。编造一个匀速
   前进的假数字比不报更坏。
3. 本平台只发 Windows，非 Windows 如实报 `unsupported`，不假装支持、不为没人跑的路径
   另写一套。
4. 上游换 tag 时是一次显式改动（改常量 + 跑一次带网络的端到端测试），不做自动升级。
5. 端到端测试（`crates/python-runtime/tests/install.rs`）默认 `#[ignore]`，因为它要真下 22MB。
   它抓到过两个只有真网络才现形的缺陷：清单请求的 `Accept` 头让 GitHub 回压缩体而 client 没开
   解码 feature；以及解释器在安装树里的真实位置。**这类缺陷单测看不见，别把单测全绿当成能装。**
