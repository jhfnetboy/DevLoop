import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Offline contract check for dashboard/client.js, the Harness client-module
 * bundle: evaluated against a stub loader, `slots` service, and React, the
 * same way the real Harness composes and runs it. The bundle is plain
 * browser JavaScript, not compiled TypeScript, so nothing else in this suite
 * exercises it — a broken registration or a wrong request body would otherwise
 * surface only after a Desktop/profile restart.
 *
 * The page's own behaviour is driven through the rendered tree rather than by
 * exporting internals, because a client bundle's only supported face is
 * `apply`/`inject`: what the Harness can call is what this suite calls too.
 */

const CLIENT = fileURLToPath(new URL('../dashboard/client.js', import.meta.url))

/** How long a test waits for an async read to land in the tree. */
const SETTLE_MS = 20
const SETTLE_TRIES = 100

function sameDeps(previous: unknown[] | undefined, next: unknown[] | undefined): boolean {
  if (previous === undefined || next === undefined) return false
  return previous.length === next.length && previous.every((value, index) => Object.is(value, next[index]))
}

/**
 * Enough of React to run these components and re-render them.
 *
 * Function components are expanded, not left as opaque elements: the page's
 * rows are components of their own, so a tree that stopped at them would assert
 * nothing about what an operator sees. Hooks are stored per component position,
 * which is what lets a card keep its own goal draft while its siblings re-render,
 * and effect deps are compared the way React compares them so the polling effect
 * mounts once.
 */
function createHookRuntime() {
  type Hook = { state?: unknown; deps?: unknown[]; value?: unknown; cleanup?: () => void }
  type Instance = { hooks: Hook[]; cursor: number }
  const instances = new Map<string, Instance>()
  let active: Instance | null = null
  let dirty = false

  const StubReact = {
    // `props.children` is populated the way React populates it (a lone child
    // stays unwrapped), because a component that forwards children — the
    // shared Button here — reads it from props, not from the element.
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
      const flat = children.flat(Infinity) as unknown[]
      return {
        type,
        props: {
          ...(props || {}),
          children: flat.length === 0 ? undefined : flat.length === 1 ? flat[0] : flat,
        },
        children: flat,
      }
    },
    useState(initial: unknown) {
      const instance = active!
      const index = instance.cursor++
      instance.hooks[index] ??= { state: typeof initial === 'function' ? (initial as () => unknown)() : initial }
      const hook = instance.hooks[index]
      return [
        hook.state,
        (next: unknown) => {
          hook.state = typeof next === 'function' ? (next as (previous: unknown) => unknown)(hook.state) : next
          dirty = true
        },
      ]
    },
    useCallback(fn: unknown, deps?: unknown[]) {
      const instance = active!
      const index = instance.cursor++
      const hook = instance.hooks[index]
      if (hook !== undefined && sameDeps(hook.deps, deps)) return hook.value
      instance.hooks[index] = { value: fn, deps }
      return fn
    },
    useEffect(fn: () => undefined | (() => void), deps?: unknown[]) {
      const instance = active!
      const index = instance.cursor++
      const hook = instance.hooks[index]
      if (hook !== undefined && sameDeps(hook.deps, deps)) return
      instance.hooks[index] = { deps }
      const run = fn()
      if (typeof run === 'function') instance.hooks[index].cleanup = run
    },
  }

  /** Render one node, invoking function components and recursing into results. */
  function expand(node: unknown, path: string): unknown {
    if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}.${String(index)}`))
    if (node === null || typeof node !== 'object') return node
    const element = node as Element
    if (typeof element.type === 'function') {
      let instance = instances.get(path)
      if (instance === undefined) {
        instance = { hooks: [], cursor: 0 }
        instances.set(path, instance)
      }
      const previous = active
      active = instance
      instance.cursor = 0
      let produced: unknown
      try {
        produced = (element.type as (props: Record<string, unknown>) => unknown)(element.props)
      } finally {
        active = previous
      }
      const name = element.type.name === '' ? 'component' : element.type.name
      return expand(produced, `${path}#${name}`)
    }
    return {
      type: element.type,
      props: element.props,
      children: (element.children ?? []).map((child, index) => expand(child, `${path}.${String(index)}`)),
    }
  }

  return {
    React: StubReact,
    /** Render and flush effects, repeating while any state was set. */
    render(component: (props: Record<string, unknown>) => unknown, props: Record<string, unknown>) {
      let tree: unknown
      let guard = 0
      do {
        dirty = false
        tree = expand({ type: component, props, children: [] }, 'root')
      } while (dirty && ++guard < 20)
      return tree
    },
    dispose() {
      for (const instance of instances.values()) {
        for (const hook of instance.hooks) hook.cleanup?.()
      }
    },
  }
}

