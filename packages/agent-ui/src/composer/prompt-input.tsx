import type { ChatStatus } from '@poietica/agent-contract'
import type { ComponentProps, KeyboardEvent, MouseEvent, ReactNode, Ref } from 'react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { cx } from '../primitives/class-names'
import { AttachIcon, SpinnerIcon, StopIcon, SubmitIcon } from '../primitives/icons'
import { type ComposerAsset, useAttachmentIntake } from './attachment-intake'
import { ComposerPalette, type PaletteGroup, type PaletteRow } from './composer-palette'

/*
 * The composer input.
 *
 * One owner for everything the box holds. The draft text and the attachments
 * live here and nowhere else: the form reads them at submit time, the toolbar
 * reads them to decide what it may offer, and the surface reaches them through
 * the context rather than through the document. Nothing in this file, and
 * nothing built on it, looks an element up by id.
 *
 * 面板也归这里。加号翻开的与斜杠触发的是同一张，锚在这张卡的上沿；开合、高亮与
 * 落定都跟着草稿走 —— 键盘事件落在 textarea 上，面板自己听不见，所以它的状态必须
 * 与草稿同一个所有者。
 */

export type { ChatStatus }

export interface PromptInputMessage {
  readonly text: string
  readonly assets: readonly ComposerAsset[]
}

/*
 * 一类状态一条线，各订各的。
 *
 * 草稿每敲一个字符就变，而工具栏、加号、附件区没有一个真的需要那串字：它们要么
 * 只要动作，要么只要「有没有东西可发」这一个布尔。四方共用一个把 text 收进依赖的
 * useMemo，就意味着每一次按键都换掉同一个引用，整棵 composer 子树跟着 reconcile。
 *
 * 拆开之后：动作恒定，文本只有 textarea 订，附件只有附件区订，而 hasText /
 * hasFiles 只在空与非空之间翻转时换引用。从第一个字符敲到第五百个，工具栏一共
 * 醒一次。
 */
const NO_ATTACHMENTS: readonly ComposerAsset[] = []
const NO_GROUPS: readonly PaletteGroup[] = []
const NO_ROWS: readonly PaletteRow[] = []

/** 能不能发，就这两位。整串草稿不出现在这里，因为没有人需要它。 */
export interface PromptInputDraft {
  readonly hasText: boolean
  readonly hasFiles: boolean
}

const NO_DRAFT: PromptInputDraft = { hasText: false, hasFiles: false }

/*
 * 收什么，不在这一层判。
 *
 * 判据在原生：内容类型由文件头嗅出来（commands/asset.rs 的 sniff），认不出来的
 * 格式在入库那一步就停住，压根变不出一个 ComposerAsset。所以这里没有 accept ——
 * 从扩展名猜出来的 File.type 骗得过：把 .svg 改名成 .png 就行。
 */

interface PromptInputActions {
  readonly setText: (text: string) => void
  readonly focusTextarea: () => void
  readonly addAssets: (assets: readonly ComposerAsset[]) => void
  readonly removeAttachment: (assetToken: string) => void
  readonly openFilePicker: () => void
  readonly registerTextarea: (element: HTMLTextAreaElement | null) => void
  readonly requestSubmit: () => void
  /** 翻开或合上加号那张面板。 */
  readonly togglePalette: () => void
  /** 在光标处插入一段调用式或片段，保住正在打的字与选区。 */
  readonly insertSnippet: (snippet: string) => void
}

const ActionsContext = createContext<PromptInputActions | null>(null)
const TextContext = createContext<string>('')
const AttachmentsContext = createContext<readonly ComposerAsset[]>(NO_ATTACHMENTS)
const DraftContext = createContext<PromptInputDraft>(NO_DRAFT)

export function usePromptInputActions(): PromptInputActions {
  const actions = useContext(ActionsContext)

  if (!actions) {
    throw new Error('PromptInput sub-components must be rendered inside <PromptInput>.')
  }

  return actions
}

export function usePromptInputText(): string {
  return useContext(TextContext)
}

export function usePromptInputAttachments(): readonly ComposerAsset[] {
  return useContext(AttachmentsContext)
}

export function usePromptInputDraft(): PromptInputDraft {
  return useContext(DraftContext)
}

