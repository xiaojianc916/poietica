import { cn } from '@poietica/design-system'
import { useState } from 'react'
import {
  AUTOMATION_CATEGORIES,
  AUTOMATION_TEMPLATES,
  type AutomationCategory,
  type AutomationTemplate,
  describeSchedule,
} from '../index'

/**
 * category 状态住这里：切分类只重渲染这排卡片，不牵动统计牌和表格。
 * 只上抛「点了哪一张」；摊成草稿是模板层的事（draftOfTemplate），落屏是页面层的事。
 * 按钮叫「使用」不叫「添加」：点击先摆进新建界面，人保存后才算添加。
 * aria-label 带模板名：六颗按钮可见文字相同，读屏念六遍「使用」等于没有名字。
 */

export interface TemplateGalleryProps {
  readonly onPick: (template: AutomationTemplate) => void
}

const ALL_CATEGORIES = '全部' as const

type CategoryTab = typeof ALL_CATEGORIES | AutomationCategory

export function TemplateGallery({ onPick }: TemplateGalleryProps) {
  const [category, setCategory] = useState<CategoryTab>(ALL_CATEGORIES)

  const templates = AUTOMATION_TEMPLATES.filter(
    (template) => category === ALL_CATEGORIES || template.category === category,
  )

  return (
    <div className="mt-10 px-8 py-6">
      <h2 className="text-xs font-medium text-muted-foreground">从模板开始</h2>

      <div className="mt-3 flex gap-1">
        {[ALL_CATEGORIES, ...AUTOMATION_CATEGORIES].map((tab) => (
          <button
            aria-pressed={tab === category}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs transition-colors hover:bg-sidebar-accent',
              tab === category ? 'bg-sidebar-accent text-foreground' : 'text-muted-foreground',
            )}
            key={tab}
            onClick={() => {
              setCategory(tab)
            }}
            type="button"
          >
            {tab}
          </button>
        ))}
      </div>

      <ul className="mt-4 grid grid-cols-2 gap-3">
        {templates.map((template) => (
          <li className="rounded-lg border border-divider bg-background p-4" key={template.id}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium">{template.title}</p>

                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {template.description}
                </p>

                <p className="mt-2 text-xs text-muted-foreground">
                  {describeSchedule(template.schedule)}
                </p>
              </div>

              <button
                aria-label={`使用模板：${template.title}`}
                className="shrink-0 rounded-md border border-divider px-2.5 py-1 text-xs transition-colors hover:bg-sidebar-accent"
                onClick={() => {
                  onPick(template)
                }}
                type="button"
              >
                使用
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
