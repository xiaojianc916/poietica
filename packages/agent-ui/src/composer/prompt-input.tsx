import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import type { ChatStatus } from '@poietica/agent-contract'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  type EditorState,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
} from 'lexical'
import type { ComponentProps, KeyboardEvent, MouseEvent, ReactNode, Ref } from 'react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { cx } from '../primitives/class-names'
import { AttachIcon, SpinnerIcon, StopIcon, SubmitIcon } from '../primitives/icons'
import { type ComposerAsset, useAttachmentIntake } from './attachment-intake'
import {
  ComposerPalette,
  type PaletteGroup,
  type PaletteRow,
  paletteOptionId,
} from './composer-palette'
import { $createChipNode, ChipNode } from './prompt-chip'

/*
 * The composer input.
 *
 * 草稿的唯一真相是编辑器状态。React 这一侧只留两个投影 —— 整串正文（提交用）与
 * 插入符前那一段字（斜杠过滤用）。附件与面板开合归这里，因为它们是这张卡的一
 * 部分。
 *
 * 面板里的行有两种动作：命令落成一枚 chip，技能与模式是一次协议动作。
 */

export type { ChatStatus }

export interface PromptInputMessage {
  readonly text: string
  readonly assets: readonly ComposerAsset[]
}

const NO_ATTACHMENTS: readonly ComposerAsset[] = []
const NO_GROUPS: readonly PaletteGroup[] = []

/** 这一格此刻攒着的可发内容。整串草稿不出现在这里，因为没有人需要它。 */
export interface PromptInputDraft {
  readonly hasText: boolean
  readonly hasFiles: boolean
}

interface PromptInputActions {
  readonly setText: (text: string) => void
  readonly focusEditor: () => void
  readonly addAssets: (assets: readonly ComposerAsset[]) => void
  readonly removeAttachment: (assetToken: string) => void
  readonly openFilePicker: () => void
  readonly requestSubmit: () => void
  /** 翻开或合上加号那张面板。 */
  readonly togglePalette: () => void
  /** 在插入符处插入一段调用式或片段。 */
  readonly insertSnippet: (snippet: string) => void
}

const ActionsContext = createContext<PromptInputActions | null>(null)
const AttachmentsContext = createContext<readonly ComposerAsset[]>(NO_ATTACHMENTS)
const DraftContext = createContext<PromptInputDraft | null>(null)

/*
 * 输入框那一格的 combobox 语义（WAI-ARIA APG：带 listbox 弹层的可编辑 combobox）。
 * 焦点始终在编辑器上，活动项靠 aria-activedescendant 指过去，而只有壳知道弹层开没开、
 * 指着哪一行 —— 所以它从这里往下交，不在编辑器里再算一遍。
 */
interface PaletteAria {
  readonly listboxId: string
  readonly expanded: boolean
  readonly activeId: string | undefined
}

const PaletteAriaContext = createContext<PaletteAria | null>(null)

export function usePromptInputActions(): PromptInputActions {
  const actions = useContext(ActionsContext)

  if (!actions) {
    throw new Error('PromptInput sub-components must be rendered inside <PromptInput>.')
  }

  return actions
}

export function usePromptInputAttachments(): readonly ComposerAsset[] {
  return useContext(AttachmentsContext)
}

export function usePromptInputDraft(): PromptInputDraft {
  const draft = useContext(DraftContext)

  if (!draft) {
    throw new Error('PromptInput sub-components must be rendered inside <PromptInput>.')
  }

  return draft
}

/**
 * What the composer may be asked from outside it.
 *
 * 草稿归这张卡，所以外面写进来只能经过这条通道；焦点随文字走。
 */
export interface PromptInputHandle {
  readonly setText: (text: string) => void
  readonly insertText: (text: string) => void
  readonly focus: () => void
}

interface DraftProjection {
  readonly text: string
  /** 插入符所在那一行到插入符为止的字：调用式与它的参数都在里面。 */
  readonly line: string
}

const EMPTY_PROJECTION: DraftProjection = { text: '', line: '' }

/* 纯读：进 editorState.read，不许有副作用。 */
function readDraft(): DraftProjection {
  const selection = $getSelection()
  const text = $getRoot().getTextContent()

  if (
    !$isRangeSelection(selection) ||
    !selection.isCollapsed() ||
    selection.anchor.type !== 'text'
  ) {
    return { text, line: '' }
  }

  return {
    text,
    line: selection.anchor.getNode().getTextContent().slice(0, selection.anchor.offset),
  }
}

