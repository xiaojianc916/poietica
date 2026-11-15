# ADR-008：执行安全模型（凭据与策略）

状态：凭据目标通过；P4 第一道防线（宿主策略）已落地；OS 沙箱 L1（Job Object）已落地，L2（受限令牌 / 低完整性级别）待做。

Host 使用 Electron safeStorage 加密并持有凭据，拒绝 Linux 明文回退；Core 仅通过限定调用方的 `secrets.lease` 获取内存副本，手动设置的 API Key 注入引擎运行态而非写入引擎配置；账号/OAuth 与浏览器授权仍由 omp 持久化，尚未完成安全迁移。旧明文在加密保存成功后清除，保存失败保留旧值以避免丢失。既有加密库不等于旧版可直接读取：回退时可能需重新配置凭据。DPAPI 的真实平台行为与旧存储残留须在 Windows 上验证。

P4 第一道防线（2026-11-14）：

- Worker 的每个内置/产品工具调用在 omp `tool_call` 处先经 ARP `policy.check` 交给 Core 的 policy 模块；Core 按会话档位、工具分类与命令/路径裁决，并把 `policy.decided` 写入 Journal。
- 装了策略门后 `tools.approvalMode` 固定为 `yolo`：omp 自己的审批让位，避免同一件事问两遍；审批由产品自己的结构化 `approval` 交互卡片完成，全链路不解析界面文案。
- 未知工具按高风险询问；Core 不可用时 fail closed。
- 策略门以文件扩展装入（`additionalExtensionPaths`），omp 的 task 执行器按路径继承给子代理；子代理工具同样走 `policy.check`。
- 写入边界改为按 `path.relative` 判定，`/w2` 不再被误认成 `/w` 之内；产品工具只报「这是写」而没有具体路径时，auto-edit 也先询问，不再盲放。
- 仍未做：L2 受限令牌 / 低完整性级别与工作区外写入的 OS 级拒绝、网络白名单代理、审批超时策略的配置化、审批授权管理页；同一 cwd 多线程不同档位时，子代理按「最严格的门」路由，审批卡片可能落在另一个线程（已记入待决清单）。

P4 第二道防线 L1（2026-11-15）：

- 新增 `packages/sandbox-win`：Runtime Worker 启动后立即放进 Job Object，限制进程数（默认 64）与内存（默认 4 GiB），`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 保证 Core 退出或 Job 关闭时进程树一起结束。
- `TerminateJobObject` 取代单独依赖 `taskkill /T`：omp 的 detached daemon 等脱离父子关系的进程也在 Job 里，能被一起收掉。
- 启动时 `sandboxSelfCheck` 起一个短命进程验证 `IsProcessInJob`；自检失败明确记 warn 并降级到 off，不静默降级。`POIETICA_SANDBOX=off` 可显式关闭。
- `restricted` 级别会明确报「尚未实现」，不会假装成已沙箱。
