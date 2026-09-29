# Runbook — bun dev 写入被拒（os error 5）

背景与决策见 ADR 0022。这里只留复发时的操作步骤。

## 判定

```powershell
icacls "D:\xiaojianc\poietica" | Select-String 'Mandatory Label'
```

出现 `Low Mandatory Level` 即命中：仓库目录被打了强制完整性标签 Low，镜像
诞生在这里的进程就是 Low，往 `%LOCALAPPDATA%` / `%TEMP%` / `.rustup` 写属
write-up，被 No-Write-Up 拒（EPERM / os error 5）。

`Get-Acl -Audit` 看不见这个标签（`.Audit.Count == 0`），SDDL 只显示 `S:AI`。
只有 `icacls` 会打印那一行——这是本类案件的第一步排查手段。

## 清除

先确认无 poietica / msedgewebview2 进程存活，然后：

```powershell
icacls "D:\xiaojianc\poietica" /setintegritylevel "(OI)(CI)M" /T /C
```

`/T` 只是清掉已固化的旧标签；子对象本身会继承父目录的新标签。

## 找打标签的嫌疑方

三个特征查一遍：

1. 本地组 `CodexSandboxUsers`（`Get-LocalGroup`）
2. 服务 `CodexSandboxService.*`（`Get-Service`）
3. 仓库 DACL 上带组 SID 的 ACE（`icacls` 输出里的 `S-1-5-21-...` 行）

本机 2026-09-29 的元凶是 OpenAI Codex 桌面版（ChatGPT 应用）的 Windows 沙箱
服务，已卸载。

## 附带清理：WebView2 崩溃风暴

文件层拒绝解决后，若窗口仍 `failed to receive message from webview`，是
崩溃风暴遗留的僵尸进程与陈旧 EBWebView 缓存：

```powershell
taskkill /F /IM msedgewebview2.exe
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\com.poietica.Poietica.dev\EBWebView"
```

EBWebView 是纯缓存，删除只丢 webview 本地状态（localStorage 等）。
