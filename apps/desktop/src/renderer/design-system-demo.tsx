import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
  Banner,
  Button,
  ConfirmationDialog,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ErrorState,
  FileTypeMark,
  GithubMark,
  InlineSpinner,
  LoadingState,
  PixelLoader,
  PoieticaMark,
  RegionSplitter,
  SegmentedControl,
  Select,
  Switch,
  ToastRegion,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  useCopy,
} from '@poietica/design-system'
import { type ReactElement, useState } from 'react'

/**
 * 组件演示页（P3.4 的验收工具）：把 design-system 的每个导出摆一屏，方便与 legacy 的基准截图逐个对照。
 * 路由是 `/__ds`（见 index.tsx），只在开发版注册。
 */
export function DesignSystemDemo(): ReactElement {
  const [switchOn, setSwitchOn] = useState(true)
  const [segment, setSegment] = useState('a')
  const [selectValue, setSelectValue] = useState('a')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [bannerKey, setBannerKey] = useState(0)
  const [, setSplitterWidth] = useState(240)
  const { copied, copy } = useCopy()

  return (
    <TooltipProvider delay={450}>
      <div className="ds-demo" data-ds-demo>
        <h1 className="ds-demo__title">Design System</h1>

        <section className="ds-demo__section" data-ds-section="control">
          <h2>控件</h2>
          <div className="ds-demo__row">
            <Button data-ds="button-default" type="button">
              默认按钮
            </Button>
            <Button type="button" variant="outline">
              描边
            </Button>
            <Button type="button" variant="secondary">
              次要
            </Button>
            <Button type="button" variant="ghost">
              幽灵
            </Button>
            <Button type="button" variant="destructive">
              危险
            </Button>
            <Button type="button" variant="dangerSoft">
              软危险
            </Button>
          </div>
          <div className="ds-demo__row">
            <Switch checked={switchOn} onCheckedChange={setSwitchOn} />
            <SegmentedControl
              label="分段控件"
              name="ds-demo-segment"
              onValueChange={setSegment}
              options={[
                { value: 'a', label: '甲' },
                { value: 'b', label: '乙' },
              ]}
              value={segment}
            />
            <Select
              data={[
                { value: 'a', label: '选项一' },
                { value: 'b', label: '选项二' },
              ]}
              onValueChange={setSelectValue}
              type="选项"
              value={selectValue}
            />
          </div>
          <div className="ds-demo__row">
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button type="button" variant="outline" />}>下拉菜单</DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem>第一项</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem>第二项</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button onClick={() => setDialogOpen(true)} type="button" variant="outline">
              打开对话框
            </Button>
            <Button onClick={() => setConfirmOpen(true)} type="button" variant="outline">
              打开确认框
            </Button>
            <Tooltip>
              <TooltipTrigger render={<Button type="button" variant="ghost" />}>悬停看提示</TooltipTrigger>
              <TooltipContent>这是一条提示</TooltipContent>
            </Tooltip>
            <Button onClick={() => copy('已复制的文本')} type="button" variant="soft">
              {copied ? '已复制' : '复制'}
            </Button>
          </div>
          <Accordion>
            <AccordionItem>
              <AccordionHeader>
                <AccordionTrigger>折叠标题</AccordionTrigger>
              </AccordionHeader>
              <AccordionPanel>折叠内容</AccordionPanel>
            </AccordionItem>
          </Accordion>
          <Dialog onOpenChange={setDialogOpen} open={dialogOpen} title="对话框标题">
            <p>对话框内容</p>
          </Dialog>
          <ConfirmationDialog
            confirmLabel="确定"
            description="确认框内容"
            onCancel={() => setConfirmOpen(false)}
            onConfirm={() => setConfirmOpen(false)}
            open={confirmOpen}
            title="确认框标题"
          />
        </section>

        <section className="ds-demo__section" data-ds-section="feedback">
          <h2>反馈</h2>
          <div className="ds-demo__row">
            <InlineSpinner />
            <LoadingState />
            <ErrorState message="出错了" onRetry={() => undefined} />
          </div>
          <div className="ds-demo__row">
            <Button onClick={() => setBannerKey((k) => k + 1)} type="button" variant="outline">
              弹一条横幅
            </Button>
            {bannerKey > 0 ? <Banner key={bannerKey} onDone={() => undefined} text="一句话横幅" /> : null}
          </div>
          <ToastRegion
            notices={[{ id: 'a', title: '失败通知', detail: '细节在这里', closing: false }]}
            onDismiss={() => undefined}
            onHoverChange={() => undefined}
          />
        </section>

        <section className="ds-demo__section" data-ds-section="mark">
          <h2>标记与布局</h2>
          <div className="ds-demo__row">
            <PoieticaMark />
            <GithubMark />
            <PixelLoader />
            <FileTypeMark className="ds-demo__mark" name="a.ts" />
          </div>
          <div className="ds-demo__splitter">
            <RegionSplitter
              edge="inline-start"
              label="演示分隔条"
              max={480}
              min={160}
              onActivity={() => undefined}
              onCollapse={() => undefined}
              onResize={setSplitterWidth}
              width={240}
            />
            <span>分隔条</span>
          </div>
        </section>
      </div>
    </TooltipProvider>
  )
}
