import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
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
import { flushSync } from 'react-dom'
import type { ChatStatus } from '../../agent/run'
import type { PromptConfiguration, PromptSkill } from '../../agent/session'
import { type ComposerAsset, isInlineAttachment } from '../../composer/attachment'
import type { ComposerDraft } from '../../composer/drafts'
import {
  canSubmitDraft,
  type PendingPromptConfiguration,
  type PromptInputDraft,
  type PromptInputMessage,
} from '../../composer/prompt'
import { cx } from '../primitives/class-names'
import { ResumeIcon, StopIcon, SubmitIcon } from '../primitives/icons'
import {
  $createChipNode,
  ChipNode,
  type PromptChipValue,
  samePromptChip,
} from '../primitives/prompt-chip'
import { useAttachmentIntake } from './attachment-intake'
import {
  ComposerPalette,
  composerComposeGroup,
  type PaletteGroup,
  type PaletteRow,
  paletteKeyDown,
  paletteOptionId,
  useDismissOutside,
} from './composer-palette'
import { useComposerDraftKey, useComposerDrafts } from './drafts-context'

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
  /** 翻开或合上加号那张面板。 */
  readonly togglePalette: () => void
}

const ActionsContext = createContext<PromptInputActions | null>(null)
const AttachmentsContext = createContext<readonly ComposerAsset[]>(NO_ATTACHMENTS)
const DraftContext = createContext<PromptInputDraft | null>(null)

/*
 * 输入框的 combobox 语义（WAI-ARIA APG：带 listbox 弹层的 combobox）。焦点始终在编辑器上，
 * 活动项靠 aria-activedescendant 指过去；只有壳知道弹层开没开、指着哪一行，所以从这里往下交。
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
 * 草稿归这张卡，外面写进来只能经过这条通道；焦点随文字走。
 */