function clearDraft(editor: LexicalEditor): void {
  editor.update(() => {
    const root = $getRoot()

    root.clear()
    root.append($createParagraphNode())
  })
}

function replaceDraft(editor: LexicalEditor, text: string): void {
  editor.update(() => {
    const root = $getRoot()
    const paragraph = $createParagraphNode()

    root.clear()
    paragraph.append($createTextNode(text))
    root.append(paragraph)
    paragraph.selectEnd()
  })
}

/** 吃掉插入符前那一段字（斜杠落定时用）。 */
function dropTyped(length: number): void {
  if (length === 0) {
    return
  }

  const selection = $getSelection()

  if (!$isRangeSelection(selection) || selection.anchor.type !== 'text') {
    return
  }

  const node = selection.anchor.getNode()
  const offset = selection.anchor.offset

  node.spliceText(offset - length, length, '', true)
}

/*
 * 斜杠命中：命名空间先对上，名字再模糊。
 *
 * 命令的 token 是 /名字，技能的是 /skill:名字。敲 /skill 只该看见技能，而敲一个
 * 名字应该在两类里都找得到 —— 所以模糊匹配只在最后一个 : 之后的名字段上做，不跨
 * 命名空间。行没有 token 就不参与斜杠过滤。
 */
function matchesToken(row: PaletteRow, needle: string): boolean {
  const token = row.token?.toLowerCase()

  if (token === undefined) {
    return false
  }

  if (token.startsWith(needle)) {
    return true
  }

  const said = needle.slice(1)

  return (
    said.length > 0 && !said.includes(':') && token.slice(token.lastIndexOf(':') + 1).includes(said)
  )
}

/*
 * 这一行上的斜杠调用：调用式、它的参数，以及落定时要吃掉的那一整段。
 *
 * 参数是 kap 给技能激活留的那一格（Command::ActivateSkill 的 args），所以敲一个空格
 * 不该关掉面板 —— 面板只按调用式过滤。
 */
function slashOf(line: string): { line: string; token: string; args: string } | undefined {
  if (!line.startsWith('/')) {
    return undefined
  }

  const at = line.indexOf(' ')

  return at < 0
    ? { line, token: line, args: '' }
    : { line, token: line.slice(0, at), args: line.slice(at + 1) }
}

export interface PromptInputProps {
  readonly children?: ReactNode
  readonly className?: string | undefined
  readonly ref?: Ref<PromptInputHandle> | undefined
  readonly multiple?: boolean
  readonly maxFiles?: number
  /** 面板里 agent 那几组（模式、技能、命令、other 选择器）。「添加」组由这个框自己起头。 */
  readonly groups?: readonly PaletteGroup[] | undefined
  readonly onSubmit: (message: PromptInputMessage) => void
}

export function PromptInput(props: PromptInputProps) {
  const initialConfig = useMemo(
    () => ({
      namespace: 'assistant-composer',
      nodes: [ChipNode],
      onError: (error: Error) => {
        throw error
      },
      theme: {},
    }),
    [],
  )

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <PromptInputShell {...props} />
    </LexicalComposer>
  )
}

