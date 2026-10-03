# 0036 — Python 内核的字节走镜像，清单仍以 GitHub 为正本

## 状态

已接受，已落地。改 `crates/python-runtime/src/release.rs` 与根 `Cargo.toml` 的 reqwest
feature（加 `gzip`）。不动 IPC 契约、不动落盘布局、不动状态判定（ADR 0029 的四条决定原样有效）。

## 背景

ADR 0029 决定「按需下载、从 python-build-standalone 的 release API 取资产与摘要」。
它没写错，但它**没算过这条路的实际速度**：本机实测 22MB 的归档 284KB/s ≈ 78s，
清单正文 1.61MB 未压缩要 33s —— 用户看到的就是「准备中」的进度条一动不动地挂几分钟。

同一台机器上实测同一份文件（sha256 逐字节相同）：

| 源 | 22MB 归档 | 1.61MB 清单 |
| --- | --- | --- |
| GitHub API / CDN | 284KB/s（78s） | 33s（未压缩）/ 1.3s（gzip） |
| registry.npmmirror.com 二进制镜像 | 3.9MB/s（5.7s） | —— |

镜像目录页只有 `name/date/size/url`，**没有摘要**；清单里的 `digest` 是校验的唯一根据，
所以清单不能改从镜像取。但清单慢的原因不是主机而是**没开压缩**：reqwest 的 gzip 是一个
feature，本仓那份 client 没开，1.61MB 明文就那么搬。

## 决定

### 一、字节默认走镜像，认不出来再回落到 GitHub

`download` 先取 `https://registry.npmmirror.com/-/binary/python-build-standalone/<tag>/<资产名>`，
失败（连不上、404、长度不符、摘要不符）才取清单里的 `asset.url`。两句话都留在错误里 ——
只报一条就分不清是哪条路的问题。

镜像目录是 `<tag>/<资产名>`，与上游 release 的资产名逐字相同，所以只有主机名不一样；
这也意味着**摘要校验一个字都不改**：`stream` 是两条源共用的那一段，长度、sha256、落盘
都只在里面判一次。镜像不被信任，换源不换校验。

选 npmmirror 的理由是它已经在这个仓库里：`bun.lock` 全量 541 条依赖都从
`registry.npmmirror.com` 装，二进制面是同一家的第二个路径，不引入新的信任方。
它的目录页是另一套 JSON 形状（不是 GitHub 的 release 结构），所以清单不从它取。

### 二、reqwest 开 gzip

`Cargo.toml` 的共享 reqwest 加 `gzip` feature。清单 33s → 1.3s。

`crates/python-runtime/src/release.rs` 那条「不要加 `Accept: application/vnd.github+json`」
的纪律保留，但理由改写：从前是因为**没有**解码能力，带上那个头必然拿到解不开的压缩体；
现在压缩体解得开了，不改这条的理由只剩「不带它实测就是明文、就能解析」。

**这是全仓共享的 reqwest 形状**（`reqwest.workspace = true`），另外两处也吃这个改动：
`crates/browser` 的 favicon（5s 超时下压缩只会更有利）与 `native/extension.rs` 的插件下载
（有 32MB 上限，计的是**解压后**的字节，压缩不改语义）。出货更新不走它 ——
那条路是 electron-updater（`apps/desktop/electron/update.ts`）。

唯一按 `content_length()` 对账的是本 crate 的 `stream`，而它只下归档：
两个源都回 `Content-Length: 22013771` 且不带 `content-encoding`（实测），
所以长度判据与是否开压缩无关。

### 三、不做自动测速，也不做可配的源列表

镜像地址是一个常量。上游换 tag 时仍是一次显式改动（ADR 0029 后果第 4 条不变）。
**不引入「哪个源快」的探测或缓存** —— 顺序是写死的：镜像先、GitHub 后。

## 后果

1. 首次装机从「几分钟」回到「十几秒」，慢网下也一样：镜像在国内链路上是另一个量级。
2. 装机仍然只有不确定进度条（ADR 0029 后果第 2 条不变）：`stream` 不往外吐字节进度。
3. 依赖多两个 crate（`tower-http`、`async-compression`），都已在 `Cargo.lock` 里
   （`tower-http` 由 rmcp 带进来），本次只是把 reqwest 的 feature 打开。
4. 上游若把资产名规则改掉，镜像路径跟着 404，会**静默**回落到 GitHub —— 于是又变慢
   而不会报错。`mirror_url_is_the_upstream_asset_name_under_the_tag` 钉住拼接形状，
   真换 tag 时端到端测试（`--ignored`）是唯一的报警器。
