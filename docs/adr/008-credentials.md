# ADR-008：执行安全模型（凭据与策略）

状态：凭据目标通过；P4 第一道防线（宿主策略）已落地；OS 沙箱 L1（Job Object）已落地，L2（受限令牌 / 低完整性级别）待做。

Host 使用 Electron safeStorage 加密并持有凭据，拒绝 Linux 明文回退；Core 仅通过限定调用方的 `secrets.lease` 获取内存副本，手动设置的 API Key 注入引擎运行态而非写入引擎配置；账号/OAuth 与浏览器授权仍由 omp 持久化，尚未完成安全迁移。旧明文在加密保存成功后清除，保存失败保留旧值以避免丢失。既有加密库不等于旧版可直接读取：回退时可能需重新配置凭据。DPAPI 的真实平台行为与旧存储残留须在 Windows 上验证。

P4 第一道防线（2026-11-14）：

- Worker 的每个内置/产品工具调用在 omp `tool_call` 处先经 ARP `policy.check` 交给 Core 的 policy 模块；Core 按会话档位、工具分类与命令/路径裁决，并把 `policy.decided` 写入 Journal。
- 装了策略门后 `tools.approvalMode` 固定为 `yolo`：omp 自己的审批让位，避免同一件事问两遍；审批由产品自己的结构化 `approval` 交互卡片完成，全链路不解析界面文案。卡片载荷现在带 `risk` / `rule` / `category` / `reason`（ARP 2，协议 69）。
- 未知工具按高风险询问；Core 不可用时 fail closed。
- 只读档（read-only）曾进入会话 Posture 与 ARP 档位，产品权限选择器可选。用户选「本会话都批准」后，Worker 经 ARP `policy.grant` 把放行写进 `policy_grants`（24 小时），Core 下次裁决直接放行；`policy.grants.list` / `policy.grants.revoke` 可列出与撤销（2026-11-15 按事实归属改名，原来叫 `policy.grants` / `policy.revoke`）。**2026-11-22 用户裁决删除只读档**：它在 omp 层与 `ask` 映射到同一个 `always-ask`，真实差别只在宿主策略门；而这里写的「写入与命令被拒绝」从未在代码里成立（exec 一直是 `ask`），保留一个名不副实的第四档只会误导。存量线程 / 自动化迁移为 `ask`，详见 `docs/refactor-log.md`「删除只读档」。
- 策略门以文件扩展装入（`additionalExtensionPaths`），omp 的 task 执行器按路径继承给子代理；子代理工具同样走 `policy.check`。
- 写入边界改为按 `path.relative` 判定，`/w2` 不再被误认成 `/w` 之内；产品工具只报「这是写」而没有具体路径时，auto-edit 也先询问，不再盲放。
- 仍未做：L2 受限令牌 / 低完整性级别与工作区外写入的 OS 级拒绝、网络白名单代理的**强制面**、审批超时策略的配置化；同一 cwd 多线程不同档位时，子代理按「最严格的门」路由，审批卡片可能落在另一个线程（已记入待决清单）。

P4 第二道防线 L1（2026-11-15）：

- 新增 `packages/sandbox-win`：Runtime Worker 启动后立即放进 Job Object，限制进程数（默认 64）与内存（默认 4 GiB），`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 保证 Core 退出或 Job 关闭时进程树一起结束。
- `TerminateJobObject` 取代单独依赖 `taskkill /T`：omp 的 detached daemon 等脱离父子关系的进程也在 Job 里，能被一起收掉。
- 启动时 `sandboxSelfCheck` 起一个短命进程验证 `IsProcessInJob`；自检失败明确记 warn 并降级到 off，不静默降级。`POIETICA_SANDBOX=off` 可显式关闭。
- `restricted` 级别会明确报「尚未实现」，不会假装成已沙箱。

P4 收尾（2026-11-15）：

- **审批授权管理页**：设置 → 系统 →「授权管理」列出未过期的放行记录（工具名、会话、到期时刻）并可逐条撤销；撤销把 `policy.revoked` 写进 Journal。撤销一条早已过期的记录时如实报「它已经不存在了」，不假装成功。
- **审计三件事全留痕**：放行 / 询问 / 拒绝、发放放行、撤销放行分别写 `policy.decided` / `policy.granted` / `policy.revoked`。`policy.decided` 补 `risk` / `workspaceRoot` / `toolCallId`，审计可按工具、风险等级与工作区查询（跨线程，`threadId` 可选）。审计写失败只记 warn：记录不上不该让裁决失效。
- **网络出口规则（§13.1 的「关闭 / 白名单 / 全部开放」）**：`PolicyContext.url` 给出这次要访问的目标，规则码 `network.allowlist` / `network.not_allowlisted` / `network.unparsed`，命中的规则与主机名单独放在 `PolicyDecision.network`。无法解析的目标一律先问。**这一层只裁决、不拦流量** —— 强制面（按 §13.3 给 Worker 注入代理环境变量）仍未做。
- **凭据只读化到引擎配置为止**：手动设置的 API Key 与凭据类设置都不写进 `config.yml` / `models.yml`（`auth: none` + 运行时钥匙层），搬不动的旧明文由启动路径报 error 而不是静默 warn；两条测试逐字节扫描数据根与引擎配置目录。**仍未达成**：`features/workbuddy` 的账号令牌（明文，功能自己的 SQLite 表）与 `models.yml` 里带着反代口令的 `baseUrl`。搬迁被次序卡住（Worker 早于 workbuddy 的 onReady 启动），需要「Worker 就绪后补注入」的注入口；已实测 omp 的 `models.yml` 支持 `headers` 的环境变量间接、不支持 `baseUrl` 的。见 refactor-log 的待决问题。
