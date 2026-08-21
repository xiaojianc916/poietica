import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import { hasModes, type RunMode } from '@poietica/agent'
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

/*
 * The composer input.
 *
 * 草稿的唯一真相是编辑器状态。React 这一侧只留两个投影 —— 整串正文（提交用）与
 * 插入符前那一段字（斜杠过滤用）。附件与面板开合归这里，因为它们是这张卡的一
 * 部分。
 *
 * 技能不在这里：激活它是一次协议动作，不往草稿里落字。
 */

export type { ChatStatus }

export interface PromptInputMessage {
  readonly text: string
  readonly assets: readonly ComposerAsset[]
}

const NO_ATTACHMENTS: readonly ComposerAsset[] = []
const NO_GROUPS: readonly PaletteGroup[] = []
const NO_ROWS: readonly PaletteRow[] = []

/** 这一格此刻攒着的可发内容。整串草稿不出现在这里，因为没有人需要它。 */
export interface PromptInputDraft {
  readonly hasText: boolean
  readonly hasFiles: boolean
  readonly modes: RunMode
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
  /** 插入符前那一段还没断开的字。斜杠过滤只看它，所以技能调用式不会把面板重新炸开。 */
  readonly typed: string
}

const EMPTY_PROJECTION: DraftProjection = { text: '', typed: '' }

/* 纯读：进 editorState.read，不许有副作用。 */
function readDraft(): DraftProjection {
  const selection = $getSelection()
  const text = $getRoot().getTextContent()

  if (
    !$isRangeSelection(selection) ||
    !selection.isCollapsed() ||
    selection.anchor.type !== 'text'
  ) {
    return { text, typed: '' }
  }

  const said = selection.anchor.getNode().getTextContent().slice(0, selection.anchor.offset)
  const at = said.lastIndexOf(' ')

  return { text, typed: at < 0 ? said : said.slice(at + 1) }
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

/** 吃掉插入符前那一段已经打出来的字（斜杠落定时用）。 */
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

export interface PromptInputProps {
  readonly children?: ReactNode
  readonly className?: string | undefined
  readonly ref?: Ref<PromptInputHandle> | undefined
  readonly multiple?: boolean
  readonly maxFiles?: number
  /** 面板里 agent 那几组（other 选择器、技能、命令）。「添加」组由这个框自己起头。 */
  readonly groups?: readonly PaletteGroup[] | undefined
  /** 「添加」组里跟在「添加文件」后面的行：生效模式，由拥有它们的那一层给。 */
  readonly composeRows?: readonly PaletteRow[] | undefined
  /** 这条对话此刻的模式。真相在 TranscriptStore；这里只用来判断发不发得出去。 */
  readonly modes: RunMode
  readonly onSubmit: (message: PromptInputMessage) => void
}

export function PromptInput(props: PromptInputProps) {
  const initialConfig = useMemo(
    () => ({
      namespace: 'assistant-composer',
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
  composeRows,
  groups,
  maxFiles,
  modes,
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
  const draft = useMemo<PromptInputDraft>(
    () => ({ hasText, hasFiles, modes }),
    [hasFiles, hasText, modes],
  )

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

  /* 斜杠只是给同一张面板加一道过滤：插入符前那一段以 / 开头、还没敲出空白。 */
  const slashing = /^\/\S*$/.test(draftText.typed)

  const visible = useMemo<readonly PaletteGroup[]>(() => {
    if (!slashing) {
      return allGroups
    }

    const needle = draftText.typed.toLowerCase()

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
  }, [allGroups, draftText.typed, slashing])

  const rows = useMemo(() => visible.flatMap((group) => group.rows), [visible])
  const paletteOpen = (paletteOpened || (slashing && !paletteDismissed)) && rows.length > 0
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
      const typed = slashing ? draftText.typed.length : 0

      switch (action.kind) {
        case 'run': {
          action.run()
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
            selection.insertText(`${action.snippet}`)
          })
          focusEditor()
        }
      }
    },
    [closePalette, draftText.typed.length, editor, focusEditor, slashing],
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

              if (said.length === 0 && attachments.length === 0 && !hasModes(modes)) {
                return
              }

              /* 模式不落进这段字节：它们由 TranscriptStore 在送出那一处落成文字。 */
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
  const { hasFiles, hasText, modes } = usePromptInputDraft()
  const isStreaming = status === 'streaming'
  const Icon = isStreaming ? StopIcon : status === 'submitted' ? SpinnerIcon : SubmitIcon

  return (
    <button
      {...props}
      aria-label={isStreaming ? '停止生成' : '发送'}
      className={className}
      data-slot="prompt-input-submit"
      data-status={status}
      disabled={disabled ?? (!isStreaming && !hasText && !hasFiles && !hasModes(modes))}
      onClick={isStreaming ? onCancel : undefined}
      type={isStreaming ? 'button' : 'submit'}
    >
      <Icon aria-hidden="true" />
    </button>
  )
}
