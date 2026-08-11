import type { ChatStatus, PaletteEntry } from '@poietica/agent-contract'
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
import { SpinnerIcon, StopIcon, SubmitIcon } from '../primitives/icons'
import { type ComposerAsset, useAttachmentIntake } from './attachment-intake'
import { SlashMenu } from './slash-menu'

/*
 * The composer input.
 *
 * One owner for everything the box holds. The draft text and the attachments
 * live here and nowhere else: the form reads them at submit time, the toolbar
 * reads them to decide what it may offer, and the surface reaches them through
 * the context rather than through the document. Nothing in this file, and
 * nothing built on it, looks an element up by id.
 *
 * 弹层不在这里:加号那一侧的菜单是 composer-actions.tsx 的事,它直接用设计系统
 * 的 DropdownMenu。这个文件曾经为它包了四层只转发 props 的壳 —— 转发不是抽象,
 * 它只是让调用点多绕一层,并且逼出一段解释"为什么 onSelect 必须在类型上被拒"
 * 的长注释。壳没了,那段债也就没了。
 */

export type { ChatStatus }

export interface PromptInputMessage {
  readonly text: string
  readonly assets: readonly ComposerAsset[]
}

/*
 * 四条线，各订各的。
 *
 * 草稿每敲一个字符就变，而工具栏、加号菜单、附件区没有一个真的需要那串字：
 * 它们要么只要动作，要么只要「有没有东西可发」这一个布尔。此前四方共用一个
 * useMemo 出来的对象，而 text 在它的依赖里 —— 于是每一次按键都换掉同一个引用，
 * 整棵 composer 子树跟着 reconcile，其中包括 ComposerActions 与 SessionControls
 * 两个菜单根，以及后者每次都重跑的 [...controls].filter().sort()。
 *
 * 拆开之后：动作恒定，文本只有 textarea 订，附件只有附件区订，而 hasText /
 * hasFiles 只在空与非空之间翻转时换引用。从第一个字符敲到第五百个，工具栏一共
 * 醒一次。
 */
const NO_ATTACHMENTS: readonly ComposerAsset[] = []
const NO_SLASH_ENTRIES: readonly PaletteEntry[] = []

/** 能不能发，就这两位。整串草稿不出现在这里，因为没有人需要它。 */
export interface PromptInputDraft {
  readonly hasText: boolean
  readonly hasFiles: boolean
}

const NO_DRAFT: PromptInputDraft = { hasText: false, hasFiles: false }

/*
 * 收什么，不在这一层判。
 *
 * 判据在原生：内容类型由文件头嗅出来（commands/asset.rs 的 sniff），认不出
 * 来的格式在入库那一步就停住，压根变不出一个 ComposerAsset。所以这里没有
 * accept，也没有 accepted() —— 那个函数在的时候，「能放进框里」这件事由一个
 * 从扩展名猜出来的 File.type 说了算，而它骗得过：把 .svg 改名成 .png 就行。
 *
 * stampedName 与 pastedFiles 也一并没有了：命名归实现（剪贴板那一张由
 * desktop-adapters 给名字），而拖、粘、选三条路交出来的已经是同一种东西。
 */

