import { describe, expect, test } from 'bun:test'
import { formatBrowserElementContext } from './browser-element-context'

describe('browser element context', () => {
  test('serializes the generated picker payload in the T3 context shape', () => {
    const value = formatBrowserElementContext({
      tabId: 1,
      submission: 'send',
      url: 'https://example.com/',
      title: 'Example',
      tagName: 'button',
      selector: '#save',
      role: 'button',
      accessibleName: 'Save',
      text: 'Save',
      html: '<button id="save">Save</button>',
      styles: 'display: inline-flex;',
      comment: 'Tighten this spacing',
    })
    expect(value).toContain('<element_context>')
    expect(value).toContain('selector: #save')
    expect(value).toContain('Tighten this spacing')
  })
})
