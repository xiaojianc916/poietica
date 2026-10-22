import '../../shared/styles/surface.css'
import './composer-actions.css'
import './auxiliary-composer.css'

import { useCopy } from '@poietica/design-system'
import { Prose } from '@poietica/design-system/prose'
import { latestSideTurn, type SideTopic, type SideTurn } from '@poietica/engine'
import { useFeatureStore } from '@poietica/ui-kernel'
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { SessionConfigControl } from '../../shared/model/config'
import {
  CheckIcon,
  ChevronLeftIcon,
  CloseIcon,
  ComposeIcon,
  CopyIcon,
  PlusIcon,
  ResetIcon,
  SpinnerIcon,
  StopIcon,
  SubmitIcon,
} from '../../shared/primitives/icons'
import { EMPTY_SIDE_THREAD, runningTopicOf, type SideStore, type SideThread, selectedTopicOf } from '../side-store'
import {
  ComposerPalette,
  type PaletteGroup,
  type PaletteRow,
  paletteKeyDown,
  useDismissOutside,
} from './composer-palette'
import { SessionControls } from './controls'

/*
 * 右坞第一格「辅助对话」：omp 的 `/btw` 侧边提问。拿这条对话此刻的上下文（含主轮正在流式输出的那一截）与模型问一句，
 * 答案流在这一格里，**不进对话记录、不打断主轮、不调用工具**（omp 的一次性回合从不执行工具调用）。
 *
 * 所以这一格没有批准方式、计划、目标这几样：它们管的是「agent 动手」，侧边一问从不动手；技能与 MCP 同理不进加号面板。
 * 模型与思考档位就是这条对话的那两格（换了主对话也跟着换 —— omp 的侧边一问沿用会话的模型，共用提示缓存）。
 *
 * 一个话题 = 第一问开题、之后的追问接在同一题下（omp 的 BtwHistoryRecord + followUps）；话题存在会话的 artifacts 里，
 * 重开软件还在。同一时刻只答一问：答着的时候发送键换成停止键，Esc 也是停止。
 */

export interface AuxiliaryComposerProps {
  /** 右坞此刻归哪条对话；null = 没有（入口页不画右坞，留着兜底） */
  readonly threadId: string | null
  readonly side: SideStore
  /** 这条对话的模型与思考档位（与主对话同一份） */
  readonly controls: readonly SessionConfigControl[]
  readonly onSelectControl: (controlId: string, value: string) => void
  /** 把一段答案放进这条对话的主输入框 */
  readonly onInsert: (threadId: string, text: string) => void
}

/** 空状态里列几个最近的话题；全部话题在加号面板里 */
const RECENT_LIMIT = 5
/** 加号面板里的话题上限：再多就是一张翻不完的表，旧话题很少回头看 */
const PALETTE_LIMIT = 20
/** 离底部这么近就算「跟着最新的走」：答案流出来时自动滚到底 */
const STICK_SLACK = 24

const STATUS_LABEL: Readonly<Record<SideTurn['status'], string | null>> = {
  running: '正在答',
  complete: null,
  cancelled: '已停止',
  error: '出错了',
  interrupted: '没答完',
}

/** 话题的一行说明：最后一问的状态，追问过就带上问了几次 */
export function sideTopicMeta(topic: SideTopic): string | undefined {
  const parts = [STATUS_LABEL[latestSideTurn(topic).status], topic.turns.length > 1 ? `${topic.turns.length} 问` : null]
  const shown = parts.filter((part): part is string => part !== null)
  return shown.length === 0 ? undefined : shown.join(' · ')
}

const titleOf = (topic: SideTopic): string => topic.turns[0]?.question ?? ''

export function AuxiliaryComposer({ threadId, ...rest }: AuxiliaryComposerProps) {
  if (threadId === null) {
    return (
      <section className="assistant-surface" data-assistant-skin data-phase="live">
        <div className="auxiliary-composer-pane__feed">
          <p className="auxiliary-composer-pane__empty">打开一条对话后，可以在这里就它随口问一句。</p>
        </div>
      </section>
    )
  }
  /* 换对话就是换一格：草稿、面板与滚动位置都不跨对话 */
  return <SideChat key={threadId} threadId={threadId} {...rest} />
}

