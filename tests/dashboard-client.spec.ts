import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Offline contract check for dashboard/client.js, the Harness client-module
 * bundle: evaluated against a stub loader, `slots` service, and React, the
 * same way the real Harness composes and runs it. The bundle is plain
 * browser JavaScript, not compiled TypeScript, so nothing else in this suite
 * exercises it — a broken registration would otherwise surface only after a
 * Desktop/profile restart.
 */

const CLIENT = fileURLToPath(new URL('../dashboard/client.js', import.meta.url))
const StubReact = {
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props: props || {}, children }),
  useState: (initial: unknown) => [initial, () => {}],
}

function loadClient() {
  let registration: { id: string; factory: (require: (s: string) => unknown) => { apply: (ctx: unknown) => void; inject: string[] } } | undefined
  const opened: unknown[][] = []
  const stubWindow = { __ModuleLoader__: { load: (r: typeof registration) => { registration = r } }, open: (...a: unknown[]) => opened.push(a) }
  new Function('window', readFileSync(CLIENT, 'utf8'))(stubWindow)
  if (!registration) throw new Error('client.js did not call window.__ModuleLoader__.load')
  return { registration, opened }
}

describe('dashboard/client.js: the Harness client-module bundle', () => {
  it('registers under the package name, requires only react, and exports apply/inject', () => {
    const { registration } = loadClient()
    expect(registration.id).toBe('@jhfnetboy/dsh-devloop')
    const face = registration.factory((s) => {
      if (s === 'react') return StubReact
      throw new Error(`unexpected require: ${s}`)
    })
    expect(typeof face.apply).toBe('function')
    expect(face.inject).toEqual(['slots'])
  })

  it('registers a sidebar.footer.action button that opens the dashboard', () => {
    const { registration, opened } = loadClient()
    const face = registration.factory((s) => (s === 'react' ? StubReact : (() => { throw new Error(s) })()))
    const calls: { kind: string; name: string; id?: string }[] = []
    let component: ((props: Record<string, unknown>) => { type: string; props: Record<string, unknown> }) | undefined
    face.apply({
      slots: {
        inject: (name: string, cb: () => void) => { calls.push({ kind: 'inject', name }); return cb() },
        register: (o: { name: string; id?: string }, c: typeof component) => { calls.push({ kind: 'register', name: o.name, id: o.id }); component = c; return () => {} },
      },
    })

    expect(calls).toEqual([{ kind: 'inject', name: 'sidebar.footer.action' }, { kind: 'register', name: 'sidebar.footer.action', id: 'devloop-dashboard' }])

    for (const wide of [true, false]) {
      const button = component!({ wide })
      expect(button.type).toBe('button')
      expect(button.props['aria-label']).toBe('DevLoop')
      ;(button.props.onClick as () => void)()
      const [path, target] = opened.at(-1) as [string, string]
      expect(path).toBe('/devloop/')
      expect(target).toBe('_blank')
    }
  })
})
