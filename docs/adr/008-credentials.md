# ADR-008：执行安全模型（凭据与策略）

状态：凭据目标通过；P4 第一道防线（宿主策略）已落地；OS 沙箱（第二道防线）待做。

Host 使用 Electron safeStorage 加密并持有凭据，拒绝 Linux 明文回退；Core 仅通过限定调用方的 `secrets.lease` 获取内存副本，手动设置的 API Key 注入引擎运行态而非写入引擎配置；账号/OAuth 与浏览器授权仍由 omp 持久化，尚未完成安全迁移。旧明文在加密保存成功后清除，保存失败保留旧值以避免丢失。既有加密库不等于旧版可直接读取：回退时可能需重新配置凭据。DPAPI 的真实平台行为与旧存储残留须在 Windows 上验证。

P4 第一道防线（2026-11-14）：

- Worker 的每个内置/产品工具调用在 omp `tool_call` 处先经 ARP `policy.check` 交给 Core 的 policy 模块；Core 按会话档位、工具分类与命令/路径裁决，并把 `policy.decided` 写入 Journal。
- 装了策略门后 `tools.approvalMode` 固定为 `yolo`：omp 自己的审批让位，避免同一件事问两遍；审批由产品自己的结构化 `approval` 交互卡片完成，全链路不解析界面文案。
- 未知工具按高风险询问；Core 不可用时 fail closed。
- 策略门以文件扩展装入（`additionalExtensionPaths`），omp 的 task 执行器按路径继承给子代理；子代理工具同样走 `policy.check`。
- 仍未做：OS 沙箱（Job Object / 受限令牌）、`sandbox-win` 包、网络白名单代理、审批超时策略的配置化；同一 cwd 多线程不同档位时，子代理按「最严格的门」路由，审批卡片可能落在另一个线程（已记入待决清单）。