interface PromptInputActions {
  readonly setText: (text: string) => void
  readonly focusTextarea: () => void
  readonly addAssets: (assets: readonly ComposerAsset[]) => void
  readonly removeAttachment: (assetToken: string) => void
  readonly openFilePicker: () => void
  readonly registerTextarea: (element: HTMLTextAreaElement | null) => void
  readonly requestSubmit: () => void
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
 *
 * 此前它叫 handle，理由写的是「调用方给的 ref 会排在展开之后静默胜出」。那个展开
 * 已经不存在（form 的 props 逐个写明，这个接口也不再 extends ComponentProps<'form'>），
 * 而 formRef 是这个组件内部的东西，与它对外收不收 ref 无关。
 */
export interface PromptInputHandle {
  readonly setText: (text: string) => void
  readonly focus: () => void
}

/*
 * 只声明这张卡真的兑现的那几项。
 *
 * 此前它 extends Omit<ComponentProps<'form'>, 'onSubmit'>，而 form 上的
 * onKeyDown / onMouseDown / onPaste 写在 {...props} 之后 —— 类型邀请调用方
 * 传，实现静默丢掉：编译通过、运行无错、行为消失。类型收窄之后这条陷阱
 * 不存在，那段解释「展开为什么排在前面」的注释也一起没了。
 */
export interface PromptInputProps {
  readonly children?: ReactNode
  readonly className?: string | undefined
  readonly ref?: Ref<PromptInputHandle> | undefined
  readonly multiple?: boolean
  readonly maxFiles?: number
  /** 斜杠菜单的候选表：agent 报来的命令表。不给就没有菜单。 */
  readonly palette?: readonly PaletteEntry[] | undefined
  readonly onSubmit: (message: PromptInputMessage) => void
}

export function PromptInput({
  children,
  className,
  maxFiles,
  multiple = false,
  onSubmit,
  palette,
  ref,
}: PromptInputProps) {
  const intake = useAttachmentIntake()
  const [text, setTextState] = useState('')
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [slashHighlighted, setSlashHighlighted] = useState(0)

  /*
   * 草稿一变，菜单的两样状态就回到起点：Esc 压住的只是当前这份草稿的菜单，接着敲字
   * 就该重新看见它；候选换了一批之后，高亮也不该停在旧下标上。
   */
  const setText = useCallback((next: string) => {
    setSlashDismissed(false)
    setSlashHighlighted(0)
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

  useImperativeHandle(ref, () => ({ setText, focus: focusTextarea }), [focusTextarea, setText])

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
   * input 交回的是 File，于是字节必须先被读进 webview 才能过去。少一个 DOM
   * 节点是顺带的，真正换掉的是这条路的形状。
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

  const registerTextarea = useCallback((element: HTMLTextAreaElement | null) => {
    textareaRef.current = element
  }, [])

  const requestSubmit = useCallback(() => {
    formRef.current?.requestSubmit()
  }, [])

  /*
   * 往窗口里拖文件。
   *
   * 这是这个程序第一次真的支持拖放。此前 form 上挂着 onDragOver / onDrop 两个
   * 处理器，而它们从落地起一行都没有执行过：Tauri 的 dragDropEnabled 默认为
   * 真，原生拖放接管了整个 webview，HTML5 的那一套在 Windows 上收不到事件
   * （官方文档：Disabling it is required to use HTML5 drag and drop on the
   * frontend on Windows）。tauri.conf.json 里没有写过这一格，所以它一直是开着的。
   *
   * 正确的做法不是把它关掉去救那两个死处理器 —— 关掉之后拿到的仍然是 File，
   * 字节还得进 webview。而是听原生这一条：它给的是路径。
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
    }),
    [
      addAssets,
      focusTextarea,
      openFilePicker,
      registerTextarea,
      removeAttachment,
      requestSubmit,
      setText,
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
   * 斜杠菜单开不开，从草稿推出来，不另记一位：正文以 / 开头、还没敲出空白、表里真有
   * 对得上的条目。空格落下的那一刻它自然关掉 —— 命令敲完了，后面是参数。
   */
  const slashEntries = useMemo(() => {
    if (palette === undefined || slashDismissed || !/^\/\S*$/.test(text)) {
      return NO_SLASH_ENTRIES
    }

    const needle = text.toLowerCase()

    return palette
      .filter(
        (entry) =>
          entry.label.toLowerCase().startsWith(needle) ||
          entry.name.toLowerCase().includes(needle.slice(1)),
      )
      .slice(0, 8)
  }, [palette, slashDismissed, text])

  const slashOpen = slashEntries.length > 0

  const pickSlash = useCallback(
    (entry: PaletteEntry) => {
      setText(`${entry.label} `)
      focusTextarea()
    },
    [focusTextarea, setText],
  )

  /*
   * 菜单开着时这几个键归菜单：方向键走高亮，Enter/Tab 落定，Esc 压住。挂在捕获相：
   * textarea 的 Enter 提交挂在目标相，捕获相先到，stopPropagation 一停它就不会跑 ——
   * textarea 不需要知道菜单的存在。输入法组词中的键一律不碰。
   */
  const onSlashKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (!slashOpen || event.nativeEvent.isComposing) {
      return
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()

      const step = event.key === 'ArrowDown' ? 1 : -1

      setSlashHighlighted((current) => (current + step + slashEntries.length) % slashEntries.length)

      return
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()

      const chosen = slashEntries[slashHighlighted] ?? slashEntries[0]

      if (chosen !== undefined) {
        pickSlash(chosen)
      }

      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setSlashDismissed(true)
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
              onKeyDownCapture={onSlashKeyDown}
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

                onSubmit({ text: trimmed, assets: attachments })
                setText('')

                /* 不 discard：这些字节现在归这条对话的交付会话（原生侧 adopt
                会把引用加一），输入框只是不再拿着它们。 */
                setAttachments([])
              }}
              ref={formRef}
            >
              {slashOpen ? (
                <SlashMenu
                  entries={slashEntries}
                  highlighted={slashHighlighted}
                  onPick={pickSlash}
                />
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

export function PromptInputTextarea({ className, ...props }: ComponentProps<'textarea'>) {
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
       * 所有者，而这个文件的全部前提是「一个所有者」；顶掉 ref 还会连带
       * registerTextarea 与 autosize 一起失效，且不报错。
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
   * 此前它是调用点算出来的一个 disabled，而调用点为此在工具栏顶上订了 draft ——
   * context 的消费者连同整棵子树一起重渲，于是「空↔非空」那一次翻转要带上
   * ComposerActions 与 SessionControls 两个菜单根，而它们与草稿空不空无关。
   * 消费点下沉到真正用它的叶子，是官方对「一处变、整棵子树醒」的标准答案。
   *
   * disabled 仍可由外部显式压过：这是「补充」，不是第二个判据。
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
