# @poietica/feature-secrets

凭据库（ADR-008 / 架构设计 §13.4）。Host 用 Electron `safeStorage`（Windows 上即 DPAPI，绑当前 Windows 账户）
加密后写进 `<数据根>/secrets/vault.json`，磁盘上不留明文；系统加密不可用时拒绝保存，绝不退回明文。

子入口：

- `contract`：`secrets.lease` / `secrets.put` / `secrets.delete`，三个都声明 `callers: ['core']` —— 渲染进程调用等同
  方法不存在（RPC Hub 拒绝），拿不到任何明文。
- `host`：`vault.ts`（加解密与落盘，可注入 cipher 测试）、`safe-storage.ts`（Electron 适配）。

使用方（Core 模块）按命名空间取用：`model-api-keys`（models：服务商 API Key）、`omp-settings`（agent-settings：
omp 的凭据类设置）。Core 不持久化凭据：每次启动取回，交给引擎的运行时层（内存）。
