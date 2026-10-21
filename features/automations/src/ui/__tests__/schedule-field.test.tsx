import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AutomationScheduleField, type ScheduleValue } from '../automation-schedule-field'

/* 调度栏的可操作面：频率、时间、GMT 与摘要同排；改时间必须落回 cron。 */

afterEach(() => {
  cleanup()
})

function mount(value: ScheduleValue, onChange: (next: ScheduleValue) => void = () => undefined): void {
  render(
    <AutomationScheduleField
      error={null}
      onChange={onChange}
      preview={{ times: [], problem: null }}
      schedule={value}
    />,
  )
}

describe('automation schedule field', () => {
  test('显示频率、时间、GMT 与可读摘要', () => {
    mount({ cron: '0 9 * * 1-5', at: null })
    expect(screen.getByText('每工作日')).toBeDefined()
    expect(screen.getByText('09:00')).toBeDefined()
    expect(screen.getByText('每工作日 09:00')).toBeDefined()
    expect(screen.getByText(/GMT/)).toBeDefined()
  })

  test('打开时间弹层后选分钟，回调写回同一频率', async () => {
    const changes: ScheduleValue[] = []
    mount({ cron: '0 9 * * *', at: null }, (next) => {
      changes.push(next)
    })
    fireEvent.click(screen.getByLabelText('运行时间'))
    fireEvent.click(await screen.findByText('30'))
    expect(changes.at(-1)).toEqual({ cron: '30 9 * * *', at: null })
  })

  test('每周可以多选，至少保留一天', async () => {
    const changes: ScheduleValue[] = []
    mount({ cron: '0 9 * * 1', at: null }, (next) => {
      changes.push(next)
    })
    fireEvent.click(screen.getByLabelText('星期'))
    fireEvent.click(await screen.findByText('周三'))
    expect(changes.at(-1)).toEqual({ cron: '0 9 * * 1,3', at: null })
  })

  test('每小时只报分钟，不假称固定在某个整点', () => {
    mount({ cron: '30 * * * *', at: null })
    expect(screen.getByText('每小时')).toBeDefined()
    expect(screen.getByText('30 分')).toBeDefined()
    expect(screen.getByText('每小时的第 30 分')).toBeDefined()
  })

  test('没有计划时是「添加计划」入口', () => {
    mount({ cron: null, at: null })
    expect(screen.getByText('添加计划')).toBeDefined()
  })
})
