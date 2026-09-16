import { Prose } from '@poietica/conversation/prose'
import type { SkillRow } from '@poietica/extension'
import { AlertTriangle } from 'lucide-react'
import { useState } from 'react'
import './skill-document-pane.css'

/*
 * 一份技能文档：上面一行说「这是哪个文件、现在看的是哪一种」，下面整块给文档。
 *
 * 两种看法各有各的读者：Preview 给人读，Source 给要对齐字节的人。原文与正文都来自
 * 同一份名册快照，这里不再回盘上读第二次 —— 屏幕上这两半永远出自同一次扫描。
 */

type ViewMode = 'preview' | 'source'

export function SkillDocumentPane({ skill }: { readonly skill: SkillRow | undefined }) {
  const [mode, setMode] = useState<ViewMode>('preview')

  if (skill === undefined) {
    return <p className="skill-doc__missing">这个技能已经不在名册里了。</p>
  }

  const path = skillDocumentPath(skill)
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
        {mode === 'source' ? (
          <SourceView document={skill.document} />
        ) : (
          <PreviewView skill={skill} />
        )}
      </div>
    </div>
  )
}

function PreviewView({ skill }: { readonly skill: SkillRow }) {
  const autoInvocable = skill.type !== 'flow' && skill.disableModelInvocation !== true

  return (
    <article className="skill-doc__preview" data-assistant-skin>
      <dl className="skill-doc__facts">
        <Fact label="名称">{skill.name}</Fact>
        <Fact label="说明">{skill.description ?? '没有提供说明。'}</Fact>
        <Fact label="调用">
          <code>/skill:{skill.name}</code>
        </Fact>
        <Fact label="方式">{autoInvocable ? '可手动调用，也可由模型调用' : '仅手动调用'}</Fact>
        {skill.type === undefined ? null : (
          <Fact label="类型">
            <code>{skill.type}</code>
          </Fact>
        )}
        {skill.whenToUse === undefined ? null : <Fact label="适用场景">{skill.whenToUse}</Fact>}
        {skill.totalBytes === undefined ? null : (
          <Fact label="内容">
            {skill.supportingFiles ?? 0} 个辅助文件 · {formatBytes(skill.totalBytes)}
          </Fact>
        )}
        {skill.modifiedAt === undefined ? null : (
          <Fact label="更新时间">
            {new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
              new Date(skill.modifiedAt * 1000),
            )}
          </Fact>
        )}
      </dl>

      {skill.issues.length === 0 ? null : (
        <div className="skill-doc__warning" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>{skill.issues.join('；')}</span>
        </div>
      )}

      {skill.body === undefined || skill.body === '' ? null : (
        <Prose
          className="skill-doc__prose"
          codeBlockMaxHeight={400}
          mode="static"
          text={skill.body}
        />
      )}
    </article>
  )
}

/*
 * 源码视图带行号：对一份要逐行对齐的文档，「第几行」是最常被引用的坐标。
 *
 * 行号与正文是两块等宽等行高的 pre，不是一个 div 一行：一份几百行的文档不该有几百个
 * 节点，横向滚动时行号那一列贴着左缘不动（sticky），读起来才对得上号。
 */
function SourceView({ document }: { readonly document: string | undefined }) {
  if (document === undefined || document === '') {
    return (
      <p className="skill-doc__missing">
        Kimi 报告了实际路径，但本机未能读取该文件。请检查路径权限或文件是否已移动。
      </p>
    )
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

/*
 * 名册上的位置有时是 SKILL.md 本身，有时是它所在的目录（本机装的那些只报目录）。
 * 文档视图要的是那个文件，所以这里把两种写法收成一个。
 */
function skillDocumentPath(skill: SkillRow): string {
  if (/\.md$/i.test(skill.path)) {
    return skill.path
  }

  const separator = skill.path.includes('\\') ? '\\' : '/'

  return `${skill.path.replace(/[\\/]+$/, '')}${separator}SKILL.md`
}

/* 一段一段地读路径。键是这一段的来路：路径里可以有同名的目录，前缀不会重。 */
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

function formatBytes(value: number): string {
  const format = (amount: number) =>
    new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(amount)

  if (value < 1024) {
    return `${format(value)} B`
  }
  if (value < 1024 * 1024) {
    return `${format(value / 1024)} KB`
  }
  return `${format(value / (1024 * 1024))} MB`
}