function SideChat({
  controls,
  onInsert,
  onSelectControl,
  side,
  threadId,
}: Omit<AuxiliaryComposerProps, 'threadId'> & { readonly threadId: string }) {
  const thread = useFeatureStore(side.store, (s) => s.byThread[threadId] ?? EMPTY_SIDE_THREAD)
  const [draft, setDraft] = useState('')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const listboxId = useId()
  const bar = useRef<HTMLFormElement | null>(null)
  const input = useRef<HTMLInputElement | null>(null)

  /* 话题表只读一次：之后全靠 side.topic / side.delta 推（Core 换代时由 subscriptions 统一重读） */
  useEffect(() => {
    if (!side.of(threadId).loaded) void side.load(threadId)
  }, [side, threadId])

  const running = runningTopicOf(thread)
  const topic = selectedTopicOf(thread)
  const busy = running !== undefined || thread.asking

  const focusInput = useCallback(() => {
    input.current?.focus()
  }, [])
  const openTopic = useCallback(
    (topicId: string | null) => {
      side.select(threadId, topicId)
      focusInput()
    },
    [focusInput, side, threadId],
  )

  const groups = useMemo(() => sideTopicGroups(thread, openTopic), [openTopic, thread])
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups])
  const open = paletteOpen && rows.length > 0

  useDismissOutside(open, bar, () => setPaletteOpen(false))

  const pick = (row: PaletteRow) => {
    setPaletteOpen(false)
    if (row.action.kind === 'run') row.action.run(draft)
  }

  /* ask 从不抛：失败写进 thread.error、返回 false —— 那时把问题放回输入框（人在这之间又打了字就不动它） */
  const ask = (question: string, topicId?: string | null) => {
    void side.ask(threadId, question, topicId).then((asked) => {
      if (!asked) setDraft((held) => (held === '' ? question : held))
    })
  }

  const submit = () => {
    const question = draft.trim()
    if (question === '' || busy) return
    setDraft('')
    ask(question)
  }

  const stop = () => {
    void side.cancel(threadId)
  }

  /* 面板开着时这几个键归面板；面板关着、正在答时 Esc 是停止 */
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (!open && event.key === 'Escape' && running !== undefined) {
      event.preventDefault()
      stop()
      return
    }
    paletteKeyDown(event, {
      highlighted,
      onClose: () => setPaletteOpen(false),
      onHighlight: setHighlighted,
      onPick: pick,
      open,
      rows,
      stopPropagation: false,
    })
  }

  const feed = useFollowLatest(topic)
  const message = thread.error ?? thread.notice

  return (
    <section className="assistant-surface" data-assistant-skin data-phase="live">
      <div className="auxiliary-composer-pane__feed" data-scroll="true" onScroll={feed.onScroll} ref={feed.ref}>
        {topic === undefined ? (
          <SideIntro onOpen={openTopic} topics={thread.topics} />
        ) : (
          <SideTopicView
            busy={busy}
            onBack={() => openTopic(null)}
            onInsert={(text) => onInsert(threadId, text)}
            onRetry={(question) => ask(question, topic.id)}
            topic={topic}
          />
        )}
      </div>

      {message === null ? null : (
        <div className="auxiliary-chat__notice" data-tone={thread.error === null ? 'notice' : 'error'} role="alert">
          <span className="auxiliary-chat__notice-text">{message}</span>
          <button
            aria-label="关闭提示"
            className="auxiliary-chat__icon-button"
            onClick={() => side.dismiss(threadId)}
            type="button"
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>
      )}

      <AuxiliaryComposerBar
        formRef={bar}
        inputLabel="侧边提问"
        inputRef={input}
        leading={
          <button
            aria-controls={listboxId}
            aria-expanded={open}
            aria-label="话题"
            className="assistant-plus"
            onClick={() => {
              setHighlighted(0)
              setPaletteOpen((current) => !current)
            }}
            type="button"
          >
            <PlusIcon aria-hidden="true" />
          </button>
        }
        onChange={setDraft}
        onKeyDownCapture={onKeyDown}
        onStop={stop}
        onSubmit={submit}
        overlay={
          <ComposerPalette
            groups={groups}
            highlighted={highlighted}
            isOpen={open}
            listboxId={listboxId}
            onHighlight={setHighlighted}
            onPick={pick}
          />
        }
        placeholder={topic === undefined ? '问问侧边聊天...' : '接着问...'}
        running={running !== undefined}
        stopLabel="停止回答"
        submitDisabled={draft.trim() === '' || busy}
        trailing={<SessionControls controls={controls} onSelect={onSelectControl} />}
        value={draft}
      />
    </section>
  )
}

