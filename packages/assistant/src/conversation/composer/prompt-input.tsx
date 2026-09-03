import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import type {
  ChatStatus,
  ComposerAsset,
  PromptConfiguration,
  PromptSkill,
} from '@poietica/conversation'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $nodesOfType,
  COMMAND_PRIORITY_HIGH,
  type EditorState,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
  type RangeSelection,
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
import { AttachIcon, ResumeIcon, StopIcon, SubmitIcon } from '../primitives/icons'
import { useAttachmentIntake } from './attachment-intake'
import { type ComposerDraft, useComposerDraftKey, useComposerDrafts } from './composer-drafts'
import {
  ComposerPalette,
  type PaletteGroup,
  type PaletteRow,
  paletteOptionId,
} from './composer-palette'
import { $createChipNode, ChipNode, samePromptChip } from './prompt-chip'

/*
 * The composer input.
 *
 * 草稿的唯一真相是编辑器状态。React 这一侧只留两个投影 —— 整串正文（按钮状态用）与
 * 插入符前那一段字（斜杠过滤用）。附件与面板开合归这里，因为它们是这张卡的一
 * 部分。
 *
 * 面板里的行有两种动作：命令落成一枚 chip，技能与模式是一次协议动作。
 */

export interface PromptInputMessage {
  readonly text: string
  readonly configuration: readonly PromptConfiguration[]
  readonly assets: readonly ComposerAsset[]
  readonly skills: readonly PromptSkill[]
}

const NO_ATTACHMENTS: readonly ComposerAsset[] = []
const NO_GROUPS: readonly PaletteGroup[] = []

export interface PendingPromptConfiguration extends PromptConfiguration {
  readonly label: string
}

/** 这一格此刻攒着的可发内容。 */
export interface PromptInputDraft {
  readonly hasText: boolean
  readonly hasFiles: boolean
  readonly requiresText: boolean
  readonly configuration: readonly PendingPromptConfiguration[]
}

export function canSubmitDraft(
  draft: Pick<PromptInputDraft, 'hasText' | 'hasFiles' | 'requiresText'>,
): boolean {
  return draft.requiresText ? draft.hasText : draft.hasText || draft.hasFiles
}

interface PromptInputActions {
  readonly setText: (text: string) => void
  readonly focusEditor: () => void
  readonly addAssets: (assets: readonly ComposerAsset[]) => void
  readonly removeAttachment: (assetToken: string) => void
  readonly removeConfiguration: (id: string) => void
  readonly openFilePicker: () => void
  readonly requestSubmit: () => void
  /** 翻开或合上加号那张面板。 */
  readonly togglePalette: () => void
}

const ActionsContext = createContext<PromptInputActions | null>(null)
const AttachmentsContext = createContext<readonly ComposerAsset[]>(NO_ATTACHMENTS)
const DraftContext = createContext<PromptInputDraft | null>(null)

/*
 * 输入框那一格的 combobox 语义（WAI-ARIA APG：带 listbox 弹层的可编辑 combobox）。
 * 焦点始终在编辑器上，活动项靠 aria-activedescendant 指过去，而只有壳知道弹层开没开、
 * 指着哪一行 —— 所以它从这里往下交，不在编辑器里再算一遍。
 */
export interface PaletteAria {
  readonly listboxId: string
  readonly expanded: boolean
  readonly activeId: string | undefined
}

const PaletteAriaContext = createContext<PaletteAria | null>(null)

/** 面板此刻开没开，以及它是哪一张 listbox。只有壳知道，所以只从这里读。 */
export function usePromptInputPalette(): PaletteAria | null {
  return useContext(PaletteAriaContext)
}

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
  readonly insertTextAndSubmit: (text: string) => void
  readonly focus: () => void
}

interface DraftProjection {
  readonly text: string
  readonly skills: readonly PromptSkill[]
}

const EMPTY_PROJECTION: DraftProjection = { text: '', skills: [] }

/* 纯读：进 editorState.read，不许有副作用。 */
function readDraft(): DraftProjection {
  const skills = new Map<string, PromptSkill>()
  for (const node of $nodesOfType(ChipNode)) {
    const value = node.value()
    if (value.kind === 'skill') {
      skills.set(value.name, {
        name: value.name,
        ...(value.args === undefined ? {} : { args: value.args }),
      })
    }
  }
  return { text: $getRoot().getTextContent(), skills: [...skills.values()] }
}

