import type { LibraryController, LibraryEntry } from '@poietica/library'
import {
  BookOpen,
  FilePlus,
  FileText,
  FolderOpen,
  FolderPlus,
  Save,
  Search,
  Trash2,
  Upload,
} from 'lucide-react'
import { useId, useState, useSyncExternalStore } from 'react'
import { MarkdownContent } from './markdown-content'
import './library-surface.css'

function LibraryDirectory({
  entries,
  parent,
  selected,
  busy,
  open,
}: {
  entries: readonly LibraryEntry[]
  parent: string
  selected: string | undefined
  busy: boolean
  open: (path: string) => void
}) {
  return (
    <>
      {entries
        .filter((entry) => entry.parent === parent)
        .map((entry) =>
          entry.folder ? (
            <details key={entry.path} open>
              <summary className="library-surface__folder">
                <FolderOpen aria-hidden="true" />
                <span>{entry.name}</span>
              </summary>
              <div className="library-surface__children">
                <LibraryDirectory
                  busy={busy}
                  entries={entries}
                  open={open}
                  parent={entry.path}
                  selected={selected}
                />
              </div>
            </details>
          ) : (
            <button
              aria-current={entry.path === selected ? 'page' : undefined}
              className="library-surface__entry"
              disabled={busy}
              key={entry.path}
              onClick={() => open(entry.path)}
              type="button"
            >
              <FileText aria-hidden="true" />
              <span>{entry.name}</span>
            </button>
          ),
        )}
    </>
  )
}