/** 加号面板：开新话题，或回到一个旧话题接着问（选中的那一行打勾） */
export function sideTopicGroups(
  thread: Pick<SideThread, 'topics' | 'selected'>,
  onOpen: (topicId: string | null) => void,
): readonly PaletteGroup[] {
  const rows: PaletteRow[] = [
    {
      id: 'side:new',
      icon: <ComposeIcon aria-hidden="true" />,
      label: '新话题',
      detail: '下一问不接着之前的话题',
      checked: thread.selected === null,
      action: { kind: 'run', run: () => onOpen(null) },
    },
    ...thread.topics.slice(0, PALETTE_LIMIT).map((topic): PaletteRow => ({
      id: `side:${topic.id}`,
      label: titleOf(topic),
      detail: sideTopicMeta(topic),
      checked: thread.selected === topic.id,
      action: { kind: 'run', run: () => onOpen(topic.id) },
    })),
  ]
  return [{ id: 'side-topics', heading: '话题', rows }]
}

/**
 * 跟着最新的走：人停在底部附近时，答案每流出一截就滚到底；人往上翻过就不抢他的位置。换话题时回到「跟着走」。
 * `ref` 与 `onScroll` 挂在可滚动的那一格上。
 */
function useFollowLatest(topic: SideTopic | undefined) {
  const ref = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)
  const latest = topic === undefined ? undefined : latestSideTurn(topic)
  const topicId = topic?.id

  useLayoutEffect(() => {
    if (topicId !== undefined) stick.current = true
  }, [topicId])

  useLayoutEffect(() => {
    const el = ref.current
    if (el === null || !stick.current || latest === undefined) return
    el.scrollTop = el.scrollHeight
  }, [latest])

  const onScroll = useCallback(() => {
    const el = ref.current
    if (el !== null) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLACK
  }, [])

  return { ref, onScroll }
}

