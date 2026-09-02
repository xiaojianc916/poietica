import {
  AUTOMATION_CATEGORIES,
  AUTOMATION_TEMPLATES,
  type AutomationCategory,
  type AutomationTemplate,
  describeSchedule,
} from '@poietica/automation'
import { cn } from '@poietica/design-system'
import { useState } from 'react'

/**
 * 从模板开始。
 *
 * category 住在这里，不住在页面组件里：它只影响下面这排卡片，放在上一层就意味着
 * 切一下分类，统计牌和整张表格陪着重渲染一次 —— 状态该跟着用它的人走。
 *
 * 只往上抛「人点了哪一张」，不抛草稿、更不收整个 store：这一块知道的全部就是
 * 那张卡片。摊成草稿是模板那一层的事（draftOfTemplate），落进哪一屏是页面那
 * 一层的事。多给的每一个能力都是以后可能被顺手用掉的口子。
 *
 * 按钮叫「使用」不叫「添加」：点下去不落盘，而是把这一份草稿摆进新建界面，
 * 人看过、改过、按下保存，才算添加。一个说「添加」却不添加的按钮，是在教
 * 用户不要相信按钮上的字。
 *
 * aria-label 带上模板名：六颗按钮的可见文字一模一样，读屏软件念出来就是六遍
 * 「使用」，那等于没有名字。
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