type Element = { type: unknown; props: Record<string, unknown>; children: unknown[] }

/** Depth-first walk over the stub tree; strings and numbers are leaves, not nodes. */
function walk(node: unknown, visit: (element: Element) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (node === null || typeof node !== 'object') return
  const element = node as Element
  visit(element)
  for (const child of element.children ?? []) walk(child, visit)
}

/**
 * All text in a subtree. Function components in this stub are never invoked, so
 * their element carries its props but not its rendered children; the text lives
 * on the host elements they created, which is what this reads.
 */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (node === null || typeof node !== 'object') return ''
  return ((node as Element).children ?? []).map(textOf).join(' ')
}

/** Host `<button>` elements only: a component element's type is a function. */
function buttonsIn(tree: unknown): { props: Record<string, unknown>; label: string }[] {
  const found: { props: Record<string, unknown>; label: string }[] = []
  walk(tree, (element) => {
    if (element.type !== 'button') return
    found.push({ props: element.props, label: textOf(element).trim() })
  })
  return found
}

function textareaIn(tree: unknown): Element | undefined {
  let found: Element | undefined
  walk(tree, (element) => { if (element.type === 'textarea') found = element })
  return found
}

function loadClient() {
  let registration: { id: string; factory: (require: (s: string) => unknown) => { apply: (ctx: unknown) => void; inject: string[] } } | undefined
  const opened: unknown[][] = []
  const stubWindow = { __ModuleLoader__: { load: (r: typeof registration) => { registration = r } }, open: (...a: unknown[]) => opened.push(a) }
  new Function('window', readFileSync(CLIENT, 'utf8'))(stubWindow)
  if (!registration) throw new Error('client.js did not call window.__ModuleLoader__.load')
  return { registration, opened }
}

/**
 * Collect every slot registration the bundle makes, and the component for each.
 *
 * `services` answers `ctx.get`, which is how the bundle reads the client services
 * it switches views through. Omitting one is the case a profile without it would
 * see, and is what the launcher fallback is tested against.
 */
function registrations(services: Record<string, unknown> = {}) {
  const { registration, opened } = loadClient()
  const runtime = createHookRuntime()
  const face = registration.factory((s) => {
    if (s === 'react') return runtime.React
    throw new Error(`unexpected require: ${s}`)
  })
  const calls: { kind: string; name: string; id?: string; order?: number; label?: string }[] = []
  const components = new Map<string, (props: Record<string, unknown>) => unknown>()
  face.apply({
    get: (name: string) => services[name],
    slots: {
      inject: (name: string, cb: () => void) => { calls.push({ kind: 'inject', name }); return cb() },
      register: (o: { name: string; id?: string; order?: number; label?: string }, c: (props: Record<string, unknown>) => unknown) => {
        calls.push({ kind: 'register', name: o.name, id: o.id, order: o.order, label: o.label })
        components.set(o.name, c)
        return () => {}
      },
    },
  })
  return { registration, face, calls, components, runtime, opened }
}

/** One project as the host reports it, with the fields a row actually reads. */
function project(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aaaa11112222',
    name: 'how-to-make-money',
    root: '/Users/jason/Dev/jhfnetboy/how-to-make-money',
    own: false,
    loop: 'running',
    armed: false,
    revision: null,
    lastAction: null,
    halted: false,
    paused: false,
    completed: false,
    haltReasons: [],
    haltDetails: [],
    question: null,
    taskCounts: {},
    costUsdSession: null,
    costUsdDay: null,
    updatedAt: null,
    error: null,
    lane: 'idle',
    since: null,
    ...overrides,
  }
}

function envelope(value: unknown) {
  return { ok: true, value }
}

