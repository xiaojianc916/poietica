import { cn, FileTypeMark, formatBytes, ViewSwitch, type ViewSwitchOption } from '@poietica/design-system'
import { computeFile, type DiffFile, paint, wholeFile } from '@poietica/design-system/diff'
import { DiffBody } from '@poietica/design-system/diff/surface'
import { isAbsoluteFilePath, Prose, type ProseFileLinks, ProseFileLinksContext } from '@poietica/design-system/prose'
import { useLayout } from '@poietica/ui-kernel'
import { Maximize, RefreshCw, Scan, TextWrap } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { type FileContent, filesErrors, workspaceFileUrl } from '../contract'
import { type FilesApi, touches } from './api'
import type { FileOpener } from './opener'
import { joinPath, parentDirectory } from './relative-path'
import type { FileDiff, FileReveal, FileTab, FileTabsStore } from './tabs'
import { IconButton, Note, Placeholder } from './tree-pane'
import './files.css'

/*
 * 右坞里开着的那个文件：只读预览。正文用审查同一份行带（DiffBody，整份文件当作一段全是上下文的改动）——
 * 行号槽、语法色、大文件虚拟化与审查、工具抽屉是同一套；Markdown 可切到正文排版（与对话同一份 Prose）；
 * 图片走资源协议（字节不进 RPC）。只读：工具条只管怎么看（Preview / Source、自动换行）与重读，不碰文件本身。
 */

/* 着色要在主线程分词：超过这个量就只画黑白，不让一次点开卡住界面。 */
const PAINT_BYTES = 512 * 1024
const PAINT_LINES = 20_000
/* 与 surface.css 的 .diff-body 行高一致（不换行时每行恰好这么高）。 */
const LINE_PX = 20
/* 跳到某一行时它上面留几行：不贴着顶边，看得见上下文。 */
const REVEAL_ABOVE = 3

const MARKDOWN = /\.(?:md|markdown|mdown|mkd)$/iu

type ViewMode = 'preview' | 'source'

/* 与技能文档面板同一组字样：两处是同一个开关。 */
const VIEW_MODES: readonly ViewSwitchOption<ViewMode>[] = [
  { value: 'preview', label: 'Preview' },
  { value: 'source', label: 'Source' },
]

export interface FileViewerPanelProps {
  readonly api: FilesApi
  readonly opener: FileOpener
  readonly tabs: FileTabsStore
}

/** 坞里画的那一块：坞此刻归属的那条对话里选中的文件。 */
export function FileViewerPanel({ api, opener, tabs }: FileViewerPanelProps): ReactNode {
  const owner = useLayout().auxiliary.owner
  const set = useSyncExternalStore(
    useCallback((listener: () => void) => tabs.subscribe(listener), [tabs]),
    () => tabs.of(owner),
  )
  const tab = set?.activeId === null || set?.activeId === undefined ? undefined : tabs.tab(set.activeId)
  if (owner === null || tab === undefined) {
    return <Placeholder title="还没有打开文件">在「文件」里点一个文件，或者点对话里提到的文件名。</Placeholder>
  }
  return (
    <FileView
      api={api}
      key={`${owner}\u0000${tab.id}`}
      opener={opener}
      owner={owner}
      reveal={tabs.revealOf(owner, tab.id)}
      tab={tab}
    />
  )
}

type Loaded =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly content: FileContent }
  | { readonly phase: 'failed'; readonly cause: unknown }

/* 读一个文件，并在它变了的时候重读（重读期间留着上一份，不闪空白）。 */
function useFileContent(
  api: Pick<FilesApi, 'read' | 'onChanged'>,
  tab: FileTab,
): { readonly loaded: Loaded; readonly reload: () => void } {
  const [loaded, setLoaded] = useState<Loaded>({ phase: 'loading' })
  const [serial, setSerial] = useState(0)
  const reload = useCallback(() => setSerial((value) => value + 1), [])

  useEffect(() => {
    const off = api.onChanged((workspaceId, paths) => {
      if (workspaceId === tab.workspaceId && touches(paths, tab.path)) reload()
    })
    return () => {
      off.dispose()
    }
  }, [api, reload, tab.path, tab.workspaceId])

  useEffect(() => {
    let live = true
    void serial
    api.read(tab.workspaceId, tab.path).then(
      (content) => {
        if (live) setLoaded({ phase: 'ready', content })
      },
      (cause: unknown) => {
        if (live) setLoaded({ phase: 'failed', cause })
      },
    )
    return () => {
      live = false
    }
  }, [api, serial, tab.path, tab.workspaceId])

  return { loaded, reload }
}

