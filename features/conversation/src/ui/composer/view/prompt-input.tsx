import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import { cn } from '@poietica/design-system'
import type { SlashCommand } from '@poietica/engine'
import { invariant } from '@poietica/foundation'
import { FeatureScope, useContributions } from '@poietica/ui-kernel'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $nodesOfType,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_HIGH,
  type EditorState,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
  PASTE_COMMAND,
  type RangeSelection,
} from 'lexical'
import type { ClipboardEvent, ComponentProps, DragEvent, KeyboardEvent, MouseEvent, ReactNode, Ref } from 'react'
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
import { flushSync } from 'react-dom'
import {
  type ComposerDraft as ContributedComposerDraft,
  composerActions,
  composerInputHandlers,
  type DraftAttachment,
} from '../../../ui-api'
import { useAttachmentIntake } from '../../../ui-api/composer-assets'
import { requiresArgument, slashQueryOf } from '../../shared/model/commands'
import type { ChatStatus } from '../../shared/model/run'
import type { PromptConfiguration, PromptSkill } from '../../shared/model/session'
import { ResumeIcon, StopIcon, SubmitIcon } from '../../shared/primitives/icons'
import { $createChipNode, ChipNode, type PromptChipValue, samePromptChip } from '../../shared/primitives/prompt-chip'
import { type ComposerAsset, isInlineAttachment } from '../attachment'
import type { ComposerDraft } from '../drafts'
import { ENTRY_DRAFT_KEY, useComposerDraftKey, useComposerDrafts } from '../drafts-context'
import {
  canSubmitDraft,
  type PendingPromptConfiguration,
  type PromptInputDraft,
  type PromptInputMessage,
} from '../prompt'
import {
  ComposerPalette,
  composerComposeGroup,
  type PaletteGroup,
  type PaletteRow,
  type PaletteVia,
  paletteKeyDown,
  paletteOptionId,
  useDismissOutside,
} from './composer-palette'
import { slashPaletteGroups } from './slash-palette'

const NO_ATTACHMENTS: readonly ComposerAsset[] = []
const NO_GROUPS: readonly PaletteGroup[] = []

interface PromptInputActions {
  readonly setText: (text: string) => void
  readonly focusEditor: () => void
  readonly addAssets: (assets: readonly ComposerAsset[]) => void
  readonly removeAttachment: (assetToken: string) => void
  readonly removeConfiguration: (id: string) => void
  readonly openFilePicker: () => void
  readonly requestSubmit: () => void
  readonly togglePalette: () => void
}

const ActionsContext = createContext<PromptInputActions | null>(null)
const AttachmentsContext = createContext<readonly ComposerAsset[]>(NO_ATTACHMENTS)
const DraftContext = createContext<PromptInputDraft | null>(null)
const ContributedDraftContext = createContext<ContributedComposerDraft | null>(null)

/** sessionToken 空着：附件身份走 attachments 契约的 id。 */
function composerAssetOf(item: DraftAttachment): ComposerAsset {
  return {
    sessionToken: '',
    assetToken: item.id,
    url: item.previewUrl ?? '',
    filename: item.name,
    mediaType: item.kind === 'image' ? 'image/*' : 'application/octet-stream',
    size: 0,
    kind: item.kind,
  }
}

/* 输入框是带 listbox 弹层的 combobox（WAI-ARIA APG）：焦点留在编辑器上，活动项靠 aria-activedescendant 指过去。 */
export interface PaletteAria {
  readonly listboxId: string
  readonly expanded: boolean
  readonly activeId: string | undefined
}

const PaletteAriaContext = createContext<PaletteAria | null>(null)

export function usePromptInputPalette(): PaletteAria | null {
  return useContext(PaletteAriaContext)
}

export function usePromptInputActions(): PromptInputActions {
  const actions = useContext(ActionsContext)

  if (!actions) {
    invariant(false, 'PromptInput sub-components must be rendered inside <PromptInput>.')
  }

  return actions
}

