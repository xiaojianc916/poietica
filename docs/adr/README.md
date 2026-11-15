# 架构决策记录

P0 决策根据架构设计 §24.2 制定；「目标」不表示后续阶段已实施。后续新增决策应记录状态、理由、后果及迁移计划。

| ADR                                  | 决策                         | 状态                                            |
| ------------------------------------ | ---------------------------- | ----------------------------------------------- |
| [001](001-omp.md)                    | 唯一引擎 omp                 | 通过                                            |
| [002](002-facts.md)                  | 产品模型与事实归属           | 通过                                            |
| [003](003-processes.md)              | 进程拓扑                     | 通过；实现分阶段                                |
| [004](004-data-migrations.md)        | 数据迁移                     | 通过                                            |
| [005](005-journal.md)                | Thread Journal               | 通过；P2 实施中                                 |
| [006](006-stream.md)                 | 流原语与主题路由             | 通过；P2 实施中                                 |
| [007](007-runtime.md)                | omp Runtime 外置与 ARP       | 已实施；P3b 收口                                |
| [008](008-credentials.md)            | 执行安全模型：凭据与策略     | 凭据通过；P4 策略门与 L1 已落地；L2 待做        |
| [009](009-workbuddy.md)              | WorkBuddy 去留               | 暂缓：用户决定本轮不动                          |
| [010](010-workspaces-checkpoints.md) | 工作区与 Checkpoint          | 已实施；撤销/租约/worktree 后端已接，UI 待接    |
| [011](011-consistency.md)            | Outbox、幂等与持久工作流     | 已实施；outbox/中断/续跑已接，worktree 对账待做 |
| [012](012-modules-settings.md)       | 模块类型、描述符与设置注册表 | 部分实施；conversation 拆分待做                 |
| [013](013-omp-upgrade.md)            | omp 升级流水线               | 持续实施；73 处深层 import 待上游               |

- [007-runtime.md](007-runtime.md)：omp Runtime 外置与 ARP（实施中）。
