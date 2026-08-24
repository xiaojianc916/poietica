# Runbook — Windows 发行

面向的是"装到别人电脑上的 Poietica"，不是开发机上的 `bun run dev`。

## 一次性设置

### 1. 更新签名密钥（必做）

```bash
cd apps/desktop && bun run tauri signer generate -w $HOME/.tauri/poietica.key
```

- 公钥填进 `apps/desktop/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`，替换
  `REPLACE_WITH_TAURI_SIGNER_PUBKEY`。公钥不是密钥，入库。
- 私钥与口令进仓库 secrets：`TAURI_SIGNING_PRIVATE_KEY`、
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。

> 这把私钥丢了，就再也无法给已安装的客户端推送更新 —— 它们只信任当前公钥。
> 离线另存一份。

### 2. Authenticode 代码签名（决定 SmartScreen 是否拦人）

未签名的安装包在别人电脑上会触发 SmartScreen"未知发布者"。Tauri v2 只认两种配置：

- `bundle.windows.certificateThumbprint` —— 证书装在本机证书库时使用；
- `bundle.windows.signCommand` —— 云签名（Azure Trusted Signing 等）时使用，
  例如
  `"signCommand": "artifact-signing-cli -e <endpoint> -a <account> -c <profile> -d Poietica %1"`。

配置写进 `tauri.release.conf.json` 的 `bundle.windows`，只影响发布构建。

> 历史遗留：此前 release workflow 里的 `TAURI_WINDOWS_CERTIFICATE` /
> `TAURI_WINDOWS_CERTIFICATE_PASSWORD` 不被 Tauri v2 读取，填了也没有签名。已删除。

## 发一个版本

```bash
bun run version:set 0.2.0
bun run check:versions
git commit -am "release: 0.2.0"
git tag v0.2.0
git push origin main --tags
```

Release workflow 会：preflight（拦占位公钥）→ 版本一致性 → `bun run check` 绿灯闸门 →
依赖策略 → `bun run build:release` → 收集 `.exe` / `.sig` → 生成 `latest.json` →
SHA256SUMS → 静默安装冒烟 + PE 子系统回归检查 → 建草稿 release。

确认产物后手动 Publish。`latest.json` 通过
`releases/latest/download/latest.json` 被已安装客户端读取，发布即生效。

## 本地出一个安装包

```bash
bun run build:release          # target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe
```

不带 updater 产物，也不需要签名密钥。

## 安装形态

- 渠道：NSIS，`installMode: currentUser`，装到 `%LOCALAPPDATA%\Programs`，不需要 UAC。
- MSI 已下线：它是 per-machine，与 NSIS 并存会在同一台机器上产生两份互不可见的
  安装，且 updater 只能更新其中一份。企业分发若需要 MSI，应作为单独标注的渠道
  另行构建，而不是与消费者安装包并排丢在同一个 release 里。
- WebView2：`embedBootstrapper`，Windows 10 1803+ / Windows 11 通常已预装。

## 未决 —— 下一个 P0

agent 可执行文件目前由 `which` 从**终端用户的 PATH** 解析（见 workspace
`Cargo.toml` 的 `which = "8"`），`tauri.conf.json` 里没有 `externalBin`。
在一台没装过 Node / agent CLI 的干净 Windows 上，安装能成功、应用能启动、
会话一条也跑不起来。

两条正路，二选一，不要两条都留：

1. `bundle.externalBin` 打 sidecar，随安装包分发，运行时优先解析 sidecar；
2. 首启引导：检测缺失 → 明确告知缺什么 → 引导安装，失败时应用仍处于可解释状态。
