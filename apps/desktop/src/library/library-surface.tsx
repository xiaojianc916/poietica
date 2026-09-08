import { BookOpen, ChevronRight, FileText, Folder, Search } from 'lucide-react'
import { useId, useState } from 'react'
import './library-surface.css'

// Presentation examples, not a local file index or persisted documents.
const EXAMPLES = [
  {
    id: 'welcome',
    title: '欢迎使用资料库',
    description: '给想法和成果，一个安静的归处。',
    sections: [
      {
        title: '从一份资料开始',
        body: '项目笔记、阅读摘录、灵感片段，都可以在这里拥有清晰的位置。左侧浏览目录，右侧专注阅读，让寻找和思考保持连贯。',
      },
      {
        title: '只属于你的工作空间',
        body: '资料库面向本地、单人使用。不设团队空间、分享权限或云端配额，让内容本身成为主角。',
      },
      {
        title: '关于当前预览',
        body: '当前展示的是内置示例，支持目录展开、搜索和阅读切换。文件导入、编辑与保存尚未接入；这里不会读取或写入你的本地文件。',
      },
    ],
  },
  {
    id: 'notes',
    title: '项目笔记',
    description: '让背景、决策与下一步，留在同一份记录里。',
    sections: [
      {
        title: '背景与目标',
        body: '写下这件事为什么值得做，以及完成后希望看到什么变化。先明确问题，再记录方案。',
      },
      {
        title: '关键决策',
        body: '记录选择及其依据，让下一次回到项目时，不必重新拼凑上下文。',
      },
      {
        title: '下一步',
        body: '把接下来要验证的事情写清楚。此页仅演示阅读排版，不会创建任务或保存笔记。',
      },
    ],
  },
  {
    id: 'ideas',
    title: '灵感收集',
    description: '给尚未成形的想法，留一点空间。',
    sections: [
      {
        title: '随手记下',
        body: '一句有启发的话，一个值得追问的问题，或一次意外的观察。不急着分类，也不急着得出结论。',
      },
      {
        title: '回来看一看',
        body: '让零散片段慢慢产生联系。把值得继续的线索，整理成下一份项目笔记。',
      },
    ],
  },
] as const

export function LibrarySurface() {
  const headingId = useId()
  const previewId = useId()
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string>(EXAMPLES[0].id)
  const needle = query.trim().toLocaleLowerCase()
  const visible = EXAMPLES.filter((entry) =>
    [entry.title, entry.description, ...entry.sections.map(({ title, body }) => `${title} ${body}`)]
      .join(' ')
      .toLocaleLowerCase()
      .includes(needle),
  )
  const selected = visible.find((entry) => entry.id === selectedId) ?? visible[0]
  const documents = (
    <ul className="library-surface__files">
      {visible.map((entry) => (
        <li key={entry.id}>
          <button
            aria-current={entry.id === selected?.id ? 'page' : undefined}
            className="library-surface__file"
            onClick={() => setSelectedId(entry.id)}
            type="button"
          >
            <FileText aria-hidden="true" />
            <span>{entry.title}</span>
          </button>
        </li>
      ))}
    </ul>
  )

  return (
    <section aria-labelledby={headingId} className="library-surface">
      <div className="library-surface__layout">
        <aside aria-label="资料目录" className="library-surface__catalog">
          <header className="library-surface__heading">
            <BookOpen aria-hidden="true" />
            <h1 id={headingId}>资料库</h1>
          </header>
          <p className="library-surface__scope">本地 · 单人</p>
          <label className="library-surface__search">
            <Search aria-hidden="true" />
            <input
              aria-label="搜索示例资料"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索示例资料"
              type="search"
              value={query}
            />
          </label>
          <nav aria-label="示例资料" className="library-surface__directory">
            <p className="library-surface__eyebrow">我的资料 · 示例</p>
            {needle === '' ? (
              <details open>
                <summary>
                  <ChevronRight aria-hidden="true" className="library-surface__chevron" />
                  <Folder aria-hidden="true" />
                  <span>开始使用</span>
                </summary>
                {documents}
              </details>
            ) : visible.length > 0 ? (
              documents
            ) : (
              <p className="library-surface__hint" role="status">
                没有找到匹配的示例资料
              </p>
            )}
          </nav>
        </aside>
        <section aria-label="资料内容" className="library-surface__reader">
          <header className="library-surface__toolbar">
            <div className="library-surface__breadcrumb">
              <Folder aria-hidden="true" />
              <span>开始使用</span>
              <ChevronRight aria-hidden="true" />
              <strong>{selected?.title ?? '搜索结果'}</strong>
            </div>
            <span aria-describedby={previewId} className="library-surface__badge">
              示例 · 只读
            </span>
          </header>
          {selected ? (
            <div className="library-surface__scroll" key={selected.id}>
              <article className="library-surface__document">
                <div aria-hidden="true" className="library-surface__document-icon">
                  <FileText />
                </div>
                <p className="library-surface__eyebrow">个人资料库</p>
                <h2>{selected.title}</h2>
                <p className="library-surface__lead">{selected.description}</p>
                <div className="library-surface__notice">
                  <BookOpen aria-hidden="true" />
                  <p>一侧整理，一侧阅读。让每次回顾，都从清晰开始。</p>
                </div>
                {selected.sections.map((section) => (
                  <section className="library-surface__section" key={section.title}>
                    <h3>{section.title}</h3>
                    <p>{section.body}</p>
                  </section>
                ))}
                <footer className="library-surface__document-footer">
                  内置示例 · 不代表真实文件
                </footer>
              </article>
            </div>
          ) : (
            <div className="library-surface__empty">
              <Search aria-hidden="true" />
              <h2>换个关键词试试</h2>
              <p>可搜索示例资料的标题与正文。</p>
              <button onClick={() => setQuery('')} type="button">
                清空搜索
              </button>
            </div>
          )}
        </section>
      </div>
    </section>
  )
}