/* 插入点。编辑器还没被聚焦过时选区是 null（官方 Selection 文档的第四种），当场落在正文末尾。 */
function $caret(): RangeSelection {
  const selection = $getSelection()

  return $isRangeSelection(selection) ? selection : $getRoot().selectEnd()
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

/** 这一格此刻值得留住的东西；什么都没有就不留。 */
function snapshotOf(
  editor: LexicalEditor,
  assets: readonly ComposerAsset[],
  configuration: readonly PendingPromptConfiguration[],
): ComposerDraft | undefined {
  const state = editor.getEditorState()
  const written = state.read(
    () => $getRoot().getTextContent().trim().length > 0 || $nodesOfType(ChipNode).length > 0,
  )

  if (!written && assets.length === 0 && configuration.length === 0) {
    return undefined
  }

  return { assets, configuration, editorState: state.toJSON() }
}

export interface PromptInputProps {
  readonly children?: ReactNode
  readonly className?: string | undefined
  readonly ref?: Ref<PromptInputHandle> | undefined
  readonly multiple?: boolean
  readonly maxFiles?: number
  /** 面板里 agent 那几组（模式、技能、命令、other 选择器）。「添加」组由这个框自己起头。 */
  readonly groups?: readonly PaletteGroup[] | undefined
  readonly configuration?: readonly PromptConfiguration[] | undefined
  readonly onSubmit: (message: PromptInputMessage) => void
}

interface PromptInputShellProps extends PromptInputProps {
  /** 上一次离屏时留下的草稿。装回去只发生在挂载那一次。 */
  readonly restored: ComposerDraft | undefined
}

export function PromptInput(props: PromptInputProps) {
  const drafts = useComposerDrafts()
  const draftKey = useComposerDraftKey()

  /* 取回即交出所有权：从这一刻起草稿又归编辑器。 */
  const [restored] = useState(() => drafts.take(draftKey))

  const initialConfig = useMemo(
    () => ({
      /* 官方给的复原入口就是这一格（Lexical initialConfig.editorState）。 */
      ...(restored === undefined ? {} : { editorState: JSON.stringify(restored.editorState) }),
      namespace: 'assistant-composer',
      nodes: [ChipNode],
      onError: (error: Error) => {
        throw error
      },
      theme: {},
    }),
    [restored],
  )

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <PromptInputShell {...props} restored={restored} />
    </LexicalComposer>
  )
}

