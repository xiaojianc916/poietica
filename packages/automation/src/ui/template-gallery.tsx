import { Activity, FileText, ListChecks, type LucideIcon, Target } from 'lucide-react'
import { AUTOMATION_TEMPLATES, type AutomationTemplate, describeSchedule } from '../index'

/*
 * 字形表住在展示层：templates.ts 是纯数据，要在没有 DOM 的地方被读，不该 import
 * 图标库。加模板忘了配字形会在这里取到 undefined，兜底用文档字形。
 */
const GLYPHS: Readonly<Record<string, LucideIcon>> = {
  'morning-briefing': Target,
  'risk-scan': Activity,
  'release-notes': FileText,
  'docs-sync': ListChecks,
}

export interface TemplateGalleryProps {
  readonly onPick: (template: AutomationTemplate) => void
}

/*
 * 整张卡片就是「用这个模板」的入口，不再单放一颗「使用」按钮：卡片本身已经把
 * 标题、用途和日程说完了，按钮只是重复。description 由 line-clamp-2 收成两行。
 */
export function TemplateGallery({ onPick }: TemplateGalleryProps) {
  return (
    <div className="mt-10 border-t border-divider pt-8">
      <h2 className="text-xs text-muted-foreground">定时任务模板</h2>

      <ul className="mt-3 grid grid-cols-2 gap-3">
        {AUTOMATION_TEMPLATES.map((template) => {
          const Glyph = GLYPHS[template.id] ?? FileText
          return (
            <li className="flex" key={template.id}>
              <button
                aria-label={`使用模板：${template.title}`}
                className="flex w-full flex-col rounded-xl border border-divider bg-[var(--ui-card)] px-4 py-3.5 text-left transition-colors hover:bg-[var(--ui-popup-highlight)]"
                onClick={() => {
                  onPick(template)
                }}
                type="button"
              >
                <span className="flex items-center gap-2">
                  <Glyph aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-xs font-medium">{template.title}</span>
                </span>

                <span className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {template.description}
                </span>

                <span className="mt-auto pt-2.5 text-xs text-muted-foreground">
                  {describeSchedule(template.schedule)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