export interface PromptInputHandle {
  readonly setText: (text: string) => void
  readonly insertText: (text: string) => void
  readonly insertTextAndSubmit: (text: string) => void
  readonly attach: (
    assets: readonly ComposerAsset[],
    options?: { readonly text?: string; readonly submit?: boolean },
  ) => void
  readonly focus: () => void
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

/** 正文里此刻还挂着的那几枚记号，按资产 token 认。 */
function inlineTokens(projection: DraftProjection): ReadonlySet<string> {
  return new Set(projection.inline.map((chip) => chip.assetToken))
}

/* 一份附件在正文里的那枚记号。元素上下文点的是拾取到的元素，不是文件名。 */
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

/* 这一批进门之后册子里还剩哪几份：多选则并集，否则换掉整批。 */
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
  /** 这一格收不收文件。收不了就不画「添加文件」那一行：面板里不该有按不动的按钮。默认收。 */
  readonly attachments?: boolean | undefined
  /** 挂载时先写进编辑器的正文，此后不再读第二次。缺席即空草稿 —— 装回去只发生一次（离屏册子 ComposerDrafts 同规）。 */
  readonly initialText?: string | undefined
  /** 草稿正文变了。往外报一次，让不是消息框的调用方也能把它当普通字段读。 */
  readonly onChange?: ((text: string) => void) | undefined
  /** 面板里 agent 那几组（模式、技能、命令、other 选择器）。「添加」组由这个框自己起头。 */
  readonly groups?: readonly PaletteGroup[] | undefined
  readonly configuration?: readonly PromptConfiguration[] | undefined
  /** 这一句发出去做什么。缺席时是字段而非消息框：Enter 只换行，提交不存在，草稿不被消费。自动化「到期发给 agent 的指令」就是字段。 */
  readonly onSubmit?: ((message: PromptInputMessage) => void) | undefined
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
  attachments: acceptsAttachments = true,
  children,
  className,
  configuration: carriedConfiguration = [],
  groups,
  initialText,
  maxFiles,
  multiple = false,
  onChange,
  onSubmit,
  ref,
  restored,
}: PromptInputShellProps) {
  const [editor] = useLexicalComposerContext()
  const intake = useAttachmentIntake()
  const drafts = useComposerDrafts()
  const draftKey = useComposerDraftKey()
  /* 初值直接读编辑器此刻的状态：装回草稿不触发更新监听器，取空会让装回的草稿在首次编辑之前发不出去。 */
  const [draftText, setDraftText] = useState<DraftProjection>(() =>
    editor.getEditorState().read(readDraft),
  )
  const [attachments, setAttachments] = useState<readonly ComposerAsset[]>(
    restored?.assets ?? NO_ATTACHMENTS,
  )
  const [pendingConfiguration, setPendingConfiguration] = useState<
    readonly PendingPromptConfiguration[]
  >(restored?.configuration ?? [])
  const [paletteOpened, setPaletteOpened] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const handoff = useRef({ attachments, configuration: pendingConfiguration })
  /* 两条往外走的路。监听器与命令都只注册一次，回调却每次渲染都可能是新的。 */
  const report = useRef(onChange)
  const submit = useRef(onSubmit)
  const seeded = useRef(false)

  handoff.current = { attachments, configuration: pendingConfiguration }
  report.current = onChange
  submit.current = onSubmit

  const listboxId = useId()
  /*
   * 没有收信人时这层壳不是 form，是 div。
   *
   * 字段用法（自动化编辑器那一格）把它嵌在**自己的 form 里**，而 HTML 不允许 form 嵌套：
   * 浏览器会把内层丢掉、React 报「<form> cannot be a descendant of <form>」并警告 hydration
   * 会出错。这里没有提交可言（没有 onSubmit、没有发送键、Enter 只换行），所以 form 那一套
   * 语义本来就是多余的 —— 换成 div 既去掉嵌套，也不改任何行为。
   */
  /*
   * 断言成 'form' 只是为了让这一层的 props 类型保持一套（div 与 form 的联合类型
   * 在 JSX 上无法统一）。运行时那个 div 由 requestFormSubmit 的 instanceof 兜住 ——
   * 字段用法压根没有提交这条路，所以那条分支永远不会被走到。
   */
  const Shell = (onSubmit === undefined ? 'div' : 'form') as 'form'
  const formRef = useRef<HTMLFormElement>(null)
  /* Enter 与 Ctrl/Cmd+Enter 只差这一格：命令先写它，提交时读它。 */
  const queued = useRef(false)

  /*
   * 提交这一句。字段用法（不是 form）没有提交可言：那条路上这一次调用整个不存在。
   *
   * `requestSubmit` 只长在 form 上，所以这里先问壳是不是 form —— 直接调会 TypeError。
   */
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
      drafts.keep(
        draftKey,
        snapshotOf(editor, handoff.current.attachments, handoff.current.configuration),
      )
    },
    [draftKey, drafts, editor],
  )

  /* Enter 发送，Shift+Enter 换行，Ctrl/Cmd+Enter 排队（插话但不打断）。组词期间一律不碰 —— 那是输入法在说话。 */
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
      queueMicrotask(requestFormSubmit)
    },
    [insertText],
  )

  /*
   * 入册，并把该内联的几份插成正文记号。flushSync 必需：记号只能在「入册收下了哪几
   * 份」之后插，而那要等这次提交落地。判据是「收下了」而非「新来的」—— 记号被退格
   * 删掉后字节仍在册子里，按「新来的」算重挑一次就什么都不发生。
   */
  const addAssets = useCallback(
    (incoming: readonly ComposerAsset[]) => {
      flushSync(() => {
        setAttachments((current) => mergeAssets(current, incoming, multiple, maxFiles))
      })

      const held = handoff.current.attachments
      const accepted = incoming.filter((asset) =>
        held.some((keep) => keep.assetToken === asset.assetToken),
      )
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
    (
      incoming: readonly ComposerAsset[],
      options: { readonly text?: string; readonly submit?: boolean } = {},
    ) => {
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
    [addAssets, focusEditor, insertText],
  )

  useImperativeHandle(
    ref,
    () => ({ setText, insertText, insertTextAndSubmit, attach, focus: focusEditor }),
    [attach, focusEditor, insertText, insertTextAndSubmit, setText],
  )

  const removeAttachment = useCallback(
    (assetToken: string) => {
      /*
       * **释放字节这件事必须在 updater 之外做。**
       *
       * `setAttachments` 的那个函数是 React 的更新器，它必须是纯的：StrictMode 下 React
       * 会**故意调用两次**，于是 `discard` 也跑两次 —— 第二次释放的是一份已经放掉的资产，
       * 原生侧如实回 `resourceMissing`，日志里就留下一条「暂存附件未能释放」。
       *
       * 实测过：字节其实**释放成功了**（`asset_read` 从 held 变成 resourceMissing），
       * 所以那不是泄漏，而是一条**假警报** —— 而假警报会让人不再相信真警报。
       *
       * 判据读 `handoff`（那个 ref 就是「此刻册子里有哪几份」的权威）：闭包里的 `attachments`
       * 可能是旧的那一份 —— `addAssets` 用 `flushSync` 收下新的一份时，本次渲染的闭包还没有它。
       * 用旧列表的后果实测过：找不到这一份 → 不释放 → **字节真的漏了**（`asset_read` 仍是 held）。
       */
      const going = handoff.current.attachments.find(
        (attachment) => attachment.assetToken === assetToken,
      )

      /* 移掉一张卡片就是放掉那一份字节：注册表的预算是整个进程共用的。 */
      if (going !== undefined) {
        intake?.discard(going)
      }

      setAttachments((current) =>
        current.filter((attachment) => attachment.assetToken !== assetToken),
      )
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
    requestFormSubmit()
  }, [])

  /* 拖文件走原生那条：宿主（Electron）接管文件拖放，HTML5 那条在 Windows 上收不到事件。 */
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
  const hasFiles =
    attachments.some((attachment) => !isInlineAttachment(attachment)) || draftText.inline.length > 0
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
      acceptsAttachments
        ? [composerComposeGroup(openFilePicker), ...(groups ?? NO_GROUPS)]
        : (groups ?? NO_GROUPS),
    [acceptsAttachments, groups, openFilePicker],
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
        const { chip } = action

        editor.update(() => {
          $insertChip(chip)
        })
      }

      /* 三条路都以焦点回到编辑器收尾：选完接着打字。 */
      focusEditor()
    },
    [closePalette, draftText.text, editor, focusEditor, toggleConfiguration],
  )

  /* 点到卡外就收面板。 */
  useDismissOutside(paletteOpen, formRef, closePalette)

  /* 面板开着时这几个键归面板。捕获相先到，编辑器因此不需要知道面板存在。 */
  const onPaletteKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    paletteKeyDown(event, {
      highlighted,
      onClose: closePalette,
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
          <Shell
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
                  (attachment) =>
                    isInlineAttachment(attachment) && tokens.has(attachment.assetToken),
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

              /*
               * 记号被删掉的那几份先**退出正文**，字节留到这一句真的交出去之后再放。
               *
               * 从前这里在组装消息时就 discard 了 —— 那时还不知道这一句发不发得出去。
               * 发送失败时横幅只给「取回文字」，字节已经放掉、卡片也早就没了，附件救不回来。
               * 现在把顺序倒过来：先摘卡片（屏幕上不再挂着它），提交回执到达时再放字节。
               */
              const detached = attachments.filter(
                (attachment) =>
                  isInlineAttachment(attachment) && !tokens.has(attachment.assetToken),
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

              /*
               * 先把这一句交出去，再清现场。
               *
               * 顺序不能反：`submit.current` 要是抛了（这一句压根没交出去），那几份被摘下来的
               * 附件必须还在册子里，用户才能原样重发。从前 discard 排在提交之前，一次失败就
               * 连字节一起收走了 —— 而失败横幅只给「取回文字」，附件救不回来。
               */
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
              groups={visible}
              highlighted={highlighted}
              isOpen={paletteOpen}
              listboxId={listboxId}
              onHighlight={setHighlighted}
              onPick={pickRow}
            />

            <PaletteAriaContext value={paletteAria}>{children}</PaletteAriaContext>
          </Shell>
        </DraftContext>
      </AttachmentsContext>
    </ActionsContext>
  )
}

export function PromptInputBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={className} data-slot="prompt-input-body" {...props} />
}

/** 正文那一面。contenteditable 归 Lexical：选区、输入法组词、撤销栈与粘贴规范化都在内核，这里只声明壳与占位字。 */
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
