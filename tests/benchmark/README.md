# 打开对话的基准

量的是"点开一条超大对话"这一路上，本进程要付的账。

```bash
bun run bench:open     # 解码 → 装入 → 投影 → 成帧，四段计时
bun run bench:reads    # server 的整份正文被要了几次
```

## 为什么是这两件事

打开一条对话，真正随对话大小线性放大的只有两样：

1. **把正文解出来**（`bench:open`）。`JSON.parse` + zod 校验、装进官方 reducer、
   投影成 `TimelineState`、再成帧成屏幕按行问的 `Presentation`。全在一个同步任务里，
   就是那一帧要交的账。
2. **server 的正文被要了几次**（`bench:reads`）。冷会话的正文是 server 从 wire
   records 现场重建的，几十万字节；本机实测一次往返 6–10 ms。多要一次就多花一次。

网络与 IPC 本身不在计时里：它们随机器与链路变，不随代码变。

## 数据从哪来

`fixtures/real-conversation.json` 取自本机 kimi web 的
`GET /api/v1/sessions/{id}/transcript?agent_id=main`，是 server 应答的 `data` 那一层
（信封由 Rust 在 agent-client 的桥驱动里拆掉，过桥的只有它）。

**正文已替换为同长度填充物**：原件是用户自己的对话原文与本机路径。
替换保持三件事不变：

- 序列化后的**字节数**（631 KB）—— 长度一变计时就没意义；
- **字符谱**（ASCII 正文夹换行、引号、反斜杠与中文）—— 纯 ASCII 比真实正文解得快一倍以上；
- **结构**（轮/步/帧的类型计数、字段名集合、类型树形状）—— 判别式与分支才是被测对象。

`"超大"那一档`用真实轮次模板复制拼接，形状仍是 server 发的那种，只是轮数可控
（2 / 16 / 64 / 256 轮）。

## 场景照抄线上的时序

本机 180 条对话里 178 条是"冷会话"（server 内存里没有的旧对话）：

| | 冷会话（178/180） | 在跑的会话（2/180） |
| --- | --- | --- |
| 订阅 `subscribe_v2` | 只回 ack，**没有 transcript 帧** | 每条 agent 回一个 `transcript.reset`（`items:[]`、`has_more_older:true`、`seq`） |
| `GET /transcript` | 正文，**没有 `seq`** | 正文，带 `seq` |
| `GET /transcript/ops` | `complete:false`、`latest_seq:0` | `complete:true`、`latest_seq` 与 `seq` 相等 |

`reset` 在 Rust 的 `activate` 里订阅（`subscribe_transcript`），早于 `open_thread`
读正文，所以它在 `route` 之前抵达 TS。

## 数字怎么读

`bench:open` 报中位数（3 次预热 + 15 次取样）。`bench:reads` 报的是计数，不是时间 ——
计数不受机器噪声影响，是这一路上最可信的一条判据。
