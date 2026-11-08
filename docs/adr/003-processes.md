# ADR-003：进程拓扑

状态：通过（P0 决策，分期实施）。

目标分 UI、Host、Core、Runtime：Host 管理窗口、系统能力及凭据，Core 管理产品事实，Runtime 执行 omp，UI 与 Core 直连数据面。当前 Host 中转与进程内运行时保留；直连在 P2，Runtime 外置在 P3。此顺序先建立可恢复记录与流，再拆分运行时，避免误称 P0 已实现目标拓扑。
