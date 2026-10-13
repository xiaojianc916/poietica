/*
 * 真实布局检查要喂的来字节奏。这段思考文本用一个字母都不重复的句子拼出来：指标靠
 * 「上一批的长度 + 1 有没有印出来」算延迟，重复的句子会让身份（起始偏移）无法区分。
 */

export interface Arrival {
  readonly at: number
  readonly length: number
}

export interface Stream {
  readonly id: string
  readonly arrivals: readonly Arrival[]
  /** 4 秒时拖窄到 520px，6.5 秒回到 760px */
  readonly resize: boolean
  readonly reduced: boolean
}

/**
 * 会在 760px 上溢出，句子普遍在 40 字以上 —— 两条都是硬要求：整段放不下，滑行才有东西可量；
 * 单句也放不下，才走「写满之后继续往左走」那一段。40 字以下在 760px 上放得下，放得下就没有滑行，
 * 抖动与应动未动两项全是 0，检查看着全绿，其实什么都没查。
 * 极快档 6 秒要 1200 个字，这段因此要更长，否则量到的只是流结束后的收尾。
 */
export const THOUGHT =
  '把这条链路从头到尾理一遍：命令从 tools 入口进来，经过 registry 分派，最后落到 executor 上执行，中间每一层都会把参数复制一份再往下传，谁都可以改写，谁都以为拿到的还是原始值，出问题的时候却没人说得清到底是哪一层动的手。' +
  '所以我打算在每一层的入口和出口各打一条带上下文的日志，把关键字段原样记下来，级别不能开得太高，正常轮询每秒都要走一遍，开成 debug 会把日志文件撑到几百兆，只在进入与失败时各记一条就够，剩下的靠错误码去追。' +
  '接着确认 relay 的监听地址究竟是从哪里来的，是谁把它传给子进程的，中间有没有经过一次字符串拼接或者一次默认值填充，这类地方最容易藏住一个不会报错的错，等到有人连不上才发现端口早就换了。' +
  '我翻到 config.ts，里面写的是 127.0.0.1 加上 8787，可 run.ts 的默认值又是另一个端口，两边看起来早就分叉了，配置文件里那一行大概是某次调端口时顺手改的，代码里的默认值没人想起来一起改，于是两个值各自活得好好的。' +
  '如果两边不一致，就以命令行传进来的为准，把实际生效的那个数写回配置文件，并在启动日志里记下这次覆盖，免得下次有人对着配置发半天呆，还在怀疑是不是防火墙把包吃了或者代理把地址重写了。' +
  '然后重新跑一遍核心探针，确认监听地址确实换了，再翻一遍子进程的 stderr，看看有没有被 catch 吞掉的异常，尤其是那种 catch 里只写了一句没用的注释、连日志都没有的地方，那种地方出了问题只会表现为超时。' +
  '另一个可疑点是启动顺序：校验收在 onReady 里，可调用方在 setup 阶段就已经把请求发出去了，两边只差几十毫秒，本地机器上几乎不可能撞上，所以我一直没往这个方向想，直到用户的日志里出现了排队的记录。' +
  '这种竞态在本地很难复现，因为子进程起得快，一秒之内就能就绪，只有冷启动、磁盘正忙、杀毒软件正在扫描新编译出来的可执行文件的时候才会露出破绽，而用户那边报的正是这个场景。' +
  '为了让它稳定复现，我把启动延迟人为拉长到几百毫秒，再把队列长度和每次重试的间隔打出来，几次下来就看清楚了整个模式：问题不在排队本身，而在超时之后的重试策略，现在的重试没有上限，失败一次就再排一次。' +
  'core 重启的时候这个循环会一直转下去，把日志刷满，直到有人手动把窗口关掉，或者磁盘先被写满，这期间界面看到的永远是转不完的进度，用户唯一能做的事就是把整个应用杀掉再重开。' +
  '合理的做法是带上退避：第一次等两百毫秒，之后每次翻倍，封顶在五秒，连续三次失败就报一条明确的错误，消息里带上端口、进程名和最后一次的退出码，而不是只留一个 failed，让下一个看日志的人从头再猜一遍。' +
  '接下来看时间线那一块，epoch 与 seq 的组合在手动重启之后会不会错位，协议里说 epoch 每次重启都要变，可现在的实现只在冷启动时生成一次，热重启用的是同一个值，增量投影因此会出现重复的 step。' +
  '修法有两种：要么让 core 每次就绪都换一个新的 epoch，要么在握手的时候显式告诉界面这是第几代，我倾向于第二种，因为 epoch 的语义是这一次会话，换代的动作应该由生命周期显式驱动，而不是藏在某个构造函数里。' +
  '还要检查订阅的清理：界面卸载之后旧的订阅必须摘掉，否则回调会打到已经销毁的 store 上，zustand 的 store 是模块级的，不会随组件卸载消失，清理只能靠显式 dispose，不能指望作用域，这类泄漏在开发时看不出来，跑上一天才会显形。' +
  '把这几处对齐之后，再回头看渲染那一层：虚拟列表的测量函数有没有被挂到稳定的元素上，组头的高度是最容易变的，一句话换行就会多出一行，measureElement 拿到的就是错的数，滚动补偿也会跟着一起抖。' +
  '所以行高必须锁死在一行，超出部分交给省略号，这个环得在样式层断开，而不是靠在脚本里反复纠偏，测出来的高度和看到的高度一致了，补偿才不会再跳，列表滚动也才能稳下来。' +
  '下一步是性能：每帧都在读 offsetWidth 会强制同步布局，一千条记录的列表会因此掉到二十帧，把尺寸的读取收进一次 ResizeObserver，逐帧那一层只写 transform，合成线程就不会被打断。' +
  '最后确认失败路径：任何一处抛异常都要先把状态机收回 idle，再往外抛，资源放在 finally 里释放，不能让一轮挂在那里，也不能让已经释放过的回调继续改状态。'