export function usePromptInputAttachments(): readonly ComposerAsset[] {
  return useContext(AttachmentsContext)
}

export function usePromptInputDraft(): PromptInputDraft {
  const draft = useContext(DraftContext)

  if (!draft) {
    invariant(false, 'PromptInput sub-components must be rendered inside <PromptInput>.')
  }

  return draft
}

/** 必须在 FeatureScope 内渲染：useService 的访问控制按功能身份查。 */
export function ComposerContributedActions(): ReactNode {
  const contributions = useContributions(composerActions)
  const draft = useContext(ContributedDraftContext)

  if (draft === null) {
    return null
  }

  return contributions.flatMap(({ featureId, item }) => {
    const Component = item.component

    return [
      <FeatureScope featureId={featureId} key={item.id}>
        <Component draft={draft} />
      </FeatureScope>,
    ]
  })
}

/** 草稿归这张卡：外面写进来只能经过这条通道。 */
export interface PromptInputHandle {
  readonly setText: (text: string) => void
  readonly insertText: (text: string) => void
  readonly insertTextAndSubmit: (text: string) => void
  readonly attach: (
    assets: readonly ComposerAsset[],
    options?: { readonly text?: string; readonly submit?: boolean },
  ) => void
  readonly focus: () => void
  /** 撤回的那一句回来改：正文换掉草稿，附件并回去（图进托盘、文件记号落进正文），光标回输入框。 */
  readonly restore: (text: string, attachments: readonly DraftAttachment[]) => void
}

type InlineChip = Extract<PromptChipValue, { kind: 'element' | 'file' }>

interface DraftProjection {
  readonly text: string
  readonly skills: readonly PromptSkill[]
  readonly inline: readonly InlineChip[]
}

/* 纯读：进 editorState.read，不许有副作用。 */
function readDraft(): DraftProjection {
  const skills = new Map<string, PromptSkill>()
  const inline: InlineChip[] = []
  for (const node of $nodesOfType(ChipNode)) {
    const value = node.value()
    if (value.kind === 'skill') {
      skills.set(value.name, {
        name: value.name,
        ...(value.args === undefined ? {} : { args: value.args }),
      })
    } else if (value.kind === 'element' || value.kind === 'file') {
      inline.push(value)
    }
  }
  return { text: $getRoot().getTextContent(), skills: [...skills.values()], inline }
}

function inlineTokens(projection: DraftProjection): ReadonlySet<string> {
  return new Set(projection.inline.map((chip) => chip.assetToken))
}

/* 元素上下文点的是拾取到的元素，不是文件名。 */
function inlineChipOf(asset: ComposerAsset): InlineChip {
  return asset.context?.kind === 'browser-element'
    ? { kind: 'element', assetToken: asset.assetToken, label: asset.context.label }
    : { kind: 'file', assetToken: asset.assetToken, name: asset.filename }
}

/* 已经有的不再插：同一份字节落两枚记号，删掉一枚另一枚还挂着。 */
function $insertChip(value: PromptChipValue): void {
  const duplicate = $nodesOfType(ChipNode).some((node) => samePromptChip(node.value(), value))

  if (!duplicate) {
    $caret().insertNodes([$createChipNode(value), $createTextNode(' ')])
  }
}

/* 编辑器还没被聚焦过时选区是 null，插入点当场落在正文末尾。 */
function $caret(): RangeSelection {
  const selection = $getSelection()

  return $isRangeSelection(selection) ? selection : $getRoot().selectEnd()
}

/*
 * 交出正文之后清空编辑器。**必须同时清掉撤销栈**：这一步是 `editor.update()` 写进去的，
 * 装回历史之后它会成为可撤销的一步 —— 用户发送后按 Ctrl+Z 能把刚发出去的正文捞回来，
 * 那时再回车就是一次静默重发。清空历史让「发送」成为不可逆的边界。
 */
