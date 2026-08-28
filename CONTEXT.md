# Poietica

本地优先的 kap 客户端桌面应用：接入外部编码代理，屏幕上那条对话由本机帧日志投影而来。
本文件是领域术语表——只定义「是什么」，不写实现；实现归 AGENTS.md 与 docs/architecture/。

## Language

**代理（agent）**:
被本应用接入的外部编码代理程序（现唯一一家是 Kimi Code）。
_Avoid_: AI、机器人、助手、模型

**对话（thread）**:
用户侧可见的对话索引单位，线程账是其唯一写者。
_Avoid_: 会话、聊天、thread 之外的泛称

**会话（session）**:
代理进程内的一次执行上下文；重开一条对话即按帧重放重建它。
_Avoid_: 对话、聊天、连接

**帧（frame）**:
从代理流入的一次结构化事件；先落运行事件账本，再上屏。
_Avoid_: 消息、事件、日志行

## 帧流与持久化

**录制器（recorder）**:
给帧派发会话内单调序号的组件；成形与投递两段式。
_Avoid_: 日志器、记录器

**运行槽位（RunSlot）**:
同时在跑的代理执行的占位与门禁，多会话并发的常态由此约束。
_Avoid_: 队列、线程池

**运行事件账本（run_events）**:
每一帧的持久化正本；重放账本即重建屏幕。
_Avoid_: 日志、历史表

**线程账（threads）**:
对话索引的唯一写者；对话列表从这里来。
_Avoid_: 会话表、目录

**对话转录库（transcript-store）**:
一条对话全部已上映帧的持有者与路由者；held/alias/routes 同写三表，内聚不拆。
_Avoid_: 消息列表、缓存

**kap 帧投影（kap-projection）**:
唯一认识 kap 帧形状的翻译层，把帧投影成时间线行。
_Avoid_: 解码器、适配器、转换器

## 代理接入

**代理名录（agent-catalog）**:
所有可接入代理的档案正本：program、args、homeVar、方言。通用层不认得任何一家的名字。
_Avoid_: 插件列表、配置中心

**代理契约（agent-contract）**:
TS 侧的端口类型契约，零运行时依赖。
_Avoid_: 接口包、协议包

**驱动器（driver）**:
连接代理子进程并循环收发的部件：WebSocket 收帧，HTTP 走访端点。
_Avoid_: 控制器、客户端

**事件路由器（EventRouter）**:
驱动器内把 WebSocket 事件分派到各会话的部件。
_Avoid_: 分发器、总线

**守护开关（daemon）**:
代理子进程的守护进程模式；开关背后仍是同一个驱动器。
_Avoid_: 后台服务、常驻进程

## 宿主与界面

**进程桥（ipc）**:
TS 侧唯一被允许直连宿主的传输层；命令清单正本在 Rust 的 surface()。
_Avoid_: API 层、通道

**组合根（composition root）**:
一个进程一份的接线处：TS 侧是应用壳，Rust 侧是 src-tauri。
_Avoid_: 入口、启动器

**审查台（review）**:
对代理改动做代码审查的界面；与时间线共用同一条 diff 管线。
_Avoid_: diff 面板、代码评审

**吉祥物（mascot）**:
桌面助手形象；几何资产与驱动引擎内聚在会话界面包内。
_Avoid_: 宠物、头像
