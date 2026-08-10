import { describe, expect, it } from 'vitest'
import { latestOwnMessage } from '../own-message'

const said = (id: string) => ({ item: { id, type: 'user_message' } })
const answered = (id: string) => ({ item: { id, type: 'agent_text' } })

describe('latestOwnMessage', () => {
  it('finds nothing in an empty transcript', () => {
    expect(latestOwnMessage([])).toBeNull()
  })

  it('finds nothing when only the agent has spoken', () => {
    expect(latestOwnMessage([answered('a'), answered('b')])).toBeNull()
  })

  it('looks past everything the agent said afterwards', () => {
    expect(latestOwnMessage([said('mine'), answered('a'), answered('b')])).toBe('mine')
  })

  it('takes the last one when there are several', () => {
    expect(latestOwnMessage([said('first'), answered('a'), said('second')])).toBe('second')
  })
})