/**
 * What the composer may be asked from outside it.
 *
 * The draft is owned here, so writing a starter into it has to come in through
 * the element rather than through a second copy of the state held above it;
 * focus travels with the text, because a phrase the user is meant to finish is
 * useless in an unfocused field.
 *
 * 它就是 ref。React 19 起，函数组件的 ref 是一个普通 prop，useImperativeHandle
 * 收下它并交出这张卡 —— 不需要 forwardRef，也不需要另起一个名字。
 */
export interface PromptInputHandle {
  readonly setText: (text: string) => void
  /** 往草稿末尾追加一段（如浏览器拾取的元素块），不覆盖正在打的字。 */
  readonly insertText: (text: string) => void
  readonly focus: () => void
}

/*
 * 只声明这张卡真的兑现的那几项。
 *
 * extends Omit<ComponentProps<'form'>, …> 会让 onKeyDown / onMouseDown / onPaste
 * 出现在类型里而被实现静默丢掉：编译通过、运行无错、行为消失。类型收窄之后这条
 * 陷阱不存在。
 */
export interface PromptInputProps {
  readonly children?: ReactNode
  readonly className?: string | undefined
  readonly ref?: Ref<PromptInputHandle> | undefined
  readonly multiple?: boolean
  readonly maxFiles?: number
  /** 面板里 agent 那几组（other 选择器、技能、命令）。「添加」组由这个框自己起头。 */
  readonly groups?: readonly PaletteGroup[] | undefined
  /** 「添加」组里跟在「添加文件」后面的行：生效模式（目前是 Plan）与其他自成一行的入口。 */
  readonly composeRows?: readonly PaletteRow[] | undefined
  readonly onSubmit: (message: PromptInputMessage) => void
}