/** A fetch stub that answers by route and records every request it saw. */
function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: { url: string; method: string; body: unknown }[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
    const payload = handler(url, init)
    if (payload instanceof Error) throw payload
    return { ok: true, status: 200, json: async () => payload }
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('dashboard/client.js: the Harness client-module bundle', () => {
  it('registers under the package name, requires only react, and exports apply/inject', () => {
    const { registration } = loadClient()
    expect(registration.id).toBe('@jhfnetboy/dsh-devloop')
    const face = registration.factory((s) => {
      if (s === 'react') return createHookRuntime().React
      throw new Error(`unexpected require: ${s}`)
    })
    expect(typeof face.apply).toBe('function')
    expect(face.inject).toEqual(['slots'])
  })

  it('registers a page in conversation.view, ordered after the app\'s own views', () => {
    const { calls } = registrations()
    expect(calls).toContainEqual({ kind: 'inject', name: 'conversation.view' })
    expect(calls).toContainEqual({ kind: 'register', name: 'conversation.view', id: 'devloop', order: 20, label: 'DevLoop' })
  })

  it('keeps the sidebar launcher beside it', () => {
    const { calls } = registrations()
    expect(calls).toContainEqual({ kind: 'inject', name: 'sidebar.footer.action' })
    expect(calls).toContainEqual({ kind: 'register', name: 'sidebar.footer.action', id: 'devloop-dashboard', order: 100, label: 'DevLoop' })
  })

  it('switches the conversation to the DevLoop view instead of opening a window', () => {
    const activated: unknown[] = []
    const { components, runtime, opened } = registrations({
      sessions: { list: { getSnapshot: () => ({ current: 'session-1' }) } },
      uiConversation: { binding: (id: unknown) => ({ activate: (view: unknown) => { activated.push([id, view]) } }) },
    })

    const button = components.get('sidebar.footer.action')!
    const [first] = buttonsIn(runtime.render(button, { wide: true }))
    expect(first.props['aria-label']).toBe('DevLoop')
    ;(first.props.onClick as () => void)()

    expect(activated).toEqual([['session-1', 'devloop']])
    expect(opened).toEqual([])
  })

  it('falls back to the standalone page when there is no conversation to switch', () => {
    const activated: unknown[] = []
    const { components, runtime, opened } = registrations({
      sessions: { list: { getSnapshot: () => ({}) } },
      uiConversation: { binding: (id: unknown) => ({ activate: (view: unknown) => { activated.push([id, view]) } }) },
    })

    const button = components.get('sidebar.footer.action')!
    const [first] = buttonsIn(runtime.render(button, { wide: false }))
    ;(first.props.onClick as () => void)()

    expect(activated).toEqual([])
    expect(opened).toEqual([['/devloop/', '_blank', 'noopener,noreferrer']])
  })

  it('falls back to the standalone page on a profile without those services', () => {
    const { components, runtime, opened } = registrations()
    const button = components.get('sidebar.footer.action')!
    for (const wide of [true, false]) {
      const [first] = buttonsIn(runtime.render(button, { wide }))
      expect(first.props['aria-label']).toBe('DevLoop')
      ;(first.props.onClick as () => void)()
    }
    expect(opened).toEqual([
      ['/devloop/', '_blank', 'noopener,noreferrer'],
      ['/devloop/', '_blank', 'noopener,noreferrer'],
    ])
  })
})

describe('the DevLoop page', () => {
  let runtime: ReturnType<typeof createHookRuntime>
  let view: (props: Record<string, unknown>) => unknown

  beforeEach(() => {
    const loaded = registrations()
    runtime = loaded.runtime
    view = loaded.components.get('conversation.view')!
  })

  afterEach(() => {
    runtime.dispose()
  })

  /**
   * Render until the tree says what the test is waiting for. The page reads
   * asynchronously, so a single render is always the pre-fetch tree; re-rendering
   * is what a state update would do in a real renderer.
   */
  async function settle(props: Record<string, unknown>, predicate: (tree: unknown) => boolean) {
    let tree: unknown
    for (let attempt = 0; attempt < SETTLE_TRIES; attempt += 1) {
      tree = runtime.render(view, props)
      if (predicate(tree)) return tree
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
    }
    throw new Error(`the page never reached the expected state; last render was: ${textOf(tree)}`)
  }

  it('lists the projects the host reports, with their lane and today\'s spend', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe('/devloop/api/projects')
      return envelope({
        projects: [
          project({ id: 'aaaa11112222', name: 'super-paymaster', costUsdDay: 1.5, armed: true, revision: 7, taskCounts: { implementing: 2 } }),
          project({ id: 'bbbb33334444', name: 'how-to-make-money' }),
        ],
        registryError: null,
        global: { costUsdDay: 2.25, cap: 20 },
      })
    })

    const tree = await settle({}, (t) => textOf(t).includes('super-paymaster'))
    const text = textOf(tree)

    expect(text).toContain('how-to-make-money')
    expect(text).toContain('$2.25 of $20.00 today')
    expect(text).toContain('2 implementing')
    expect(text).toContain('Running')
    expect(text).toContain('Not started')
    expect(calls[0]).toEqual({ url: '/devloop/api/projects', method: 'GET', body: undefined })
  })

  it('sends pause with the revision the row was rendered from', async () => {
    const calls = stubFetch(() => envelope({
      projects: [project({ name: 'armed-project', armed: true, revision: 7, loop: 'running' })],
      global: { costUsdDay: 0, cap: null },
    }))

    const tree = await settle({}, (t) => textOf(t).includes('armed-project'))
    const pause = buttonsIn(tree).find((b) => b.label === 'Pause')
    expect(pause).toBeDefined()
    ;(pause!.props.onClick as () => void)()

    await vi.waitFor(() => { expect(calls.some((c) => c.method === 'POST')).toBe(true) })
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      url: '/devloop/api/projects/aaaa11112222/pause',
      method: 'POST',
      body: { revision: 7 },
    })
  })

  it('offers Resume instead of Pause once the loop is paused', async () => {
    stubFetch(() => envelope({
      projects: [project({ name: 'paused-project', armed: true, revision: 9, paused: true })],
      global: { costUsdDay: 0, cap: null },
    }))

    const tree = await settle({}, (t) => textOf(t).includes('paused-project'))
    const labels = buttonsIn(tree).map((b) => b.label)
    expect(labels).toContain('Resume')
    expect(labels).not.toContain('Pause')
    expect(textOf(tree)).toContain('Paused')
  })

  it('sends nothing when the row carries no revision, and says so', async () => {
    const calls = stubFetch(() => envelope({
      projects: [project({ name: 'unreadable', armed: true, revision: null })],
      global: { costUsdDay: 0, cap: null },
    }))

    const tree = await settle({}, (t) => textOf(t).includes('unreadable'))
    const pause = buttonsIn(tree).find((b) => b.label === 'Pause')!
    ;(pause.props.onClick as () => void)()

    const after = runtime.render(view, {})
    expect(textOf(after)).toContain('no readable revision')
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
  })

  it('arms an unarmed project with the goal the operator typed', async () => {
    const calls = stubFetch(() => envelope({
      projects: [project({ name: 'fresh-clone' })],
      global: { costUsdDay: 0, cap: null },
    }))

    const tree = await settle({}, (t) => textOf(t).includes('fresh-clone'))

    // The start button stays disabled until there is a goal to send.
    expect(buttonsIn(tree).find((b) => b.label === 'Start the loop')!.props.disabled).toBe(true)

    const field = textareaIn(tree)!
    ;(field.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'Ship the balance mode.' } })

    const typed = runtime.render(view, {})
    const start = buttonsIn(typed).find((b) => b.label === 'Start the loop')!
    expect(start.props.disabled).toBe(false)
    ;(start.props.onClick as () => void)()

    await vi.waitFor(() => { expect(calls.some((c) => c.method === 'POST')).toBe(true) })
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      url: '/devloop/api/projects/aaaa11112222/start',
      method: 'POST',
      body: { goal: 'Ship the balance mode.' },
    })
  })

  it('consumes a view request that names this view, and ignores one that does not', async () => {
    stubFetch(() => envelope({ projects: [project({ name: 'focused' })], global: { costUsdDay: 0, cap: null } }))

    const consumed = vi.fn()
    runtime.render(view, { viewRequest: { view: 'trajectory', focus: 'x' }, completeViewRequest: consumed })
    expect(consumed).not.toHaveBeenCalled()

    runtime.render(view, { viewRequest: { view: 'devloop', focus: 'aaaa11112222' }, completeViewRequest: consumed })
    expect(consumed).toHaveBeenCalledTimes(1)
  })

  it('reports a refusal in the host\'s own words', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 422,
      json: async () => ({ ok: false, error: { code: 'refused', message: 'this project has no .devloop/GOAL.md' } }),
    }))

    const tree = await settle({}, (t) => textOf(t).includes('no .devloop/GOAL.md'))
    expect(textOf(tree)).toContain('this project has no .devloop/GOAL.md')
  })
})