function SideIntro({
  onOpen,
  topics,
}: {
  readonly topics: readonly SideTopic[]
  readonly onOpen: (topicId: string) => void
}) {
  return (
    <div className="auxiliary-chat__intro">
      {topics.length === 0 ? null : (
        <section aria-label="最近的话题" className="auxiliary-chat__recent">
          <h3 className="auxiliary-chat__recent-heading">最近的话题</h3>
          <ul className="auxiliary-chat__recent-list">
            {topics.slice(0, RECENT_LIMIT).map((topic) => {
              const meta = sideTopicMeta(topic)
              return (
                <li key={topic.id}>
                  <button className="auxiliary-chat__recent-row" onClick={() => onOpen(topic.id)} type="button">
                    <span className="auxiliary-chat__recent-question">{titleOf(topic)}</span>
                    {meta === undefined ? null : <span className="auxiliary-chat__recent-meta">{meta}</span>}
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}

function SideTopicView({
  busy,
  onBack,
  onInsert,
  onRetry,
  topic,
}: {
  readonly topic: SideTopic
  /** 有一问在答（或正在开问）：重试点不动 */
  readonly busy: boolean
  readonly onBack: () => void
  readonly onInsert: (text: string) => void
  readonly onRetry: (question: string) => void
}) {
  const last = topic.turns.length - 1
  return (
    <div className="auxiliary-chat__topic">
      <button className="auxiliary-chat__back" onClick={onBack} type="button">
        <ChevronLeftIcon aria-hidden="true" />
        <span>全部话题</span>
      </button>
      <ol aria-label={titleOf(topic)} className="auxiliary-chat__turns">
        {topic.turns.map((turn, index) => (
          <SideTurnView
            busy={busy}
            /* 一问一答只会往后追加、从不删改顺序：下标就是这一问在话题里的身份（与 side.delta 的 turn 同一个数） */
            key={`${topic.id}:${String(index)}`}
            last={index === last}
            onInsert={onInsert}
            onRetry={onRetry}
            turn={turn}
          />
        ))}
      </ol>
    </div>
  )
}

function SideTurnView({
  busy,
  last,
  onInsert,
  onRetry,
  turn,
}: {
  readonly turn: SideTurn
  readonly last: boolean
  readonly busy: boolean
  readonly onInsert: (text: string) => void
  readonly onRetry: (question: string) => void
}) {
  const answering = turn.status === 'running'
  /* 只有最后一问能重问：就是在同一个话题里把这句再问一遍（omp 会为它换一条新的提供方会话线） */
  const retryable = last && !answering && turn.status !== 'complete'

  return (
    <li className="auxiliary-chat__turn" data-status={turn.status}>
      <p className="auxiliary-chat__question">{turn.question}</p>
      <SideAnswer turn={turn} />
      <SideTurnOutcome turn={turn} />
      {answering ? null : (
        <SideTurnActions
          answer={turn.answer}
          busy={busy}
          onInsert={onInsert}
          onRetry={retryable ? () => onRetry(turn.question) : undefined}
        />
      )}
    </li>
  )
}

/** 答案正文：流着的时候带光标；还一个字没出来时说「正在想」 */
function SideAnswer({ turn }: { readonly turn: SideTurn }): ReactNode {
  const answering = turn.status === 'running'
  if (turn.answer.trim() !== '') {
    return <Prose className="auxiliary-chat__answer" streaming={answering} text={turn.answer} />
  }
  if (!answering) return null
  return (
    <p className="auxiliary-chat__thinking" role="status">
      <SpinnerIcon aria-hidden="true" className="auxiliary-chat__spinner" />
      <span>正在想…</span>
    </p>
  )
}

/** 答完的那一问能做的事：复制、放进主对话的输入框；没答成的最后一问能重问 */
function SideTurnActions({
  answer,
  busy,
  onInsert,
  onRetry,
}: {
  readonly answer: string
  readonly busy: boolean
  readonly onInsert: (text: string) => void
  readonly onRetry: (() => void) | undefined
}): ReactNode {
  const { copied, copy } = useCopy()
  const answered = answer.trim() !== ''
  if (!answered && onRetry === undefined) return null
  const copyLabel = copied ? '已复制' : '复制回答'
  return (
    <div className="auxiliary-chat__actions">
      {answered ? (
        <>
          <button
            aria-label={copyLabel}
            className="auxiliary-chat__icon-button"
            data-copied={copied ? 'true' : undefined}
            onClick={() => copy(answer)}
            title={copyLabel}
            type="button"
          >
            {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          </button>
          <button
            aria-label="放进输入框"
            className="auxiliary-chat__icon-button"
            onClick={() => onInsert(answer)}
            title="放进主对话的输入框"
            type="button"
          >
            <ComposeIcon aria-hidden="true" />
          </button>
        </>
      ) : null}
      {onRetry === undefined ? null : (
        <button className="auxiliary-chat__text-button" disabled={busy} onClick={onRetry} type="button">
          <ResetIcon aria-hidden="true" />
          <span>重问一次</span>
        </button>
      )}
    </div>
  )
}

/** 没有正常答完的那一问说一句为什么：停止、出错与「上次没答完」是三件事 */
function SideTurnOutcome({ turn }: { readonly turn: SideTurn }): ReactNode {
  if (turn.status === 'cancelled') return <p className="auxiliary-chat__outcome">已停止</p>
  if (turn.status === 'interrupted') {
    return <p className="auxiliary-chat__outcome">上次没答完：软件在作答时关掉了</p>
  }
  if (turn.status === 'error') {
    return (
      <p className="auxiliary-chat__outcome" data-tone="error">
        {turn.error === null || turn.error === '' ? '出错了，没有拿到回答' : `出错了：${turn.error}`}
      </p>
    )
  }
  return null
}

export interface AuxiliaryComposerBarProps {
  readonly value: string
  readonly onChange: (value: string) => void
  /** 提交（Enter 或点发送键）；表单默认的整页提交已在这一层拦掉。 */
  readonly onSubmit: () => void
  readonly placeholder: string
  readonly inputLabel?: string | undefined
  readonly submitLabel?: string | undefined
  /** 输入框不可用（例如正在停止）。 */
  readonly disabled?: boolean | undefined
  /** 发送键不可用（空草稿、正在发送）。 */
  readonly submitDisabled?: boolean | undefined
  /** 药丸左端（加号）。 */
  readonly leading?: ReactNode
  /** 输入框与发送键之间（模型、档位、批准方式）。 */
  readonly trailing?: ReactNode
  /** 贴着药丸的浮层（加号面板），以表单为定位上下文。 */
  readonly overlay?: ReactNode
  readonly onKeyDownCapture?: ((event: KeyboardEvent<HTMLFormElement>) => void) | undefined
  readonly formRef?: Ref<HTMLFormElement> | undefined
  readonly inputRef?: Ref<HTMLInputElement> | undefined
  /** 有东西正在答：发送键换成停止键（点它走 onStop，不提交）。缺 onStop 时照旧画发送键。 */
  readonly running?: boolean | undefined
  readonly onStop?: (() => void) | undefined
  readonly stopLabel?: string | undefined
}

/*
 * 侧栏那颗一行高的输入药丸：辅助对话与子代理标签页共用这一份（版式、键位、发送键都一样），
 * 两端放什么由调用方决定。它只管画和收发草稿，不认识会话。
 */
export function AuxiliaryComposerBar({
  disabled,
  formRef,
  inputLabel = '输入',
  inputRef,
  leading,
  onChange,
  onKeyDownCapture,
  onStop,
  onSubmit,
  overlay,
  placeholder,
  running,
  stopLabel = '停止',
  submitDisabled,
  submitLabel = '发送',
  trailing,
  value,
}: AuxiliaryComposerBarProps) {
  const stopping = running === true && onStop !== undefined
  return (
    <div className="auxiliary-composer-pane__dock">
      <form
        className="auxiliary-composer"
        onKeyDownCapture={onKeyDownCapture}
        onSubmit={(event) => {
          event.preventDefault()
          if (submitDisabled !== true) onSubmit()
        }}
        ref={formRef}
      >
        {overlay}
        <div className="auxiliary-composer__pill" data-leading={leading === undefined ? 'none' : undefined}>
          {leading}
          <input
            aria-label={inputLabel}
            className="auxiliary-composer__field"
            disabled={disabled}
            ref={inputRef}
            onChange={(event) => {
              onChange(event.target.value)
            }}
            placeholder={placeholder}
            value={value}
          />
          {trailing}
          {stopping ? (
            /* 停止键不是提交键：type=button，回车也不会经它把表单提交出去 */
            <button
              aria-label={stopLabel}
              data-running="true"
              data-slot="prompt-input-submit"
              onClick={onStop}
              type="button"
            >
              <StopIcon aria-hidden="true" />
            </button>
          ) : (
            <button aria-label={submitLabel} data-slot="prompt-input-submit" disabled={submitDisabled} type="submit">
              <SubmitIcon aria-hidden="true" />
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
