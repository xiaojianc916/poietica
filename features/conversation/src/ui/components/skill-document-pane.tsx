import { useObservable } from '@poietica/ui-kernel'
import { AlertTriangle } from 'lucide-react'
import { useState } from 'react'
import type { SkillDocument } from '../../ui-api'
import type { SkillDocumentStore } from './skill-document-store'
import { Prose } from './timeline/prose'
import './skill-document-pane.css'

/*
 * 技能文档那一格。**迁移自** legacy 宿主侧的 `apps/desktop/src/workbench/skill-document-pane.tsx`
 * 与同名 CSS：文件位置面包屑、Preview / Source 两档、预览的字段表、源码的行号列一字未改。
 *
 * 它住在 conversation 而不是 extensions：能画 markdown 的那一套排版（Prose）属于会话的
 * 时间线，功能之间不得互相 import `ui`（守则 3），所以面板由 conversation 贡献、
 * extensions 经 `SkillDocumentToken` 递内容（与 legacy 的分工相同，只是接口换了名字）。
 *
 * 与 legacy 的差距：legacy 的 SKILL.md 原文、类型、辅助文件数都由原生名册带回来；
 * 契约 `SkillInfo` 只有 id / name / description / source / enabled / path，加上
 * `skills.read` 交回的 markdown，所以字段表只剩名称、说明、调用、方式与类型（从
 * frontmatter 现读），没有总字节数与更新时间。见 docs/refactor-log.md 偏差 23。
 */

type ViewMode = 'preview' | 'source'

export function SkillDocumentPane({ store }: { readonly store: SkillDocumentStore }) {
  const document = useObservable(store)
  const [mode, setMode] = useState<ViewMode>('preview')

  if (document === undefined) {
    return <p className="skill-doc__missing">还没有打开任何技能。</p>
  }

  const path = documentPath(document)
  const crumbs = pathCrumbs(path)

  return (
    <div className="skill-doc">
      <div className="skill-doc__bar">
        <nav aria-label="文件位置" className="skill-doc__path" title={path}>
          {crumbs.map((crumb, index) => (
            <span
              className="skill-doc__crumb"
              data-last={index === crumbs.length - 1 ? 'true' : undefined}
              key={crumb.key}
            >
              {crumb.label}
            </span>
          ))}
        </nav>

        <fieldset aria-label="查看方式" className="skill-doc__modes">
          <button
            aria-pressed={mode === 'preview'}
            className="skill-doc__mode"
            onClick={() => {
              setMode('preview')
            }}
            type="button"
          >
            Preview
          </button>
          <button
            aria-pressed={mode === 'source'}
            className="skill-doc__mode"
            onClick={() => {
              setMode('source')
            }}
            type="button"
          >
            Source
          </button>
        </fieldset>
      </div>

      <div className="skill-doc__body">
        {mode === 'source' ? <SourceView document={document.markdown} /> : <PreviewView document={document} />}
      </div>
    </div>
  )
}

function PreviewView({ document }: { readonly document: SkillDocument }) {
  const { facts } = document
  const autoInvocable = facts.type !== 'flow' && !facts.disableModelInvocation

  return (
    <article className="skill-doc__preview" data-assistant-skin>
      <dl className="skill-doc__facts">
        <Fact label="名称">{facts.name}</Fact>
        <Fact label="说明">{facts.description ?? '没有提供说明。'}</Fact>
        <Fact label="调用">
          <code>/skill:{facts.name}</code>
        </Fact>
        <Fact label="方式">{autoInvocable ? '可手动调用，也可由模型调用' : '仅手动调用'}</Fact>
        {facts.type === undefined ? null : (
          <Fact label="类型">
            <code>{facts.type}</code>
          </Fact>
        )}
        {facts.whenToUse === undefined ? null : <Fact label="适用场景">{facts.whenToUse}</Fact>}
      </dl>

      {facts.issues.length === 0 ? null : (
        <div className="skill-doc__warning" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>{facts.issues.join('；')}</span>
        </div>
      )}

      {facts.body === '' ? null : (
        <Prose className="skill-doc__prose" codeBlockMaxHeight={400} mode="static" text={facts.body} />
      )}
    </article>
  )
}

function SourceView({ document }: { readonly document: string }) {
  if (document === '') {
    return <p className="skill-doc__missing">这份 SKILL.md 是空的。</p>
  }

  const lineCount = document.split(/\r?\n/).length

  return (
    <div className="skill-doc__source">
      <pre aria-hidden="true" className="skill-doc__gutter">
        {Array.from({ length: lineCount }, (_, line) => line + 1).join('\n')}
      </pre>
      <pre className="skill-doc__text">{document}</pre>
    </div>
  )
}

function Fact({ children, label }: { readonly children: React.ReactNode; readonly label: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

// 名册上的路径可能是 SKILL.md 本身，也可能只是目录（本机安装只报目录）。
function documentPath(document: SkillDocument): string {
  if (/\.md$/i.test(document.path)) {
    return document.path
  }

  const separator = document.path.includes('\\') ? '\\' : '/'

  return `${document.path.replace(/[\\/]+$/, '')}${separator}SKILL.md`
}

function pathCrumbs(path: string): readonly { readonly key: string; readonly label: string }[] {
  let prefix = ''

  return path
    .split(/[\\/]/)
    .filter((segment) => segment !== '')
    .map((label) => {
      prefix = prefix === '' ? label : `${prefix}/${label}`

      return { key: prefix, label }
    })
}
