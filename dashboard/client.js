/**
 * The DevLoop client half: a sidebar button that opens the dashboard.
 *
 * Two facts shape it:
 *
 * - The dashboard is a route on this same Harness origin (`/devloop/`), and DSH
 *   Desktop's `isTrustedAppUrl` treats every `127.0.0.1` / `localhost` URL as
 *   trusted. It therefore allows the window instead of handing the URL to the
 *   system browser, so the dashboard opens as an app window.
 * - It is opened as a window rather than embedded: the dashboard answers with
 *   `x-frame-options: DENY` and `frame-ancestors 'none'`, so an iframe would be
 *   refused. That is the dashboard's own choice, not something to work around.
 *
 * Plain browser JavaScript: the client module loader evaluates this verbatim, so
 * there is no TypeScript, no JSX, and no bundler in the path.
 */
window.__ModuleLoader__.load({
  id: '@jhfnetboy/dsh-devloop',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const DASHBOARD_PATH = '/devloop/'

    /** The glyph: an open loop, the cycle the factory is named for. */
    function LoopMark(props) {
      const size = props.size
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
        },
        React.createElement('path', {
          d: 'M13.4 7.9a5.5 5.5 0 1 1-1.62-3.9',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
        React.createElement('path', {
          d: 'M13.6 1.8v3.4h-3.4',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /**
     * The footer entry.
     *
     * `wide` is supplied by the sidebar's own `renderSlot` call and says whether
     * the sidebar is expanded, so this follows the rail without reading layout
     * state of its own. The rail size, radius, and hover fill mirror the sibling
     * entry the Cordis panel already registers into this same slot, and every
     * colour comes from the sidebar's own theme variables — so this needs no
     * stylesheet and follows both themes.
     */
    function DevloopDashboardAction(props) {
      const wide = props.wide === true
      const [hover, setHover] = React.useState(false)

      const style = wide
        ? {
            boxSizing: 'border-box',
            cursor: 'pointer',
            border: '0.5px solid var(--dsw-alias-border-l3)',
            background: hover
              ? 'var(--dsw-alias-button-floating-hover)'
              : 'var(--dsw-alias-button-elevated-fill)',
            height: 28,
            color: 'var(--dsw-alias-label-secondary)',
            borderRadius: 999,
            flex: 'none',
            display: 'inline-flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: 6,
            padding: '0 10px',
            font: 'inherit',
            fontSize: 12,
            lineHeight: '16px',
            whiteSpace: 'nowrap',
          }
        : {
            cursor: 'pointer',
            width: 28,
            height: 28,
            color: 'var(--dsw-alias-label-secondary)',
            background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
            border: 'none',
            borderRadius: 999,
            flex: 'none',
            display: 'inline-flex',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 0,
          }

      return React.createElement(
        'button',
        {
          type: 'button',
          style,
          title: 'DevLoop',
          'aria-label': 'DevLoop',
          onClick: () => {
            window.open(DASHBOARD_PATH, '_blank', 'noopener,noreferrer')
          },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
        },
        React.createElement(LoopMark, { size: wide ? 14 : 16 }),
        wide
          ? React.createElement(
              'span',
              { style: { display: 'inline-block' } },
              'DevLoop',
            )
          : null,
      )
    }

    const inject = ['slots']

    /**
     * Registered inside `ctx.slots.inject`, so the occupant belongs to this
     * fiber and is removed on stop/update with nothing left behind. The slot
     * is `list`, which is why it needs an `id`.
     */
    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'devloop-dashboard',
            order: 100,
            label: 'DevLoop',
          },
          DevloopDashboardAction,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