/**
 * 几种节奏都只在前 6 秒里来字：延迟量的是「这一批的字什么时候印出来」，来字停下时那一句往往正写到
 * 一半，剩下的字按估计速度慢慢放 —— 那是收尾，不是稳态。
 */
export const STREAM_MS = 6000

function batches(every: number, chunk: number, limitMs = STREAM_MS): Arrival[] {
  const out: Arrival[] = []
  let count = 0

  for (let at = every; at <= limitMs; at += every) {
    count += 1
    out.push({ at, length: Math.min(THOUGHT.length, count * chunk) })
    if (out[out.length - 1]?.length === THOUGHT.length) break
  }

  return out
}

/**
 * 慢速档：每 90ms 来 1 个字，第 70 批之后停 1.5 秒，再接着来满 12 秒。这段停顿是「停笔」那条验收：
 * 缓冲放干、滑行在 600ms 内停下、不会往回滑。它落在流的中间，停顿期间句首当然不动 —— 指标里
 * 「正在出字」那一项就是为了把这部分静止排除掉，不然正确行为会被记成「应动未动」。
 */
function slowBatches(): Arrival[] {
  const out: Arrival[] = []

  for (let index = 1; index * 90 <= 12_000; index += 1) {
    const at = index * 90 + (index > 70 ? 1500 : 0)

    out.push({ at, length: Math.min(THOUGHT.length, index) })
  }

  return out
}

export const STREAMS: readonly Stream[] = [
  { id: 'steady', arrivals: batches(50, 1.5), resize: false, reduced: false },
  { id: 'batched', arrivals: batches(250, 6), resize: false, reduced: false },
  { id: 'fast', arrivals: batches(40, 8), resize: false, reduced: false },
  { id: 'slow', arrivals: slowBatches(), resize: false, reduced: false },
  { id: 'resize', arrivals: batches(50, 1.5), resize: true, reduced: false },
  { id: 'reduced', arrivals: batches(250, 6), resize: false, reduced: true },
]

export const SCENARIO_IDS: readonly string[] = STREAMS.map((stream) => stream.id)

export function streamById(id: string): Stream | undefined {
  return STREAMS.find((stream) => stream.id === id)
}