export function PromptInput({
  children,
  className,
  composeRows,
  groups,
  maxFiles,
  multiple = false,
  onSubmit,
  ref,
}: PromptInputProps) {
  const intake = useAttachmentIntake()
  const [text, setTextState] = useState('')
  const [paletteDismissed, setPaletteDismissed] = useState(false)
  const [paletteOpened, setPaletteOpened] = useState(false)
  const [highlighted, setHighlighted] = useState(0)

  /*
   * 草稿一变，面板的三样状态就回到起点：Esc 压住的只是当前这份草稿的面板，接着敲字
   * 就该重新看见它；候选换了一批之后，高亮也不该停在旧下标上；而加号翻开的那一张在
   * 人开始打字时就该让位。
   */
  const setText = useCallback((next: string) => {
    setPaletteDismissed(false)
    setPaletteOpened(false)
    setHighlighted(0)
    setTextState(next)
  }, [])
  const [attachments, setAttachments] = useState<readonly ComposerAsset[]>([])

  const formRef = useRef<HTMLFormElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const addAssets = useCallback(
    (incoming: readonly ComposerAsset[]) => {
      setAttachments((current) => {
        const next = multiple ? [...current] : []

        for (const asset of incoming) {
          if (maxFiles !== undefined && next.length >= maxFiles) {
            break
          }

          /* 身份是内容摘要，所以同一张图挑两次就是同一张图。这不是"去重"，
          这是内容寻址本来的意思 —— 两张卡片指着同一个令牌，移掉其中一张会
          把另一张的字节也放掉。 */
          if (next.some((held) => held.assetToken === asset.assetToken)) {
            continue
          }

          next.push(asset)

          if (!multiple) {
            break
          }
        }

        return next
      })
    },
    [maxFiles, multiple],
  )

  const focusTextarea = useCallback(() => {
    const editor = textareaRef.current

    if (!editor) {
      return
    }

    editor.focus()
    editor.setSelectionRange(editor.value.length, editor.value.length)
  }, [])

  /*
   * 追加而不是覆盖：拾取块落进来时，正在打的半句话不能没。空草稿整段收下，
   * 非空草稿以空行相接。面板状态的复位与 setText 同一条理由，焦点随文本走。
   */
  const insertText = useCallback(
    (incoming: string) => {
      setPaletteDismissed(false)
      setPaletteOpened(false)
      setHighlighted(0)
      setTextState((current) =>
        current.trim().length === 0 ? incoming : `${current.trimEnd()}\n\n${incoming}`,
      )
      focusTextarea()
    },
    [focusTextarea],
  )

  useImperativeHandle(ref, () => ({ setText, insertText, focus: focusTextarea }), [
    focusTextarea,
    insertText,
    setText,
  ])

  const removeAttachment = useCallback(
    (assetToken: string) => {
      setAttachments((current) => {
        const going = current.find((attachment) => attachment.assetToken === assetToken)

        /* 移掉一张卡片就是放掉那一份字节。不放，注册表会一直替一个已经不在
      屏幕上的东西占着预算，而那笔预算是整个进程共用的（MAX_REGISTRY_BYTES）。 */
        if (going !== undefined) {
          intake?.discard(going)
        }

        return current.filter((attachment) => attachment.assetToken !== assetToken)
      })
    },
    [intake],
  )

  /*
   * 加号：系统文件对话框，不是一个藏起来的 <input type="file">。
   *
   * 它交回的是路径，而路径正是原生入库要的东西（asset_import）—— 那个隐藏的
   * input 交回的是 File，于是字节必须先被读进 webview 才能过去。
   */
  const openFilePicker = useCallback(() => {
    if (intake === null) {
      return
    }

    void intake.pick(multiple).then(addAssets, () => {
      /* 用户取消，或者这一批一个都收不下。两种都不该在屏幕上炸出一句报错：
      收不下的原因（格式不对）由原生说，而它说的话属于这一句消息的转录，
      不属于输入框 —— 输入框只是没有多出一张卡片。 */
    })
  }, [addAssets, intake, multiple])

  /* 加号：开着就合上，合上就翻开。高亮回到第一行，因为看见的是一批新行。 */
  const togglePalette = useCallback(() => {
    setPaletteDismissed(false)
    setHighlighted(0)
    setPaletteOpened((open) => !open)
  }, [])

  /* 收面板的唯一出口：Esc、落定一行、点到卡外，都是这两步。 */
  const closePalette = useCallback(() => {
    setPaletteOpened(false)
    setPaletteDismissed(true)
  }, [])

  /*
   * 在光标处插入，靠平台 API 而不是手拼下标：setRangeText 归并选区替换与光标落点
   * （WHATWG HTML 标准），插完把 DOM 值收回唯一真相。没有输入框（问答面板期间）
   * 就没有插入点。
   */
  const insertSnippet = useCallback((snippet: string) => {
    const editor = textareaRef.current

    if (editor === null) {
      return
    }

    setPaletteDismissed(false)
    setPaletteOpened(false)
    setHighlighted(0)
    editor.setRangeText(snippet, editor.selectionStart, editor.selectionEnd, 'end')
    setTextState(editor.value)
    editor.focus()
  }, [])

  const registerTextarea = useCallback((element: HTMLTextAreaElement | null) => {
    textareaRef.current = element
  }, [])

  const requestSubmit = useCallback(() => {
    formRef.current?.requestSubmit()
  }, [])

  /*
   * 往窗口里拖文件。
   *
   * Tauri 的 dragDropEnabled 默认为真，原生拖放接管了整个 webview，HTML5 的那一套
   * 在 Windows 上收不到事件（官方文档：Disabling it is required to use HTML5 drag
   * and drop on the frontend on Windows）。所以听原生这一条：它给的是路径。
   */
  useEffect(() => {
    if (intake === null) {
      return undefined
    }

    return intake.watchDrop(addAssets)
  }, [addAssets, intake])

  /* 全是 useCallback 或 setState，所以这个对象建一次就到卸载。 */
  const actions = useMemo<PromptInputActions>(
    () => ({
      setText,
      focusTextarea,
      addAssets,
      removeAttachment,
      openFilePicker,
      registerTextarea,
      requestSubmit,
      togglePalette,
      insertSnippet,
    }),
    [
      addAssets,
      focusTextarea,
      insertSnippet,
      openFilePicker,
      registerTextarea,
      removeAttachment,
      requestSubmit,
      setText,
      togglePalette,
    ],
  )

  /*
   * 两个布尔，不是一串字。
   *
   * 依赖是布尔本身，所以第 2 到第 500 个字符全部落在同一个引用上 —— 订这条线
   * 的工具栏因此不会因为多敲一个字而重渲。
   */
  const hasText = text.trim().length > 0
  const hasFiles = attachments.length > 0
  const draft = useMemo<PromptInputDraft>(() => ({ hasText, hasFiles }), [hasFiles, hasText])

  /*
   * 面板的行：第一组由这个框起头，其余是 agent 报的。
   *
   * 「添加文件」不来自 agent，也不该等 agent 连上才出现 —— 它是这个框自己的能力，
   * 所以由这里补；跟在后面的 composeRows 由上游投影，这里不解释。
   */
  const allGroups = useMemo<readonly PaletteGroup[]>(
    () => [
      {
        id: 'compose',
        heading: '添加',
        rows: [
          {
            id: 'compose:file',
            icon: <AttachIcon aria-hidden="true" />,
            label: '添加文件',
            hint: 'Ctrl+U',
            action: { kind: 'run' as const, run: openFilePicker },
          },
          ...(composeRows ?? NO_ROWS),
        ],
      },
      ...(groups ?? NO_GROUPS),
    ],
    [composeRows, groups, openFilePicker],
  )

  /*
   * 斜杠不是第二张菜单，只是给同一张面板加一道过滤：正文以 / 开头、还没敲出空白。
   * 空格落下的那一刻它自然停 —— 命令敲完了，后面是参数。只有带调用式的行参与匹配，
   * 所以档位与「添加文件」不会在敲 /c 的时候跳出来。
   */
  const slashing = /^\/\S*$/.test(text)

  const visible = useMemo<readonly PaletteGroup[]>(() => {
    if (!slashing) {
      return allGroups
    }

    const needle = text.toLowerCase()

    return allGroups
      .map((group) => ({
        ...group,
        rows: group.rows.filter((row) => {
          const token = row.token?.toLowerCase()

          return (
            token !== undefined && (token.startsWith(needle) || token.includes(needle.slice(1)))
          )
        }),
      }))
      .filter((group) => group.rows.length > 0)
  }, [allGroups, slashing, text])

  const rows = useMemo(() => visible.flatMap((group) => group.rows), [visible])
  const paletteOpen = (paletteOpened || (slashing && !paletteDismissed)) && rows.length > 0

  const pickRow = useCallback(
    (row: PaletteRow) => {
      closePalette()

      if (row.action.kind === 'run') {
        row.action.run()
        focusTextarea()

        return
      }

      /* 斜杠态下整条草稿就是那个调用式，落定即替换；加号翻开时它插在光标处。 */
      if (slashing) {
        setTextState(`${row.action.snippet} `)
        focusTextarea()

        return
      }

      insertSnippet(`${row.action.snippet} `)
    },
    [closePalette, focusTextarea, insertSnippet, slashing],
  )

  /*
   * 面板开着时这几个键归面板：方向键走高亮，Enter/Tab 落定，Esc 压住。挂在捕获相：
   * textarea 的 Enter 提交挂在目标相，捕获相先到，stopPropagation 一停它就不会跑 ——
   * textarea 不需要知道面板的存在。输入法组词中的键一律不碰。
   */
  /* 点到卡外就收面板。捕获相 pointerdown 而不是 blur：Chromium/WebKit 点不可聚焦区域不移走焦点。 */
  useEffect(() => {
    if (!paletteOpen) {
      return undefined
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && formRef.current?.contains(event.target) === true) {
        return
      }

      closePalette()
    }

    document.addEventListener('pointerdown', onPointerDown, true)

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [closePalette, paletteOpen])

  const onPaletteKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (!paletteOpen || event.nativeEvent.isComposing) {
      return
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()

      const step = event.key === 'ArrowDown' ? 1 : -1

      setHighlighted((current) => (current + step + rows.length) % rows.length)

      return
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()

      const chosen = rows[highlighted] ?? rows[0]

      if (chosen !== undefined) {
        pickRow(chosen)
      }

      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closePalette()
    }
  }

  /* Scoped to the composer, so it cannot outrank the workbench command table. */
  const onFormKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'u') {
      event.preventDefault()
      openFilePicker()
    }
  }

  /* Clicking the card is clicking the field, unless something else was hit. */
  const onFormMouseDown = (event: MouseEvent<HTMLFormElement>) => {
    if ((event.target as HTMLElement).closest('button, a, input, textarea, [role]')) {
      return
    }

    event.preventDefault()
    focusTextarea()
  }

  return (
    <ActionsContext value={actions}>
      <TextContext value={text}>
        <AttachmentsContext value={attachments}>
          <DraftContext value={draft}>
            <form
              className={cx('assistant-prompt-input', className)}
              data-slot="prompt-input"
              onKeyDown={onFormKeyDown}
              onKeyDownCapture={onPaletteKeyDown}
              onMouseDown={onFormMouseDown}
              onPaste={(event) => {
                /* 三条路里唯一还经过字节的一条：剪贴板里的截图没有路径，
                系统给不出，所以它走不了按路径入库那一条。粘贴文字不该被
                这一层碰到，所以先看有没有文件。 */
                const [pasted] = Array.from(event.clipboardData.files)

                if (intake === null || pasted === undefined) {
                  return
                }

                event.preventDefault()

                void intake.paste(pasted).then(
                  (asset) => {
                    addAssets([asset])
                  },
                  () => {
                    /* 与加号同一条规矩：收不下就是没多出一张卡片。 */
                  },
                )
              }}
              onSubmit={(event) => {
                event.preventDefault()

                const trimmed = text.trim()

                if (trimmed.length === 0 && attachments.length === 0) {
                  return
                }

                /* 送出去的就是人打的那句话。档位不在这里落成文字 —— 它是 agent
                自己的状态（ACP session config option），由那一侧生效。 */
                onSubmit({ text: trimmed, assets: attachments })
                setText('')

                /* 不 discard：这些字节现在归这条对话的交付会话（原生侧 adopt
                会把引用加一），输入框只是不再拿着它们。 */
                setAttachments([])
              }}
              ref={formRef}
            >
              {paletteOpen ? (
                <ComposerPalette groups={visible} highlighted={highlighted} onPick={pickRow} />
              ) : null}

              {children}
            </form>
          </DraftContext>
        </AttachmentsContext>
      </TextContext>
    </ActionsContext>
  )
}

