# 0023. harness 的 SDK 线是它自己能力的一个子集

> Status: accepted

## 背景

deepseek-harness 有两种被驱动的方式，而它们能做的事不一样。

同进程：官方 apps/web 与 apps/cli 是 Cordis 插件，手上是 ctx.agents 交出来的
Agent 句柄。那个句柄上有 cancel(cause, options?)、有可变的 ModelSelection
（packages/core/agent/src/model-selection.ts，官方明说切换在后一个 step 生效）、
有 runMaintenance、有 inject 与 steer。

跨进程：@deepseek-ai/dsh-sdk-jsonrpc-server 只把三个方法挂上线 ——
initialize、session/prompt、shutdown —— 并只往回报四条通知。cancel 不在其中，
模型选择也不在：provider 与 model 只在 initialize 收一次。

## 裁决

我们走 SDK 那条线，并且如实承认它是子集。

走它的理由：poietica 是 Tauri 应用，没有 Node 运行时可以让 harness 作为库住进来。
官方给外部客户端的线协议只有这一条。

承认它是子集的理由：把 SDK 的缺口说成 DeepSeek 的产品特性，会让界面按一个假的
模型去设计。这条线上停不了一轮，不是因为 harness 停不了，而是因为这个口没开。
两者对界面的后果不同：前者该把停止按钮做成别的东西，后者该等这个口开。

于是：拿不到的能力一处都不假装，也一处都不用另一套机制补。harness 那侧一旦
把 cancel 挂上线，改动只在 dsh_driver.rs 一个文件里 —— 帧契约、投影、界面
都不用动，因为 turn/end 早就带着 aborted 的原因。

## 后果

- 这条线上没有 session/load、session/delete、session/fork：三张凭证一张都不铸，
  拿不出凭证的调用编译不过。
- 这条线上没有会话级选择器：provider 与 model 定在握手上，换它们等于换进程。
- 这条线上停不了一轮：Command::Cancel 到达即无事发生，界面另行处置。
- 图片块的形状还没有取证，所以带图的一句话被拒绝而不是猜一个形状发出去。
