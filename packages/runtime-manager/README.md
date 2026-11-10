# @poietica/runtime-manager

（一句话说明职责；见架构文档 03 页 §2.2。）

RuntimeProcess：起 Worker 子进程、stdio 传输、ARP 握手、请求转发、停止与意外退出状态；工作树路由与退避重启由上层组合。