function clearDraft(editor: LexicalEditor): void {
  editor.update(() => {
    const root = $getRoot()

    root.clear()
    root.append($createParagraphNode())
  })
  editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined)
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

function snapshotOf(
  editor: LexicalEditor,
  assets: readonly ComposerAsset[],
  configuration: readonly PendingPromptConfiguration[],
): ComposerDraft | undefined {
  const state = editor.getEditorState()
  const written = state.read(() => $getRoot().getTextContent().trim().length > 0 || $nodesOfType(ChipNode).length > 0)

  if (!written && assets.length === 0 && configuration.length === 0) {
    return undefined
  }

  return { assets, configuration, editorState: state.toJSON() }
}

function mergeAssets(
  current: readonly ComposerAsset[],
  incoming: readonly ComposerAsset[],
  multiple: boolean,
  maxFiles: number | undefined,
): readonly ComposerAsset[] {
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
}

export interface PromptInputProps {
  readonly children?: ReactNode
  readonly className?: string | undefined
  readonly ref?: Ref<PromptInputHandle> | undefined
  readonly multiple?: boolean
  readonly maxFiles?: number
  readonly attachments?: boolean | undefined
  /** 只在挂载时写进编辑器一次，此后不再读；装回草稿也只发生一次。 */
  readonly initialText?: string | undefined
  readonly onChange?: ((text: string) => void) | undefined
  readonly groups?: readonly PaletteGroup[] | undefined
  /**
   * 斜杠命令：给了（且非空）草稿敲下行首 `/` 就弹命令面板，代替加号面板；回车执行走的仍是 onSubmit，
   * 收信人照常按正文认命令。缺席（自动化的输入框、提问面板）就没有这块面板，`/` 只是一个字。
   */
  readonly slashCommands?: readonly SlashCommand[] | undefined
  readonly configuration?: readonly PromptConfiguration[] | undefined
  /** 缺席时这一格是字段而非消息框：Enter 只换行、没有提交、草稿不被消费。 */
  readonly onSubmit?: ((message: PromptInputMessage) => void) | undefined
}

interface PromptInputShellProps extends PromptInputProps {
  readonly restored: ComposerDraft | undefined
  readonly draftKey: string
}