export function PromptInputBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={className} data-slot="prompt-input-body" {...props} />
}

export function PromptInputTextarea({
  className,
  placeholder,
  ...props
}: ComponentProps<'textarea'>) {
  const { registerTextarea, requestSubmit, setText } = usePromptInputActions()
  const text = usePromptInputText()

  /*
   * ref 只有一件事：谁持有这个元素。
   *
   * 高度归样式表（field-sizing: content），所以不再需要一层把「持有」与「量高」
   * 缝在一起的回调。registerTextarea 本身是零依赖的 useCallback，终身同一个函数，
   * React 在卸载时会用 null 再调它一次。
   */

  return (
    <textarea
      /*
       * 展开排在受控三件套之前。
       *
       * 与同文件 <form> 上那条规矩一致：调用方补充 props，但不静默顶掉这个框
       * 自己的行为。value / onChange / ref 任意一个被顶掉，草稿就有了第二个
       * 所有者，而这个文件的全部前提是「一个所有者」。
       */
      {...props}
      className={className}
      data-slot="prompt-input-textarea"
      onChange={(event) => {
        setText(event.currentTarget.value)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault()
          requestSubmit()
        }
      }}
      placeholder={placeholder}
      ref={registerTextarea}
      value={text}
    />
  )
}

export function PromptInputToolbar({ className, ...props }: ComponentProps<'div'>) {
  return <div className={className} data-slot="prompt-input-toolbar" {...props} />
}

