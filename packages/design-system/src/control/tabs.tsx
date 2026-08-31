import { Tabs as BaseTabs } from '@base-ui/react/tabs'
import type { ComponentProps } from 'react'
import { cn } from '../class-names'

export const Tabs = BaseTabs.Root

export function TabsList({
  activateOnFocus = true,
  className,
  ...props
}: ComponentProps<typeof BaseTabs.List>) {
  return (
    <BaseTabs.List
      activateOnFocus={activateOnFocus}
      className={cn('inline-flex items-center rounded-full bg-sidebar-accent/60 p-0.5', className)}
      {...props}
    />
  )
}

export function TabsTab({ className, ...props }: ComponentProps<typeof BaseTabs.Tab>) {
  return (
    <BaseTabs.Tab
      className={cn(
        'rounded-full px-3 py-1 text-xs text-muted-foreground outline-none transition-colors',
        'hover:text-foreground aria-selected:bg-background aria-selected:text-foreground',
        'focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      {...props}
    />
  )
}

export function TabsPanel({ className, ...props }: ComponentProps<typeof BaseTabs.Panel>) {
  return (
    <BaseTabs.Panel
      className={cn('outline-none focus-visible:ring-2 focus-visible:ring-ring', className)}
      {...props}
    />
  )
}