/** 一个打开着的文件：工具条 + 正文。与布局无关（归属由面板交进来），所以能脱离内核单测。 */
export function FileView({
  api,
  opener,
  owner,
  reveal,
  tab,
}: {
  readonly api: Pick<FilesApi, 'read' | 'onChanged'>
  readonly opener: FileOpener
  readonly owner: string
  readonly reveal: FileReveal | undefined
  readonly tab: FileTab
}) {
  /* 改动那一格不读磁盘：正文两半都在账本里（见 FileDiff），读回来的只会是写完之后的样子。 */
  if (tab.diff !== undefined) {
    return <DiffView diff={tab.diff} path={tab.path} />
  }
  return <ContentView api={api} opener={opener} owner={owner} reveal={reveal} tab={tab} />
}

function ContentView({
  api,
  opener,
  owner,
  reveal,
  tab,
}: {
  readonly api: Pick<FilesApi, 'read' | 'onChanged'>
  readonly opener: FileOpener
  readonly owner: string
  readonly reveal: FileReveal | undefined
  readonly tab: FileTab
}) {
  const { loaded, reload } = useFileContent(api, tab)
  const [wrap, setWrap] = useState(false)
  const markdown = MARKDOWN.test(tab.path)
  const [mode, setMode] = useState<ViewMode>(markdown ? 'preview' : 'source')
  const text = loaded.phase === 'ready' && loaded.content.kind === 'text'
  const preview = markdown && mode === 'preview'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="files-rule flex h-[var(--ui-control-height-sm)] shrink-0 items-center gap-1 px-2.5">
        <FileTypeMark name={tab.path} />
        <span className="min-w-0 flex-1 truncate text-xs opacity-70" title={tab.path}>
          {tab.path}
        </span>
        {text && !preview ? (
          <IconButton label="自动换行" onClick={() => setWrap((value) => !value)} pressed={wrap}>
            <TextWrap aria-hidden />
          </IconButton>
        ) : null}
        {markdown && text ? (
          <ViewSwitch className="mx-1" label="查看方式" onValueChange={setMode} options={VIEW_MODES} value={mode} />
        ) : null}
        <IconButton label="重新读取" onClick={reload}>
          <RefreshCw aria-hidden />
        </IconButton>
      </div>
      <Body loaded={loaded} opener={opener} owner={owner} preview={preview} reveal={reveal} tab={tab} wrap={wrap} />
    </div>
  )
}

/**
 * 一格改动：这一轮把这个文件从哪改到哪。
 *
 * 行怎么切、行号怎么编、词级强调都在 design-system/diff 里 —— 与审查面板、工具抽屉同一条管线，
 * 所以这里只负责「有哪两份正文」和那一圈工具条。
 */