function PromptInputShell({
  children,
  className,
  groups,
  maxFiles,
  multiple = false,
  onSubmit,
  ref,
}: PromptInputProps) {
  const [editor] = useLexicalComposerContext()
  const intake = useAttachmentIntake()
  const [draftText, setDraftText] = useState(EMPTY_PROJECTION)
  const [attachments, setAttachments] = useState<readonly ComposerAsset[]>([])
  const [paletteDismissed, setPaletteDismissed] = useState(false)
  const [paletteOpened, setPaletteOpened] = useState(false)
  const [highlighted, setHighlighted] = useState(0)

  const listboxId = useId()
  const formRef = useRef<HTMLFormElement>(null)

  const focusEditor = useCallback(() => {
    editor.focus()
  }, [editor])

  /* 草稿一变，面板三态回到起点：Esc 压住的只是这一份草稿。 */
  const rewindPalette = useCallback(() => {
    setPaletteDismissed(false)
    setPaletteOpened(false)
    setHighlighted(0)
  }, [])

  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }: { editorState: EditorState }) => {
        setDraftText(editorState.read(readDraft))
      }),
    [editor],
  )

  /* Enter 发送，Shift+Enter 换行。组词期间一律不碰 —— 那是输入法在说话。 */
  useEffect(
    () =>
      editor.registerCommand<KeyboardEvent<HTMLElement> | null>(
        KEY_ENTER_COMMAND,
        (event) => {
          if (event === null || event.shiftKey || editor.isComposing()) {
            return false
          }

          event.preventDefault()
          formRef.current?.requestSubmit()

          return true
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor],
  )

  const setText = useCallback(
    (next: string) => {
      rewindPalette()
      replaceDraft(editor, next)
    },
    [editor, rewindPalette],
  )

  const insertText = useCallback(
    (incoming: string) => {
      rewindPalette()
      editor.update(() => {
        const selection = $getSelection()
        const said = $getRoot().getTextContent()

        if (!$isRangeSelection(selection)) {
          return
        }

        selection.insertText(said.trim().length === 0 ? incoming : `\n\n${incoming}`)
      })
      focusEditor()
    },
    [editor, focusEditor, rewindPalette],
  )

  useImperativeHandle(ref, () => ({ setText, insertText, focus: focusEditor }), [
    focusEditor,
    insertText,
    setText,
  ])

  const addAssets = useCallback(
    (incoming: readonly ComposerAsset[]) => {
      setAttachments((current) => {
        const next = multiple ? [...current] : []

        for (const asset of incoming) {
          if (maxFiles !== undefined && next.length >= maxFiles) {
            break
          }

          /* 身份是内容摘要：同一张图挑两次就是同一张图。 */
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

  const removeAttachment = useCallback(
    (assetToken: string) => {
      setAttachments((current) => {
        const going = current.find((attachment) => attachment.assetToken === assetToken)

        /* 移掉一张卡片就是放掉那一份字节：注册表的预算是整个进程共用的。 */
        if (going !== undefined) {
          intake?.discard(going)
        }

        return current.filter((attachment) => attachment.assetToken !== assetToken)
      })
    },
    [intake],
  )

  /* 加号走系统文件对话框：它交回路径，而路径正是原生入库要的东西。 */
  const openFilePicker = useCallback(() => {
    if (intake === null) {
      return
    }

    void intake.pick(multiple).then(addAssets, () => {
      /* 取消，或这一批一个都收不下：原因归转录，输入框只是没多出一张卡片。 */
    })
  }, [addAssets, intake, multiple])

  const togglePalette = useCallback(() => {
    setPaletteDismissed(false)
    setHighlighted(0)
    setPaletteOpened((open) => !open)
  }, [])

  const closePalette = useCallback(() => {
    setPaletteOpened(false)
    setPaletteDismissed(true)
  }, [])

  const insertSnippet = useCallback(
    (snippet: string) => {
      rewindPalette()
      editor.update(() => {
        const selection = $getSelection()

        if ($isRangeSelection(selection)) {
          selection.insertText(snippet)
        }
      })
      focusEditor()
    },
    [editor, focusEditor, rewindPalette],
  )

  const requestSubmit = useCallback(() => {
    formRef.current?.requestSubmit()
  }, [])

  /*
   * 往窗口里拖文件走原生那一条：Tauri 的 dragDropEnabled 默认接管整个 webview，
   * Windows 上 HTML5 拖放收不到事件（官方文档）。
   */
  useEffect(() => {
    if (intake === null) {
      return undefined
    }

    return intake.watchDrop(addAssets)
  }, [addAssets, intake])

  const actions = useMemo<PromptInputActions>(
    () => ({
      setText,
      focusEditor,
      addAssets,
      removeAttachment,
      openFilePicker,
      requestSubmit,
      togglePalette,
      insertSnippet,
    }),
    [
      addAssets,
      focusEditor,
      insertSnippet,
      openFilePicker,
      removeAttachment,
      requestSubmit,
      setText,
      togglePalette,
    ],
  )

  const hasText = draftText.text.trim().length > 0
  const hasFiles = attachments.length > 0
  const draft = useMemo<PromptInputDraft>(() => ({ hasText, hasFiles }), [hasFiles, hasText])

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
        ],
      },
      ...(groups ?? NO_GROUPS),
    ],
    [groups, openFilePicker],
  )

  /* 斜杠给同一张面板加一道过滤：调用式过滤行，它后面那一截是这一行的参数。 */
  const slash = useMemo(() => slashOf(draftText.line), [draftText.line])

  const visible = useMemo<readonly PaletteGroup[]>(() => {
    if (slash === undefined) {
      return allGroups
    }

    const needle = slash.token.toLowerCase()

    return allGroups
      .map((group) => ({ ...group, rows: group.rows.filter((row) => matchesToken(row, needle)) }))
      .filter((group) => group.rows.length > 0)
  }, [allGroups, slash])

  const rows = useMemo(() => visible.flatMap((group) => group.rows), [visible])
  const paletteOpen =
    (paletteOpened || (slash !== undefined && !paletteDismissed)) && rows.length > 0
  const active = paletteOpen ? rows[highlighted] : undefined

  const paletteAria = useMemo<PaletteAria>(
    () => ({
      listboxId,
      expanded: paletteOpen,
      activeId: active === undefined ? undefined : paletteOptionId(listboxId, active.id),
    }),
    [active, listboxId, paletteOpen],
  )

  const pickRow = useCallback(
    (row: PaletteRow) => {
      closePalette()

      const { action } = row
      const typed = slash?.line.length ?? 0

      switch (action.kind) {
        case 'run': {
          /* 参数就是调用式后面那一截；敲出来的那一行随动作一起消费掉。 */
          editor.update(() => {
            dropTyped(typed)
          })
          action.run(slash?.args ?? '')
          focusEditor()

          return
        }

        case 'insert': {
          editor.update(() => {
            const selection = $getSelection()

            if (!$isRangeSelection(selection)) {
              return
            }

            dropTyped(typed)

            /* 调用式落成一枚 chip：它自报文本，提交那一路一个字都不改。 */
            selection.insertNodes([$createChipNode(action.snippet), $createTextNode(' ')])
          })
          focusEditor()
        }
      }
    },
    [closePalette, editor, focusEditor, slash],
  )

  /* 点到卡外就收面板：捕获相 pointerdown，因为点不可聚焦区域不移走焦点。 */
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

  /* 面板开着时这几个键归面板。捕获相先到，编辑器因此不需要知道面板存在。 */
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

  const onFormKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'u') {
      event.preventDefault()
      openFilePicker()
    }
  }

  /* 点这张卡就是点这个框，除非点在别的控件上。 */
  const onFormMouseDown = (event: MouseEvent<HTMLFormElement>) => {
    if ((event.target as HTMLElement).closest('button, a, input, [role]')) {
      return
    }

    event.preventDefault()
    focusEditor()
  }

  return (
    <ActionsContext value={actions}>
      <AttachmentsContext value={attachments}>
        <DraftContext value={draft}>
          <form
            className={cx('assistant-prompt-input', className)}
            data-slot="prompt-input"
            onKeyDown={onFormKeyDown}
            onKeyDownCapture={onPaletteKeyDown}
            onMouseDown={onFormMouseDown}
            onPaste={(event) => {
              /* 剪贴板里的截图没有路径，所以它是唯一还经过字节的一条。 */
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
                  /* 收不下就是没多出一张卡片。 */
                },
              )
            }}
            onSubmit={(event) => {
              event.preventDefault()

              const said = draftText.text.trim()

              if (said.length === 0 && attachments.length === 0) {
                return
              }

              onSubmit({ text: said, assets: attachments })
              clearDraft(editor)
              rewindPalette()

              /* 不 discard：这些字节现在归这条对话的交付会话。 */
              setAttachments([])
            }}
            ref={formRef}
          >
            {paletteOpen ? (
              <ComposerPalette
                groups={visible}
                highlighted={highlighted}
                listboxId={listboxId}
                onHighlight={setHighlighted}
                onPick={pickRow}
              />
            ) : null}

            <PaletteAriaContext value={paletteAria}>{children}</PaletteAriaContext>
          </form>
        </DraftContext>
      </AttachmentsContext>
    </ActionsContext>
  )
}

export function PromptInputBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={className} data-slot="prompt-input-body" {...props} />
}

/**
 * 正文那一面。
 *
 * contenteditable 归 Lexical：选区、输入法组词、撤销栈与粘贴规范化都在内核里，
 * 这里只声明壳与占位字。
 */
export function PromptInputEditor({ placeholder }: { readonly placeholder: string }) {
  const palette = useContext(PaletteAriaContext)

  return (
    <div className="assistant-prompt-editor">
      <PlainTextPlugin
        contentEditable={
          <ContentEditable
            aria-activedescendant={palette?.activeId}
            aria-autocomplete="list"
            aria-controls={palette?.listboxId}
            aria-expanded={palette?.expanded}
            aria-label="消息"
            className="assistant-prompt-editor__input"
            data-slot="prompt-input-editor"
            role={palette === null ? undefined : 'combobox'}
          />
        }
        ErrorBoundary={LexicalErrorBoundary}
        placeholder={<div className="assistant-prompt-editor__placeholder">{placeholder}</div>}
      />
    </div>
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
  /* 能不能发，由持有草稿的这一侧自己答。 */
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