export function LibrarySurface({
  controller,
  openLink,
}: {
  controller: LibraryController
  openLink: (url: string) => void
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  const [query, setQuery] = useState('')
  const [path, setPath] = useState('')
  const [action, setAction] = useState<'create' | 'folder' | 'copy' | 'trash' | null>(null)
  const [mode, setMode] = useState<'read' | 'edit'>('read')
  const titleId = useId()
  const filenameId = useId()
  const [importFile, setImportFile] = useState<File | null>(null)
  const catalog = state.catalog
  const busy = state.busy

  async function submitAction() {
    let succeeded = false
    if (action === 'trash') {
      succeeded = await controller.trash()
    } else if (action === 'folder') {
      succeeded = await controller.folder(path)
    } else if (action === 'copy') {
      succeeded = await controller.saveCopy(path)
    } else if (action === 'create') {
      succeeded = importFile
        ? await controller.import(path, async () => {
            if (importFile.size > 16 * 1024 * 1024) {
              throw new Error('导入文件超过 16 MiB。')
            }
            return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
              await importFile.arrayBuffer(),
            )
          })
        : await controller.create(path)
    }
    if (succeeded) {
      setAction(null)
      setPath('')
      setImportFile(null)
      setMode('edit')
    }
  }

  function begin(kind: 'create' | 'folder' | 'copy' | 'trash') {
    setImportFile(null)
    setAction(kind)
    setPath('')
  }

  return (
    <section
      aria-labelledby={titleId}
      className="library-surface"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          if (!busy) {
            void controller.save()
          }
        }
        if (event.key === 'Escape' && !busy) {
          setAction(null)
          setImportFile(null)
        }
      }}
    >
      <aside aria-label="资料目录" className="library-surface__catalog">
        <header className="library-surface__brand">
          <BookOpen aria-hidden="true" />
          <h1 id={titleId}>资料库</h1>
        </header>
        <button
          className="library-surface__root"
          disabled={busy}
          onClick={() => void controller.choose()}
          type="button"
        >
          <FolderOpen aria-hidden="true" />
          <span>{catalog ? '切换资料文件夹' : '打开资料文件夹'}</span>
        </button>
        <p className="library-surface__location" title={catalog?.root}>
          {catalog?.root ?? '本地文件 · 由你掌控'}
        </p>
        <form
          className="library-surface__search"
          onSubmit={(event) => {
            event.preventDefault()
            void controller.search(query)
          }}
        >
          <input
            aria-label="搜索文件名和正文"
            disabled={!catalog}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索文件名和正文"
            type="search"
            value={query}
          />
          <button aria-label="执行搜索" disabled={!catalog || busy} title="搜索" type="submit">
            <Search aria-hidden="true" />
          </button>
        </form>
        <div className="library-surface__actions">
          <button
            disabled={!catalog || busy}
            onClick={() => begin('create')}
            title="新建资料"
            type="button"
          >
            <FilePlus aria-hidden="true" />
            新建
          </button>
          <button
            disabled={!catalog || busy}
            onClick={() => begin('folder')}
            title="新建文件夹"
            type="button"
          >
            <FolderPlus aria-hidden="true" />
            文件夹
          </button>
          <label className="library-surface__import">
            <Upload aria-hidden="true" />
            导入
            <input
              accept=".md,.markdown,.txt"
              aria-label="导入文本资料"
              disabled={!catalog || busy}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                if (file) {
                  setImportFile(file)
                  setPath(file.name)
                  setAction('create')
                }
                event.currentTarget.value = ''
              }}
              type="file"
            />
          </label>
        </div>
        <nav aria-label="本地资料" className="library-surface__entries">
          {!catalog ? (
            <p className="library-surface__hint">打开已有笔记文件夹，或选择一个空文件夹开始。</p>
          ) : null}
          {catalog?.entries.length === 0 ? (
            <p className="library-surface__hint">
              {state.query
                ? '没有匹配的资料。清空搜索后可查看全部。'
                : '这里还没有文本资料。新建或导入第一份。'}
            </p>
          ) : null}
          {catalog ? (
            state.query ? (
              catalog.entries
                .filter((entry) => !entry.folder)
                .map((entry) => (
                  <button
                    aria-current={entry.path === state.document?.path ? 'page' : undefined}
                    className="library-surface__entry"
                    disabled={busy}
                    key={entry.path}
                    onClick={() => {
                      void controller.open(entry.path).then((opened) => {
                        if (opened) {
                          setMode('read')
                        }
                      })
                    }}
                    type="button"
                  >
                    <FileText aria-hidden="true" />
                    <span>{entry.path}</span>
                  </button>
                ))
            ) : (
              <LibraryDirectory
                busy={busy}
                entries={catalog.entries}
                open={(path) => {
                  void controller.open(path).then((opened) => {
                    if (opened) {
                      setMode('read')
                    }
                  })
                }}
                parent=""
                selected={state.document?.path}
              />
            )
          ) : null}
        </nav>
        <footer className="library-surface__catalog-footer">Markdown / TXT · 原文件保存</footer>
      </aside>
      <section aria-label="资料内容" className="library-surface__reader">
        <header className="library-surface__toolbar">
          <div className="library-surface__identity">
            <FileText aria-hidden="true" />
            <strong>{state.document?.path ?? '我的资料'}</strong>
          </div>
          <div className="library-surface__actions">
            {state.document ? (
              <>
                <button
                  aria-pressed={mode === 'read'}
                  onClick={() => setMode('read')}
                  type="button"
                >
                  阅读
                </button>
                <button
                  aria-pressed={mode === 'edit'}
                  onClick={() => setMode('edit')}
                  type="button"
                >
                  编辑
                </button>
                <button
                  disabled={busy || !controller.dirty}
                  onClick={() => void controller.save()}
                  type="button"
                >
                  <Save aria-hidden="true" />
                  保存
                </button>
                <button disabled={busy} onClick={() => begin('copy')} type="button">
                  另存为
                </button>
                <button
                  aria-label="移至系统回收站"
                  disabled={busy}
                  onClick={() => begin('trash')}
                  title="移至系统回收站"
                  type="button"
                >
                  <Trash2 aria-hidden="true" />
                </button>
              </>
            ) : null}
          </div>
        </header>
        {state.failure ? (
          <div className="library-surface__error" role="alert">
            <p>{state.failure}</p>
            <button onClick={controller.clearFailure} type="button">
              关闭提示
            </button>
          </div>
        ) : null}
        {action ? (
          <form
            className="library-surface__form"
            onSubmit={(event) => {
              event.preventDefault()
              void submitAction()
            }}
          >
            {action === 'trash' ? (
              <p>
                将「{state.document?.path}」移至系统回收站？可在系统回收站恢复；保存失败时不会删除。
              </p>
            ) : (
              <>
                <label htmlFor={filenameId}>
                  {action === 'folder'
                    ? '新文件夹路径'
                    : action === 'copy'
                      ? '草稿另存路径'
                      : importFile
                        ? '导入到'
                        : '新资料路径'}
                  （相对于资料库）
                </label>
                <input
                  disabled={busy}
                  id={filenameId}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder={action === 'folder' ? '阅读笔记' : '阅读笔记/想法.md'}
                  required
                  value={path}
                />
                <p>不会覆盖同名文件。父文件夹须已存在。</p>
              </>
            )}
            <div className="library-surface__actions">
              <button disabled={busy} type="submit">
                {action === 'trash' ? '移至回收站' : '确定'}
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  setAction(null)
                  setImportFile(null)
                }}
                type="button"
              >
                取消
              </button>
            </div>
          </form>
        ) : null}
        {state.document ? (
          <div className="library-surface__content">
            {mode === 'edit' ? (
              <textarea
                aria-label="资料 Markdown 源文"
                className="library-surface__editor"
                onChange={(event) => controller.edit(event.target.value)}
                readOnly={busy}
                spellCheck={false}
                value={state.draft}
              />
            ) : (
              <article className="library-surface__document">
                <MarkdownContent content={state.draft} onOpenLink={openLink} />
              </article>
            )}
          </div>
        ) : (
          <div className="library-surface__empty">
            <BookOpen aria-hidden="true" />
            <h2>给想法一个安静的归处</h2>
            <p>一侧整理，一侧阅读。选择资料后开始编辑。</p>
          </div>
        )}
        <footer className="library-surface__status" role="status">
          {busy
            ? '正在处理…'
            : controller.dirty
              ? '有未保存更改 · Ctrl / ⌘ S 保存 · 切换文件前自动保存'
              : state.document
                ? '已保存到本地文件'
                : '选择资料文件夹后开始'}
        </footer>
      </section>
    </section>
  )
}
