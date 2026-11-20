# ADR-003：进程拓扑

状态：已实施。

UI、Host、Core、Runtime 分工：Host 管理窗口、系统能力及凭据，Core 管理产品事实，Runtime 执行 omp。Runtime 已外置；UI–Core 直连数据面仍默认关闭，控制面走 Host。