export function PromptInputTools({ className, ...props }: ComponentProps<'div'>) {
  return <div className={className} data-slot="prompt-input-tools" {...props} />
}

export function PromptInputButton({ className, type, ...props }: ComponentProps<'button'>) {
  return (
    <button
      {...props}
      className={className}
      data-slot="prompt-input-button"
      type={type ?? 'button'}
    />
  )
}

export function PromptInputSubmit({
  className,
  disabled,
  onCancel,
  status = 'ready',
  ...props
}: Omit<ComponentProps<'button'>, 'onClick'> & {
  readonly status?: ChatStatus
  readonly onCancel?: (() => void) | undefined
}) {
  /*
   * 能不能发，由持有草稿的这一侧自己答。
   *
   * 消费点下沉到真正用它的叶子：订在工具栏那一层，「空↔非空」翻转一次就要重渲
   * 整条工具栏，而它与草稿空不空无关。disabled 仍可由外部显式压过 —— 这是
   * 「补充」，不是第二个判据。
   */
  const { hasFiles, hasText } = usePromptInputDraft()
  const isStreaming = status === 'streaming'
  const Icon = isStreaming ? StopIcon : status === 'submitted' ? SpinnerIcon : SubmitIcon

  return (
    <button
      {...props}
      aria-label={isStreaming ? '停止生成' : '发送'}
      className={className}
      data-slot="prompt-input-submit"
      data-status={status}
      disabled={disabled ?? (!isStreaming && !hasText && !hasFiles)}
      onClick={isStreaming ? onCancel : undefined}
      type={isStreaming ? 'button' : 'submit'}
    >
      <Icon aria-hidden="true" />
    </button>
  )
}