export function PromptInput(props: PromptInputProps) {
  const drafts = useComposerDrafts()
  const draftKey = useComposerDraftKey()

  /* 取回即交出所有权：此后草稿又归编辑器。 */
  const [restored] = useState(() => drafts.take(draftKey))

  const initialConfig = useMemo(
    () => ({
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
      {/* 挂在组合根而不是编辑器那一面：撤销栈属于「这个输入框」，谁用 PromptInput 都该有，与调用方传了哪些子件无关。 */}
      <HistoryPlugin />
      <PromptInputShell {...props} draftKey={draftKey} restored={restored} />
    </LexicalComposer>
  )
}

function PromptInputShell({
  attachments: acceptsAttachments = true,
  children,
  className,
  configuration: carriedConfiguration = [],
  draftKey,
  groups,
  initialText,
  maxFiles,
  multiple = false,
  onChange,
  onSubmit,
  ref,
  restored,
  slashCommands,
}: PromptInputShellProps) {
  const [editor] = useLexicalComposerContext()
  const intake = useAttachmentIntake()
  const drafts = useComposerDrafts()
  /* 初值直接读编辑器此刻的状态：装回草稿不触发更新监听器，取空会让它在首次编辑之前发不出去。 */
  const [draftText, setDraftText] = useState<DraftProjection>(() => editor.getEditorState().read(readDraft))
  const [attachments, setAttachments] = useState<readonly ComposerAsset[]>(restored?.assets ?? NO_ATTACHMENTS)
  const [pendingConfiguration, setPendingConfiguration] = useState<readonly PendingPromptConfiguration[]>(
    restored?.configuration ?? [],
  )
  const [paletteOpened, setPaletteOpened] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  /* 斜杠面板被 Esc、点到框外或点加号压住了：压到草稿离开「行首 `/` 加名字」的样子、再进来为止 */
  const [slashMuted, setSlashMuted] = useState(false)
  const handoff = useRef({ attachments, configuration: pendingConfiguration })
  /* 监听器与命令只注册一次，回调却每次渲染都可能是新的。 */
  const report = useRef(onChange)
  const submit = useRef(onSubmit)
  const seeded = useRef(false)

  handoff.current = { attachments, configuration: pendingConfiguration }
  report.current = onChange
  submit.current = onSubmit

  const listboxId = useId()
  /* HTML 不允许 form 嵌套（React 报 <form> cannot be a descendant of <form>），没有 onSubmit 时也没有提交语义，所以换成 div；
     断言成 'form' 只让 props 类型保持一套，运行时那个 div 由 instanceof 兜住。 */
  const Shell = (onSubmit === undefined ? 'div' : 'form') as 'form'
  const formRef = useRef<HTMLFormElement>(null)
  const queued = useRef(false)

  /* `requestSubmit` 只长在 form 上，直接调会 TypeError，先问壳是不是 form。 */
  const requestFormSubmit = useCallback(() => {
    const shell = formRef.current

    if (shell instanceof HTMLFormElement) {
      shell.requestSubmit()
    }
  }, [])

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
        const projection = editorState.read(readDraft)

        setDraftText(projection)
        report.current?.(projection.text)
      }),
    [editor],
  )

  /* 起始正文只在挂载那一次写进去；册子里已经装着的那一份优先，它比记录新。 */
  useEffect(() => {
    if (seeded.current) {
      return
    }

    seeded.current = true

    if (initialText === undefined || initialText === '' || restored !== undefined) {
      return
    }

    replaceDraft(editor, initialText)
  }, [editor, initialText, restored])

  /* 只在卸载时转移所有权；依赖变化不能把仍在编辑器里的草稿复制到离屏册子。 */
  useEffect(
    () => () => {
      drafts.keep(draftKey, snapshotOf(editor, handoff.current.attachments, handoff.current.configuration))
    },
    [draftKey, drafts, editor],
  )

  /* Enter 发送，Shift+Enter 换行，Ctrl/Cmd+Enter 排队（插话但不打断）；组词期间一律不碰。 */
  useEffect(
    () =>
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          /* 没有收信人时 Enter 就是换行：字段不是消息框。 */
          if (submit.current === undefined || event === null || event.shiftKey) {
            return false
          }

          if (editor.isComposing()) {
            return false
          }

          event.preventDefault()
          queued.current = event.ctrlKey || event.metaKey
          requestFormSubmit()

          return true
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor, requestFormSubmit],
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
      queueMicrotask(requestFormSubmit)
    },
    [insertText, requestFormSubmit],
  )

  /* `flushSync` 必需（等这次提交落地才知道册子收下了哪几份），判据是「收下了」而非「新来的」：
     记号被退格删掉后字节仍在册子里，按「新来的」算，重挑一次就什么都不发生。 */
  const addAssets = useCallback(
    (incoming: readonly ComposerAsset[]) => {
      flushSync(() => {
        setAttachments((current) => mergeAssets(current, incoming, multiple, maxFiles))
      })

      const held = handoff.current.attachments
      const accepted = incoming.filter((asset) => held.some((keep) => keep.assetToken === asset.assetToken))
      const chips = accepted.filter(isInlineAttachment).map(inlineChipOf)

      if (chips.length > 0) {
        editor.update(() => {
          for (const chip of chips) {
            $insertChip(chip)
          }
        })
      }
    },
    [editor, maxFiles, multiple],
  )

  const attach = useCallback(
    (incoming: readonly ComposerAsset[], options: { readonly text?: string; readonly submit?: boolean } = {}) => {
      addAssets(incoming)

      const text = options.text?.trim() ?? ''
      if (text === '') {
        focusEditor()
      } else {
        insertText(text)
      }

      if (options.submit === true) {
        requestFormSubmit()
      }
    },
    [addAssets, focusEditor, insertText, requestFormSubmit],
  )

  /* 先换正文再并附件：文件记号是插进正文里的，反过来做，换正文那一下会把刚插的记号一起冲掉。 */
  const restore = useCallback(
    (text: string, restored: readonly DraftAttachment[]) => {
      setText(text)
      if (restored.length > 0) {
        addAssets(restored.map(composerAssetOf))
      }
      focusEditor()
    },
    [addAssets, focusEditor, setText],
  )

  useImperativeHandle(ref, () => ({ setText, insertText, insertTextAndSubmit, attach, focus: focusEditor, restore }), [
    attach,
    focusEditor,
    insertText,
    insertTextAndSubmit,
    restore,
    setText,
  ])

  const removeAttachment = useCallback(
    (assetToken: string) => {
      /* **释放字节必须在 updater 之外做**：`setAttachments` 的函数是纯更新器，StrictMode 下 React 会故意调用两次，
         第二次释放一份已放掉的资产，日志里留下「暂存附件未能释放」—— 实测字节其实释放成功了，是假警报。
         判据读 `handoff`：闭包里的 `attachments` 可能是旧的，用旧列表实测漏过字节。 */
      const going = handoff.current.attachments.find((attachment) => attachment.assetToken === assetToken)

      /* 移掉一张卡片就是放掉那一份字节：注册表的预算是全进程共用的。 */
      if (going !== undefined) {
        intake?.discard(going)
      }

      setAttachments((current) => current.filter((attachment) => attachment.assetToken !== assetToken))
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

  /* 点加号就是要加号面板：斜杠面板开着也让位。 */
  const togglePalette = useCallback(() => {
    setHighlighted(0)
    setSlashMuted(true)
    setPaletteOpened((open) => !open)
  }, [])

  const closePalette = useCallback(() => {
    setPaletteOpened(false)
  }, [])

  const requestSubmit = useCallback(() => {
    requestFormSubmit()
  }, [requestFormSubmit])

  /* 就是壳里这一份正在编辑的草稿：加附件、写正文、提交都落在与手打一句话同一条路上。 */
  const contributedDraft = useMemo<ContributedComposerDraft>(
    () => ({
      threadId: draftKey === ENTRY_DRAFT_KEY ? null : draftKey,
      addAttachments: (items: readonly DraftAttachment[]) => {
        addAssets(items.map(composerAssetOf))
      },
      insertText,
      submit: requestFormSubmit,
    }),
    [addAssets, draftKey, insertText, requestFormSubmit],
  )

  /* 贡献的输入处理器：粘贴与拖放各走一遍，谁先吃掉谁负责 —— 返回 true 就跳过内置那条路。 */
  const inputHandlers = useContributions(composerInputHandlers)

  /*
   * 粘贴的「认领」必须发生在 Lexical 把文字插进 DOM 之前：它在自己的 paste 监听里无条件插入，
   * React 的 onPaste 到时已经晚了。所以挂在 PASTE_COMMAND 上 —— 认领了就 preventDefault 并返回 true，
   * 默认插入整条不发生；异步那半段交给贡献者（例如超长文字收成一份文件）。
   */
  const pasteHandlers = useRef(inputHandlers)
  const pasteDraft = useRef(contributedDraft)
  pasteHandlers.current = inputHandlers
  pasteDraft.current = contributedDraft

  useEffect(
    () =>
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          /* React 的 ClipboardEvent 与 DOM 的同名不同型，贡献者收的是原生那一个。 */
          const native = event as unknown as globalThis.ClipboardEvent
          const claimed = pasteHandlers.current.filter(
            ({ item }) => item.onPaste !== undefined && item.claims?.(native) === true,
          )

          if (claimed.length === 0) {
            return false
          }

          const pasteDefault = (): void => {
            /* 认领了却没接住：照默认贴回去，不能吞掉用户这一次粘贴。 */
            const text = native.clipboardData?.getData('text/plain') ?? ''

            if (text.length > 0) {
              editor.update(() => {
                $caret().insertText(text)
              })
            }
          }

          native.preventDefault()
          void (async () => {
            for (const { item } of claimed) {
              if (await item.onPaste?.(native, pasteDraft.current)) {
                return
              }
            }
            pasteDefault()
          })().catch(pasteDefault)

          return true
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor],
  )

  const handleContributedPaste = useCallback(
    async (event: ClipboardEvent<HTMLFormElement>): Promise<boolean> => {
      for (const { item } of inputHandlers) {
        if (item.onPaste === undefined) {
          continue
        }
        if (await item.onPaste(event.nativeEvent, contributedDraft)) {
          return true
        }
      }
      return false
    },
    [contributedDraft, inputHandlers],
  )

  const handleContributedDrop = useCallback(
    async (event: DragEvent<HTMLFormElement>): Promise<boolean> => {
      for (const { item } of inputHandlers) {
        if (item.onDrop === undefined) {
          continue
        }
        if (await item.onDrop(event.nativeEvent, contributedDraft)) {
          return true
        }
      }
      return false
    },
    [contributedDraft, inputHandlers],
  )

  /* 拖文件走原生：HTML5 那条在 Windows 上收不到事件。 */
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
  /* 留在册子里的（图片）只要在册就算数；内联的那些由正文里那枚记号说了算。 */
  const hasFiles = attachments.some((attachment) => !isInlineAttachment(attachment)) || draftText.inline.length > 0
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
    () =>
      acceptsAttachments ? [composerComposeGroup(openFilePicker), ...(groups ?? NO_GROUPS)] : (groups ?? NO_GROUPS),
    [acceptsAttachments, groups, openFilePicker],
  )

  const visible = useMemo(
    () =>
      allGroups.map((group) => ({
        ...group,
        rows: group.rows.map((row) => {
          const { action } = row

          return action.kind === 'configure'
            ? {
                ...row,
                checked: pendingConfiguration.some((selected) => selected.id === action.configuration.id),
              }
            : row
        }),
      })),
    [allGroups, pendingConfiguration],
  )
  /*
   * 斜杠命令面板：草稿就是行首 `/` 加一截名字时出来，代替加号面板。名字一变高亮回到第一行；
   * 刚敲下 `/` 那一刻加号面板收起，免得删掉斜杠时它又冒出来。
   */
  const slashQuery = slashCommands === undefined || slashCommands.length === 0 ? null : slashQueryOf(draftText.text)
  const [slashSeen, setSlashSeen] = useState<string | null>(null)
  if (slashSeen !== slashQuery) {
    setSlashSeen(slashQuery)
    setHighlighted(0)
    /* 进入斜杠样子的那一刻：之前的「压住」作废，加号面板让位 */
    if (slashSeen === null) {
      setSlashMuted(false)
      setPaletteOpened(false)
    }
  }
  const slashGroups = useMemo(
    () =>
      slashCommands === undefined || slashQuery === null ? NO_GROUPS : slashPaletteGroups(slashCommands, slashQuery),
    [slashCommands, slashQuery],
  )
  const slashOpen = !slashMuted && slashGroups.length > 0
  const shownGroups = slashOpen ? slashGroups : visible
  const rows = useMemo(() => shownGroups.flatMap((group) => group.rows), [shownGroups])
  const paletteOpen = slashOpen || (paletteOpened && rows.length > 0)
  /* 面板退场的那几十毫秒里还画着：内容要停在收起前那一份，不然斜杠面板一收，退场的那一帧会闪成加号面板 */
  const lastShown = useRef(shownGroups)
  if (paletteOpen) {
    lastShown.current = shownGroups
  }
  const paletteGroups = paletteOpen ? shownGroups : lastShown.current
  const active = paletteOpen ? rows[highlighted] : undefined

  const paletteAria = useMemo<PaletteAria>(
    () => ({
      listboxId,
      expanded: paletteOpen,
      activeId: active === undefined ? undefined : paletteOptionId(listboxId, active.id),
    }),
    [active, listboxId, paletteOpen],
  )

  /*
   * 选中一条命令：Tab 与带必填参数的命令只补全名字（留一个空格接着写参数）；其余就是执行 ——
   * 放回 `/名字` 再走表单提交，与手打 `/compact` 回车同一条路，收信人那边不必知道面板存在。
   */
  const pickCommand = useCallback(
    (command: SlashCommand, via: PaletteVia) => {
      const name = `/${command.name}`

      if (via === 'tab' || requiresArgument(command)) {
        setText(`${name} `)

        return
      }

      setText(name)
      queueMicrotask(requestFormSubmit)
    },
    [requestFormSubmit, setText],
  )

  const pickRow = useCallback(
    (row: PaletteRow, via: PaletteVia) => {
      const { action } = row

      closePalette()

      if (action.kind === 'command') {
        pickCommand(action.command, via)
      } else if (action.kind === 'run') {
        action.run(draftText.text)
      } else if (action.kind === 'configure') {
        toggleConfiguration({ ...action.configuration, label: action.label })
      } else {
        const { chip } = action

        editor.update(() => {
          $insertChip(chip)
        })
      }

      focusEditor()
    },
    [closePalette, draftText.text, editor, focusEditor, pickCommand, toggleConfiguration],
  )

  const muteSlash = useCallback(() => {
    setSlashMuted(true)
  }, [])
  const dismissPalette = slashOpen ? muteSlash : closePalette

  useDismissOutside(paletteOpen, formRef, dismissPalette)

  /* 面板开着时这几个键归面板，捕获相先到，编辑器因此不需要知道面板存在。 */
  const onPaletteKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    paletteKeyDown(event, {
      highlighted,
      onClose: dismissPalette,
      onHighlight: setHighlighted,
      onPick: pickRow,
      open: paletteOpen,
      rows,
      stopPropagation: true,
    })
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
          <ContributedDraftContext value={contributedDraft}>
            <Shell
              className={cn('assistant-prompt-input', className)}
              data-slot="prompt-input"
              onDragOver={(event) => {
                /* 有贡献者接拖放时才允许落下；否则浏览器按默认处理（打开文件）。 */
                const droppable = inputHandlers.some(({ item }) => item.onDrop !== undefined)

                if (droppable) {
                  event.preventDefault()
                }
              }}
              onDrop={(event) => {
                /* 落下必须先同步 preventDefault —— 异步回调里再补就晚了（默认动作早已发生）；只在真的有人接拖放时才拦。 */
                if (inputHandlers.some(({ item }) => item.onDrop !== undefined)) {
                  event.preventDefault()
                  void handleContributedDrop(event)
                }
              }}
              onKeyDown={onFormKeyDown}
              onKeyDownCapture={onPaletteKeyDown}
              onMouseDown={onFormMouseDown}
              onPaste={(event) => {
                /* 只在剪贴板里真的有文件时拦：纯文本粘贴是编辑器的默认动作，拦下来等于把人打的一句话吃掉。
                   preventDefault 必须同步 —— 异步回调里再补就晚了。 */
                const carriesFiles = event.clipboardData.files.length > 0

                if (carriesFiles && inputHandlers.some(({ item }) => item.onPaste !== undefined)) {
                  event.preventDefault()
                  void handleContributedPaste(event)
                  return
                }

                /* 截图没有路径，所以它是唯一还经过字节的一条。 */
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
                      mime: pasted.type === '' ? 'image/png' : pasted.type,
                    }),
                  )
                  .then(
                    (asset) => {
                      addAssets([asset])
                    },
                    () => {
                      /* 收不下就是没多出一张卡片，不打扰用户。 */
                    },
                  )
              }}
              onSubmit={(event) => {
                event.preventDefault()

                /* 字段没有收信人：这一条路整条不存在，草稿也不许被消费掉。 */
                if (submit.current === undefined) {
                  return
                }

                const projection = editor.getEditorState().read(readDraft)
                const said = projection.text.trim()

                /* 内联的几份以正文记号为准：记号已删的就地放掉不随行；留在册子里的（图片）照旧全发。 */
                const tokens = inlineTokens(projection)
                const assets = [
                  ...attachments.filter((attachment) => !isInlineAttachment(attachment)),
                  ...attachments.filter(
                    (attachment) => isInlineAttachment(attachment) && tokens.has(attachment.assetToken),
                  ),
                ]

                if (
                  !canSubmitDraft({
                    hasText: said.length > 0,
                    hasFiles: assets.length > 0,
                    requiresText: pendingConfiguration.length > 0,
                  })
                ) {
                  return
                }

                /* 记号被删掉的那几份先**退出正文**：屏幕上不再挂着它，字节留到这一句真的交出去之后再放。 */
                const detached = attachments.filter(
                  (attachment) => isInlineAttachment(attachment) && !tokens.has(attachment.assetToken),
                )

                const message: PromptInputMessage = {
                  text: said,
                  assets,
                  skills: projection.skills,
                  configuration: [
                    ...carriedConfiguration,
                    ...pendingConfiguration.map(({ id, value }) => ({ id, value })),
                  ],
                  ...(queued.current ? { queued: true } : {}),
                }
                queued.current = false

                /* 顺序不能反：`submit.current` 要是抛了，那几份被摘下来的附件必须还在册子里，用户才能原样重发
                   —— 失败横幅只给「取回文字」，附件救不回来。 */
                const handedOver = ((): boolean => {
                  try {
                    submit.current(message)

                    return true
                  } catch (cause) {
                    /* 留在册子里等下一次：正文与附件一起还给用户。 */
                    setAttachments((current) => [...current, ...detached])
                    setText(said)

                    throw cause
                  }
                })()

                if (!handedOver) {
                  return
                }

                /* 交出去了：正文、草稿与附件一起让位（不 discard —— 那些字节已随准入交给这条对话）。 */
                clearDraft(editor)
                handoff.current = { attachments: NO_ATTACHMENTS, configuration: [] }
                drafts.keep(draftKey, undefined)
                setPendingConfiguration([])
                rewindPalette()
                setAttachments([])

                if (intake !== null) {
                  for (const attachment of detached) {
                    intake.discard(attachment)
                  }
                }
              }}
              ref={formRef}
            >
              <ComposerPalette
                groups={paletteGroups}
                highlighted={highlighted}
                isOpen={paletteOpen}
                listboxId={listboxId}
                onHighlight={setHighlighted}
                onPick={pickRow}
              />

              <PaletteAriaContext value={paletteAria}>{children}</PaletteAriaContext>
            </Shell>
          </ContributedDraftContext>
        </DraftContext>
      </AttachmentsContext>
    </ActionsContext>
  )
}

export function PromptInputBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={className} data-slot="prompt-input-body" {...props} />
}

/**
 * 正文那一面。contenteditable 归 Lexical：选区、组词、粘贴规范化都在内核，这里只声明壳与占位字。
 * 撤销栈不在这里挂 —— 它由 `PromptInput` 根上的 `HistoryPlugin` 提供（见那里的说明）。
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
      aria-label={cancelling ? '正在停止' : canCancel ? '停止生成' : canContinue ? '发送“继续”' : '发送'}
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
