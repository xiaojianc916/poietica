;(() => {
  const apiKey = '__poieticaElementPicker'
  if (window[apiKey]) {
    return
  }

  const callbackUrl = 'https://pick.poietica.invalid/'
  const styleNames = [
    'display',
    'position',
    'width',
    'height',
    'margin',
    'padding',
    'gap',
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'color',
    'background',
    'border',
    'border-radius',
    'box-shadow',
    'opacity',
  ]
  let session = null

  function unique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1
    } catch {
      return false
    }
  }

  function byIdSelector(element) {
    if (!element.id) {
      return null
    }
    const byId = `#${CSS.escape(element.id)}`
    return unique(byId) ? byId : null
  }

  function byAttributeSelector(element) {
    for (const name of ['data-testid', 'data-test', 'data-cy', 'aria-label', 'name']) {
      const value = element.getAttribute(name)
      if (!value) {
        continue
      }
      const candidate = `${element.tagName.toLowerCase()}[${name}="${CSS.escape(value)}"]`
      if (unique(candidate)) {
        return candidate
      }
    }
    return null
  }

  function byPathSelector(element) {
    const path = []
    let node = element
    while (node instanceof Element) {
      let part = node.tagName.toLowerCase()
      const classes = Array.from(node.classList)
        .filter((value) => value.length < 64)
        .slice(0, 3)
      if (classes.length > 0) {
        const withClasses = part + classes.map((value) => `.${CSS.escape(value)}`).join('')
        if (unique(withClasses)) {
          return withClasses
        }
        part = withClasses
      }
      const parent = node.parentElement
      if (parent) {
        const sameTag = Array.from(parent.children).filter(
          (child) => child.tagName === node.tagName,
        )
        if (sameTag.length > 1) {
          part += `:nth-of-type(${sameTag.indexOf(node) + 1})`
        }
      }
      path.unshift(part)
      const candidate = path.join(' > ')
      if (unique(candidate)) {
        return candidate
      }
      node = parent
    }
    return path.join(' > ')
  }

  function selectorFor(element) {
    return byIdSelector(element) ?? byAttributeSelector(element) ?? byPathSelector(element)
  }

  function accessibleName(element) {
    const direct =
      element.getAttribute('aria-label') ||
      element.getAttribute('alt') ||
      element.getAttribute('title')
    if (direct) {
      return direct.trim()
    }
    const labelledBy = element.getAttribute('aria-labelledby')
    if (labelledBy) {
      const value = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ')
        .trim()
      if (value) {
        return value
      }
    }
    return String(element.innerText || element.textContent || '')
      .trim()
      .slice(0, 1000)
  }

  function stylesFor(element) {
    const computed = getComputedStyle(element)
    return styleNames
      .map((name) => `${name}: ${computed.getPropertyValue(name).trim()};`)
      .join('\n')
  }

  function isUi(event) {
    return session !== null && event.composedPath().includes(session.host)
  }

  function place(element) {
    if (session === null) {
      return
    }
    const rect = element.getBoundingClientRect()
    session.outline.hidden = rect.width <= 0 || rect.height <= 0
    session.outline.style.left = `${rect.left}px`
    session.outline.style.top = `${rect.top}px`
    session.outline.style.width = `${rect.width}px`
    session.outline.style.height = `${rect.height}px`
    session.badge.textContent = element.tagName.toLowerCase()
    session.badge.style.left = `${Math.max(8, rect.left)}px`
    session.badge.style.top = `${Math.max(8, rect.top - 24)}px`
  }

  function pointAt(x, y) {
    const element = document.elementFromPoint(x, y)
    if (!(element instanceof Element) || session === null || element === session.host) {
      return
    }
    session.target = element
    place(element)
  }

  function positionCard(element) {
    if (session === null) {
      return
    }
    const rect = element.getBoundingClientRect()
    const width = 336
    const height = 190
    const left = Math.min(Math.max(8, rect.left), Math.max(8, innerWidth - width - 8))
    let top = rect.bottom + 10
    if (top + height > innerHeight) {
      top = Math.max(8, rect.top - height - 10)
    }
    session.card.style.left = `${left}px`
    session.card.style.top = `${top}px`
  }

  function showComposer(element) {
    if (session === null) {
      return
    }
    session.selected = element
    place(element)
    positionCard(element)
    session.summary.textContent = selectorFor(element)
    session.card.hidden = false
    session.textarea.focus()
  }

  function cancel() {
    if (session === null) {
      return
    }
    document.removeEventListener('pointermove', onPointerMove, true)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('scroll', onViewport, true)
    window.removeEventListener('resize', onViewport)
    cancelAnimationFrame(session.frame)
    session.cursor.remove()
    session.host.remove()
    session = null
  }

  function report(submission) {
    if (session === null) {
      return
    }
    const current = session
    const element = current.selected
    const params = new URLSearchParams()
    params.set('token', String(current.token))
    params.set('submission', submission)

    if (submission !== 'cancel' && element instanceof Element) {
      params.set('url', location.href.slice(0, 2000))
      params.set('title', document.title.slice(0, 300))
      params.set('tag', element.tagName.toLowerCase())
      params.set('selector', selectorFor(element).slice(0, 2000))
      params.set('role', String(element.getAttribute('role') || '').slice(0, 128))
      params.set('name', accessibleName(element).slice(0, 1000))
      params.set(
        'text',
        String(element.innerText || '')
          .trim()
          .slice(0, 2000),
      )
      params.set('html', String(element.outerHTML || '').slice(0, 4000))
      params.set('styles', stylesFor(element).slice(0, 4000))
      params.set('comment', current.textarea.value.trim().slice(0, 2000))
    }

    cancel()
    location.assign(`${callbackUrl}?${params.toString()}`)
  }

  function onPointerMove(event) {
    if (session === null || session.selected !== null || isUi(event)) {
      return
    }
    session.pointer = { x: event.clientX, y: event.clientY }
    if (session.frame !== 0) {
      return
    }
    session.frame = requestAnimationFrame(() => {
      if (session === null) {
        return
      }
      session.frame = 0
      if (session.pointer) {
        pointAt(session.pointer.x, session.pointer.y)
      }
    })
  }

  function onPointerDown(event) {
    if (session === null || isUi(event)) {
      return
    }
    const element = session.target || (event.target instanceof Element ? event.target : null)
    if (element === null) {
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    showComposer(element)
  }

  function onClick(event) {
    if (isUi(event)) {
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function onKeyDown(event) {
    if (session === null || event.isComposing) {
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      report('cancel')
      return
    }
    if (session.selected !== null && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      event.stopImmediatePropagation()
      report(event.metaKey || event.ctrlKey ? 'send' : 'attach')
    }
  }

  function onViewport() {
    if (session === null) {
      return
    }
    const element = session.selected || session.target
    if (element instanceof Element && element.isConnected) {
      place(element)
      if (session.selected) {
        positionCard(element)
      }
    }
  }

  function start(token) {
    cancel()
    const host = document.createElement('div')
    host.setAttribute('data-poietica-picker', '')
    const root = host.attachShadow({ mode: 'closed' })
    root.innerHTML =
      '<style>' +
      ':host{all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:Inter,system-ui,sans-serif;color:#18181b}' +
      '.outline{position:fixed;box-sizing:border-box;border:2px solid #3b82f6;background:rgba(59,130,246,.14);pointer-events:none}' +
      '.badge{position:fixed;border-radius:5px;background:#2563eb;color:white;padding:3px 6px;font:600 11px/1.2 ui-monospace,monospace}' +
      '.card{position:fixed;width:312px;border:1px solid rgba(0,0,0,.14);border-radius:12px;background:#fff;padding:12px;box-shadow:0 18px 45px rgba(0,0,0,.22);pointer-events:auto}' +
      '.head{display:flex;align-items:center;gap:8px}.title{font:600 13px/1.3 system-ui}.close{margin-left:auto;border:0;background:transparent;font-size:18px;cursor:pointer}' +
      '.selector{margin:6px 0 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#71717a;font:11px/1.3 ui-monospace,monospace}' +
      'textarea{box-sizing:border-box;width:100%;min-height:66px;resize:vertical;border:1px solid #d4d4d8;border-radius:8px;padding:8px;font:12px/1.4 system-ui;outline:none}' +
      'textarea:focus{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.16)}' +
      '.actions{display:flex;align-items:center;gap:8px;margin-top:10px}.hint{margin-right:auto;color:#71717a;font:10px/1.2 system-ui}' +
      'button.action{border:1px solid #d4d4d8;border-radius:8px;background:#fff;padding:6px 9px;font:600 11px/1 system-ui;cursor:pointer}' +
      'button.send{border-color:#2563eb;background:#2563eb;color:#fff}' +
      '</style>' +
      '<div class="outline" hidden></div><div class="badge"></div>' +
      '<section class="card" role="dialog" aria-label="发送元素给 AI" hidden>' +
      '<div class="head"><div class="title">发送元素给 AI</div><button class="close" type="button" aria-label="关闭">×</button></div>' +
      '<div class="selector"></div><textarea aria-label="补充说明" placeholder="描述希望 AI 对这个元素做什么（可选）"></textarea>' +
      '<div class="actions"><span class="hint">Enter 加入 · Ctrl/⌘ Enter 发送</span><button class="action attach" type="button">加入输入框</button><button class="action send" type="button">直接发送</button></div>' +
      '</section>'

    const cursor = document.createElement('style')
    cursor.textContent = '*{cursor:crosshair!important}'
    document.documentElement.append(cursor, host)

    session = {
      token,
      host,
      cursor,
      outline: root.querySelector('.outline'),
      badge: root.querySelector('.badge'),
      card: root.querySelector('.card'),
      summary: root.querySelector('.selector'),
      textarea: root.querySelector('textarea'),
      target: null,
      selected: null,
      pointer: null,
      frame: 0,
    }

    root.querySelector('.close').addEventListener('click', () => report('cancel'))
    root.querySelector('.attach').addEventListener('click', () => report('attach'))
    root.querySelector('.send').addEventListener('click', () => report('send'))
    document.addEventListener('pointermove', onPointerMove, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('scroll', onViewport, true)
    window.addEventListener('resize', onViewport)
  }

  window[apiKey] = Object.freeze({ start, cancel })
})()
