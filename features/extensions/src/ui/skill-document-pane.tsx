import { Prose } from '@poietica/design-system/prose'
import type { Disposable } from '@poietica/foundation'
import {
  builtinPoints,
  type LayoutService,
  LayoutToken,
  type UiFeatureContext,
  useObservable,
} from '@poietica/ui-kernel'
import { AlertTriangle, FileText } from 'lucide-react'
import { useState } from 'react'
import type { SkillDocument } from './skill-document'
import {
  createSkillDocumentStore,
  SKILL_DOCUMENT_PANEL,
  type SkillDocumentStore,
  toggleSkillDocument,
} from './skill-document-store'
import './skill-document-pane.css'

/*
 * 技能文档面板：技能名册属于 extensions，面板也就住在这里；画 markdown 的 Prose 来自 `@poietica/design-system/prose`。
 * 形状照 legacy 宿主侧的同名组件与 CSS（别改）。契约没有总字节数与更新时间，字段表因此只剩名称、说明、调用、方式与类型（refactor-log 偏差 23）。
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

/**
 * 「查看 SKILL.md」的出口：再点同一行收起，换一行就换内容。
 *
 * 「打开右坞的哪一格」由 LayoutService 说，「看的是哪一份」由 store 说。面板**第一次被打开时才贡献**：那一格是随文档现开的，
 * 没有一个「还没打开就摆在标签条上」的常驻标签；贡献点里的 title 是常量，所以标签名固定写「技能文档」（已知差距，偏差 23）。
 */
export function createSkillDocumentOpener(ctx: UiFeatureContext): (document: SkillDocument) => void {
  const store = createSkillDocumentStore()
  const layout = ctx.services.get(LayoutToken) as LayoutService
  let panel: Disposable | undefined
  return (document) => {
    toggleSkillDocument(layout, store, document, () => {
      /* 只能贡献一次：ContributionRegistry.add 见到重复 id 会抛 conflict（同一份面板注册两遍是编程错误）。 */
      if (panel === undefined) {
        panel = ctx.contribute(builtinPoints.panels, {
          id: SKILL_DOCUMENT_PANEL,
          location: 'right',
          order: 30,
          title: '技能文档',
          icon: FileText,
          /* 只由打开文档的人带进来，不出现在启动器 / 加号菜单里。 */
          offer: false,
          component: () => <SkillDocumentPane store={store} />,
        })
      }
    })
  }
}