function DiffView({ diff, path }: { readonly diff: FileDiff; readonly path: string }) {
  const scroller = useRef<HTMLDivElement | null>(null)
  const [wrap, setWrap] = useState(false)
  /* before 为 null = 那时这个文件还不存在（整份都是新增）；after 为 null = 这一笔把它删了。 */
  const plain = useMemo(() => computeFile(path, diff.before ?? '', diff.after ?? ''), [diff, path])
  const [file, setFile] = useState(plain)

  useEffect(() => {
    let live = true
    setFile(plain)
    const total = (diff.before?.length ?? 0) + (diff.after?.length ?? 0)
    if (total > PAINT_BYTES || plain.rows.length > PAINT_LINES) return
    /* 着色失败就当没上色：行带仍在。 */
    paint([plain]).then(
      (painted) => {
        if (live) setFile(painted[0] ?? plain)
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [diff, plain])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="files-rule flex h-[var(--ui-control-height-sm)] shrink-0 items-center gap-1 px-2.5">
        <FileTypeMark name={path} />
        <span className="min-w-0 flex-1 truncate text-xs opacity-70" title={path}>
          {path}
        </span>
        <span className="shrink-0 text-xs tabular-nums opacity-60">
          第 {diff.turn} 轮{diff.before === null ? ' · 新建' : null}
          {diff.after === null ? ' · 删除' : null}
        </span>
        <IconButton label="自动换行" onClick={() => setWrap((value) => !value)} pressed={wrap}>
          <TextWrap aria-hidden />
        </IconButton>
      </div>
      {file.rows.length === 0 ? (
        <Placeholder title="这一轮没有可对比的正文">它可能是二进制文件，或内容没有变化。</Placeholder>
      ) : (
        <section aria-label="文件改动" className="files-code-scroll min-h-0 flex-1 overflow-auto" ref={scroller}>
          <div className={wrap ? 'relative' : 'relative w-max min-w-full'}>
            <DiffBody file={file} gaps={false} scrollX={false} scroller={scroller} wrap={wrap} />
          </div>
        </section>
      )}
    </div>
  )
}

function Body({
  loaded,
  opener,
  owner,
  preview,
  reveal,
  tab,
  wrap,
}: {
  readonly loaded: Loaded
  readonly opener: FileOpener
  readonly owner: string
  readonly preview: boolean
  readonly reveal: FileReveal | undefined
  readonly tab: FileTab
  readonly wrap: boolean
}) {
  if (loaded.phase === 'loading') return <Note>正在读取…</Note>
  if (loaded.phase === 'failed') return <Failure cause={loaded.cause} />
  const { content } = loaded
  /* 文件一改地址就变（?v=修改时间）：按地址换一份组件，尺寸与「画不出来」不沿用上一张。 */
  if (content.kind === 'image') {
    return <ImageView content={content} key={content.mtimeMs} workspaceId={tab.workspaceId} />
  }
  if (content.kind === 'binary') {
    return <Placeholder title="这是一个二进制文件">{formatBytes(content.size)}，无法在这里预览。</Placeholder>
  }
  return (
    <>
      <TextNotices content={content} />
      {preview ? (
        <MarkdownView opener={opener} owner={owner} tab={tab} text={content.text} />
      ) : (
        <CodeView path={tab.path} reveal={reveal} text={content.text} wrap={wrap} />
      )}
    </>
  )
}

function Failure({ cause }: { readonly cause: unknown }) {
  const code = (cause as { code?: unknown } | null)?.code
  if (code === filesErrors.not_found) {
    return <Placeholder title="文件不存在">它可能已被删除、移动或改名。</Placeholder>
  }
  if (code === filesErrors.outside_workspace) {
    return <Placeholder title="不在工作区里">只预览当前工作区之内的文件。</Placeholder>
  }
  const message = cause instanceof Error && cause.message !== '' ? cause.message : '无法读取这个文件'
  return <Placeholder title="读不到这个文件">{message}</Placeholder>
}

/* 截断、编码猜错要明说：不能让人以为文件就这么长、或者乱码就是文件本来的样子。 */
function TextNotices({ content }: { readonly content: Extract<FileContent, { kind: 'text' }> }) {
  const notes: string[] = []
  if (content.truncated) notes.push(`文件有 ${formatBytes(content.size)}，这里只显示开头一段。`)
  if (content.encoding === 'lossy') notes.push('不是有效的 UTF-8 / UTF-16，个别字符可能显示不对。')
  if (notes.length === 0) return null
  return (
    <div className="files-rule shrink-0 px-2.5 py-1.5 text-xs opacity-60">
      {notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
    </div>
  )
}

/* 整份文件当作「全是上下文的一处改动」：行带、行号槽、虚拟化与审查是同一份。着色在主线程跑，太大就不着色。 */
function usePaintedFile(path: string, text: string): DiffFile {
  const plain = useMemo(() => wholeFile(path, text), [path, text])
  const [painted, setPainted] = useState(plain)
  useEffect(() => {
    let live = true
    setPainted(plain)
    if (text.length > PAINT_BYTES || plain.rows.length > PAINT_LINES) return
    /* 着色失败就当没上色：正文仍在。 */
    paint([plain]).then(
      (files) => {
        if (live) setPainted(files[0] ?? plain)
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [plain, text.length])
  return painted
}

function CodeView({
  path,
  reveal,
  text,
  wrap,
}: {
  readonly path: string
  readonly reveal: FileReveal | undefined
  readonly text: string
  readonly wrap: boolean
}) {
  const file = usePaintedFile(path, text)
  const scroller = useRef<HTMLDivElement | null>(null)
  const total = file.rows.length
  const line = reveal === undefined ? null : Math.min(reveal.line, total)

  /* 每次带行号打开都滚一次（每次打开 reveal 都是新的一份）：同一行再点一次也要回到那里。换行时行高不定，只能近似。 */
  useEffect(() => {
    const el = scroller.current
    if (el === null || reveal === undefined) return
    el.scrollTop = Math.max(0, (Math.min(reveal.line, total) - 1 - REVEAL_ABOVE) * LINE_PX)
  }, [reveal, total])

  return (
    <section aria-label="文件内容" className="files-code-scroll min-h-0 flex-1 overflow-auto" ref={scroller}>
      {/* 不换行时行带取最宽一行那么宽、由这里横滚；换行时必须随滚动口宽 —— max-content 的父级里行永远折不下来。 */}
      <div className={wrap ? 'relative' : 'relative w-max min-w-full'}>
        {line !== null && !wrap ? (
          <div
            aria-hidden
            className="files-line-mark pointer-events-none absolute inset-x-0"
            key={reveal?.seq}
            style={{ top: (line - 1) * LINE_PX, height: LINE_PX }}
          />
        ) : null}
        <DiffBody file={file} gaps={false} scroller={scroller} scrollX={false} wrap={wrap} />
      </div>
    </section>
  )
}

/*
 * Markdown 预览：与对话正文同一份排版。文档里的相对链接相对的是**这份文件所在的目录**（不是工作区根），
 * 所以这里接管正文的文件链接：相对的先按目录拼好，再交给同一个打开入口（Core 仍会校验它不出工作区）。
 */
function MarkdownView({
  opener,
  owner,
  tab,
  text,
}: {
  readonly opener: FileOpener
  readonly owner: string
  readonly tab: FileTab
  readonly text: string
}) {
  const links = useMemo<ProseFileLinks>(
    () => ({
      open: (ref) => {
        const path = isAbsoluteFilePath(ref.path) ? ref.path : joinPath(parentDirectory(tab.path), ref.path)
        opener.openReference({ path, line: ref.line, column: ref.column, owner, workspaceId: tab.workspaceId })
      },
    }),
    [opener, owner, tab.path, tab.workspaceId],
  )
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ProseFileLinksContext value={links}>
        <Prose className="files-markdown" mode="static" text={text} />
      </ProseFileLinksContext>
    </div>
  )
}

/* 图片：默认适应窗格，可切原始尺寸；下面一行写像素尺寸与文件大小。 */
function ImageView({
  content,
  workspaceId,
}: {
  readonly content: Extract<FileContent, { kind: 'image' }>
  readonly workspaceId: string
}) {
  const [fit, setFit] = useState(true)
  const [natural, setNatural] = useState<{ readonly width: number; readonly height: number } | null>(null)
  const [broken, setBroken] = useState(false)
  const src = workspaceFileUrl(workspaceId, content.path, content.mtimeMs)

  if (broken) {
    return <Placeholder title="这张图画不出来">文件可能已损坏，或者格式不受支持。</Placeholder>
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="files-image-stage flex min-h-0 flex-1 overflow-auto">
        <img
          alt={content.path}
          className={cn('m-auto block', fit ? 'max-h-full max-w-full object-contain' : 'max-w-none')}
          draggable={false}
          onError={() => setBroken(true)}
          onLoad={(event) => {
            setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
          }}
          src={src}
        />
      </div>
      <div className="files-rule files-rule--top flex h-[var(--ui-control-height-sm)] shrink-0 items-center gap-2 px-2.5 text-xs">
        <span className="min-w-0 flex-1 truncate opacity-60">
          {natural === null ? '' : `${String(natural.width)} × ${String(natural.height)} · `}
          {formatBytes(content.size)}
        </span>
        <IconButton label={fit ? '原始尺寸' : '适应窗格'} onClick={() => setFit((value) => !value)}>
          {fit ? <Maximize aria-hidden /> : <Scan aria-hidden />}
        </IconButton>
      </div>
    </div>
  )
}