function PromptInputShell({
  children,
  className,
  configuration: carriedConfiguration = [],
  groups,
  maxFiles,
  multiple = false,
  onSubmit,
  ref,
  restored,
}: PromptInputShellProps) {
  const [editor] = useLexicalComposerContext()
  const intake = useAttachmentIntake()
  const drafts = useComposerDrafts()
  const draftKey = useComposerDraftKey()
  const [draftText, setDraftText] = useState(EMPTY_PROJECTION)
  const [attachments, setAttachments] = useState<readonly ComposerAsset[]>(
    restored?.assets ?? NO_ATTACHMENTS,
  )
  const [pendingConfiguration, setPendingConfiguration] = useState<
    readonly PendingPromptConfiguration[]
  >(restored?.configuration ?? [])
  const [paletteOpened, setPaletteOpened] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const handoff = useRef({ attachments, configuration: pendingConfiguration })

  handoff.current = { attachments, configuration: pendingConfiguration }

  const listboxId = useId()
  const formRef = useRef<HTMLFormElement>(null)

  const focusEditor = useCallback(() => {
    editor.focus()
  }, [editor])

  /* 草稿一变，面板三态回到起点：Esc 压住的只是这一份草稿。 */
  const rewindPalette = useCallback(() => {
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

  /* 只在卸载时转移所有权；依赖变化不能把仍在编辑器里的草稿复制到离屏册子。 */
  useEffect(
    () => () => {
      drafts.keep(
        draftKey,
        snapshotOf(editor, handoff.current.attachments, handoff.current.configuration),
      )
    },
    [draftKey, drafts, editor],
  )

  /* Enter 发送，Shift+Enter 换行。组词期间一律不碰 —— 那是输入法在说话。 */
  useEffect(
    () =>
      editor.registerCommand(
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
        const said = $getRoot().getTextContent()

        $caret().insertText(said.trim().length === 0 ? incoming : `\n\n${incoming}`)
      })
      focusEditor()
    },
    [editor, focusEditor, rewindPalette],
  )

  const insertTextAndSubmit = useCallback(
    (incoming: string) => {
      insertText(incoming)
      queueMicrotask(() => formRef.current?.requestSubmit())
    },
    [insertText],
  )

  useImperativeHandle(
    ref,
    () => ({ setText, insertText, insertTextAndSubmit, focus: focusEditor }),
    [focusEditor, insertText, insertTextAndSubmit, setText],
  )

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

  const removeConfiguration = useCallback((id: string) => {
    setPendingConfiguration((current) => current.filter((selected) => selected.id !== id))
  }, [])

  const toggleConfiguration = useCallback((selected: PendingPromptConfiguration) => {
    setPendingConfiguration((current) =>
      current.some((candidate) => candidate.id === selected.id)
        ? current.filter((candidate) => candidate.id !== selected.id)
        : [...current.filter((candidate) => candidate.id !== selected.id), selected],
    )
  }, [])

  const togglePalette = useCallback(() => {
    setHighlighted(0)
    setPaletteOpened((open) => !open)
  }, [])

  const closePalette = useCallback(() => {
    setPaletteOpened(false)
  }, [])

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
      removeConfiguration,
      openFilePicker,
      requestSubmit,
      togglePalette,
    }),
    [
      addAssets,
      focusEditor,
      openFilePicker,
      removeAttachment,
      removeConfiguration,
      requestSubmit,
      setText,
      togglePalette,
    ],
  )

  const hasText = draftText.text.trim().length > 0
  const hasFiles = attachments.length > 0
  const draft = useMemo<PromptInputDraft>(
    () => ({
      hasText,
      hasFiles,
      requiresText: pendingConfiguration.length > 0,
      configuration: pendingConfiguration,
    }),
    [hasFiles, hasText, pendingConfiguration],
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
        ],
      },
      ...(groups ?? NO_GROUPS),
    ],
    [groups, openFilePicker],
  )

  const visible = useMemo(
    () =>
      allGroups.map((group) => ({
        ...group,
        rows: group.rows.map((row) => {
          /* 收窄要落在一个 const 上才进得了 some 的闭包。 */
          const { action } = row

          return action.kind === 'configure'
            ? {
                ...row,
                checked: pendingConfiguration.some(
                  (selected) => selected.id === action.configuration.id,
                ),
              }
            : row
        }),
      })),
    [allGroups, pendingConfiguration],
  )
  const rows = useMemo(() => visible.flatMap((group) => group.rows), [visible])
  const paletteOpen = paletteOpened && rows.length > 0
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
      /* 收窄落在一个 const 上才进得了闭包，闭包里也就不必再问一次 kind。 */
      const { action } = row

      closePalette()

      if (action.kind === 'run') {
        action.run(draftText.text)
      } else if (action.kind === 'configure') {
        toggleConfiguration({ ...action.configuration, label: action.label })
      } else {
        editor.update(() => {
          const duplicate = $nodesOfType(ChipNode).some((node) =>
            samePromptChip(node.value(), action.chip),
          )

          if (!duplicate) {
            $caret().insertNodes([$createChipNode(action.chip), $createTextNode(' ')])
          }
        })
      }

      /* 三条路都以焦点回到编辑器收尾：选完接着打字。 */
      focusEditor()
    },
    [closePalette, draftText.text, editor, focusEditor, toggleConfiguration],
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

              void pasted
                .arrayBuffer()
                .then((buffer) =>
                  intake.paste({
                    bytes: new Uint8Array(buffer),
                    filename: pasted.name,
                  }),
                )
                .then(
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

              const projection = editor.getEditorState().read(readDraft)
              const said = projection.text.trim()

              if (
                !canSubmitDraft({
                  hasText: said.length > 0,
                  hasFiles: attachments.length > 0,
                  requiresText: pendingConfiguration.length > 0,
                })
              ) {
                return
              }

              const message: PromptInputMessage = {
                text: said,
                assets: attachments,
                skills: projection.skills,
                configuration: [
                  ...carriedConfiguration,
                  ...pendingConfiguration.map(({ id, value }) => ({ id, value })),
                ],
              }

              clearDraft(editor)
              handoff.current = { attachments: NO_ATTACHMENTS, configuration: [] }
              drafts.keep(draftKey, undefined)
              setPendingConfiguration([])
              rewindPalette()

              /* 不 discard：这些字节现在归这条对话的交付会话。 */
              setAttachments([])
              onSubmit(message)
            }}
            ref={formRef}
          >
            <ComposerPalette
              groups={visible}
              highlighted={highlighted}
              isOpen={paletteOpen}
              listboxId={listboxId}
              onHighlight={setHighlighted}
              onPick={pickRow}
            />

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
  const palette = usePromptInputPalette()

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
            id="prompt-message"
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

export function PromptInputSubmit({
  className,
  disabled,
  onCancel,
  onContinue,
  status = 'ready',
  ...props
}: Omit<ComponentProps<'button'>, 'onClick'> & {
  readonly status?: ChatStatus
  readonly onCancel?: (() => void) | undefined
  readonly onContinue?: (() => void) | undefined
}) {
  const draft = usePromptInputDraft()
  const cancelling = status === 'cancelling'
  const running = status === 'submitted' || status === 'streaming' || status === 'queued'
  const drafted = canSubmitDraft(draft)
  const canCancel = running && !drafted
  const canContinue = status === 'interrupted' && !drafted && onContinue !== undefined
  const Icon = canCancel || cancelling ? StopIcon : canContinue ? ResumeIcon : SubmitIcon

  return (
    <button
      {...props}
      aria-label={
        cancelling ? '正在停止' : canCancel ? '停止生成' : canContinue ? '发送“继续”' : '发送'
      }
      className={className}
      data-slot="prompt-input-submit"
      data-status={status}
      disabled={cancelling || disabled === true || (!canCancel && !canContinue && !drafted)}
      onClick={canCancel ? onCancel : canContinue ? onContinue : undefined}
      type={canCancel || canContinue ? 'button' : 'submit'}
    >
      <Icon aria-hidden="true" />
    </button>
  )
}
