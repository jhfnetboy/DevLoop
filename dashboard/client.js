/**
 * The DevLoop client half: a page in the conversation's view area, plus the
 * sidebar launcher for the standalone dashboard.
 *
 * Two surfaces, because they answer different needs:
 *
 * - `conversation.view` — a tab beside Chat and Trajectory that renders the whole
 *   main area. This is the native surface: the projects and their loops, read
 *   from the same `/devloop/api/*` routes the standalone page uses. It cannot be
 *   an iframe of that page, because the page answers with `x-frame-options: DENY`
 *   and `frame-ancestors 'none'`; the view is real React against the same API.
 * - `sidebar.footer.action` — a launcher for `/devloop/` in an app window, for
 *   the parts of the standalone page the view does not cover (goal gates,
 *   registering a repository, cleanup).
 *
 * The entry does not switch to the view, and cannot: see the note beside its
 * component for the slot-system reason, so nobody re-attempts it. The view is
 * reached by its tab.
 *
 * The window rather than the system browser: the dashboard is a route on this
 * same Harness origin, and DSH Desktop's `isTrustedAppUrl` treats every
 * `127.0.0.1` / `localhost` URL as trusted, so it is allowed in-app.
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
    const VIEW_ID = 'devloop'
    const PROJECTS_PATH = `${DASHBOARD_PATH}api/projects`
    /** Fast enough to watch a loop move, slow enough to leave the host alone. */
    const POLL_MS = 5000

    // ---- transport ----------------------------------------------------------
    //
    // Same-origin `fetch`: the page already carries the Harness auth cookie and
    // these routes live on this origin, so fetch's default `same-origin`
    // credentials are exactly right and there is no RPC surface to build.
    //
    // Both failure shapes have to be read: a refusal carries
    // `{ ok: false, error: { code, message } }` with a useful message, while a
    // transport failure has no body at all.

    /** Read the `value` of a DevLoop JSON envelope, or throw its own message. */
    async function readValue(response) {
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`DevLoop answered ${String(response.status)} with no readable body.`)
      }
      const refused = payload !== null && typeof payload === 'object' ? payload.error : undefined
      if (payload !== null && typeof payload === 'object' && payload.ok === false) {
        const message = refused !== null && typeof refused === 'object' ? refused.message : undefined
        throw new Error(typeof message === 'string' && message !== '' ? message : 'DevLoop refused that.')
      }
      if (!response.ok) throw new Error(`DevLoop answered ${String(response.status)}.`)
      return payload === null || typeof payload !== 'object' ? undefined : payload.value
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    async function readProjects() {
      return readValue(await fetch(PROJECTS_PATH))
    }

    /**
     * Run one operator verb.
     *
     * `revision` is not optional: a write is always a reply to a particular
     * state, and the host rejects one without it. The caller passes the
     * revision its row was rendered from, so a stale click is refused instead of
     * landing on a state the operator never saw.
     */
    async function runVerb(projectId, verb, body) {
      return readValue(await fetch(`${PROJECTS_PATH}/${projectId}/${verb}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }))
    }

    // ---- presentation -------------------------------------------------------
    //
    // Every colour is a Harness theme variable, so this follows both themes and
    // ships no stylesheet. Geometry follows the app's own rows: 12px radius,
    // half-pixel hairline borders, 8px rhythm.

    const HAIRLINE = '0.5px solid var(--dsw-alias-border-l3)'

    const STYLES = {
      page: {
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        height: '100%',
        overflowY: 'auto',
        padding: '16px 20px 24px',
        color: 'var(--dsw-alias-label-primary)',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
      },
      title: {
        fontSize: 15,
        fontWeight: 600,
        margin: 0,
      },
      muted: {
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12,
      },
      spacer: { flex: 1 },
      card: {
        boxSizing: 'border-box',
        border: HAIRLINE,
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-elevated, transparent)',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      },
      cardFocused: {
        boxShadow: '0 0 0 1px var(--dsw-alias-label-tertiary, var(--dsw-alias-border-l3))',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      },
      name: { fontSize: 14, fontWeight: 600 },
      root: {
        fontFamily: 'var(--ds-font-family-code, monospace)',
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)',
        overflowWrap: 'anywhere',
      },
      chip: {
        border: HAIRLINE,
        borderRadius: 999,
        padding: '1px 8px',
        fontSize: 11,
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
      },
      banner: {
        border: HAIRLINE,
        borderRadius: 10,
        padding: '8px 12px',
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-interactive-bg-hover, transparent)',
      },
      goal: {
        boxSizing: 'border-box',
        width: '100%',
        minHeight: 56,
        resize: 'vertical',
        borderRadius: 10,
        border: HAIRLINE,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 13,
        padding: '8px 10px',
      },
    }

    /** A button in the app's idiom; `tone` only changes emphasis, never layout. */
    function buttonStyle(tone) {
      const base = {
        boxSizing: 'border-box',
        cursor: 'pointer',
        border: HAIRLINE,
        borderRadius: 10,
        height: 28,
        padding: '0 12px',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '16px',
        whiteSpace: 'nowrap',
        flex: 'none',
      }
      if (tone === 'primary') {
        return {
          ...base,
          color: 'var(--dsw-alias-label-primary)',
          background: 'var(--dsw-alias-button-elevated-fill, transparent)',
        }
      }
      return {
        ...base,
        color: 'var(--dsw-alias-label-secondary)',
        background: 'transparent',
      }
    }

    function Button(props) {
      return React.createElement(
        'button',
        {
          type: 'button',
          style: buttonStyle(props.tone),
          disabled: props.disabled === true,
          title: props.title,
          onClick: props.onClick,
        },
        props.children,
      )
    }

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
     * What an operator should read first about one project.
     *
     * Ordered the way a reader scans: something is wrong, or the loop is not
     * doing what they last asked, before it is doing what they asked.
     */
    function statusOf(project) {
      if (project.error !== null && project.error !== undefined) {
        return { label: 'Cannot read this project', tone: 'bad' }
      }
      if (project.armed !== true) {
        return { label: project.loop === 'running' ? 'Not started' : 'No loop here', tone: 'idle' }
      }
      if (project.completed === true) return { label: 'Goal complete', tone: 'good' }
      if (project.paused === true) return { label: 'Paused', tone: 'idle' }
      if (project.halted === true) return { label: 'Halted', tone: 'bad' }
      if (project.loop !== 'running') return { label: 'Running elsewhere', tone: 'idle' }
      return { label: 'Running', tone: 'good' }
    }

    function money(value) {
      return typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}` : null
    }

    /** Tasks by state, as one compact line; empty states are not worth a chip. */
    function taskLine(counts) {
      if (counts === null || typeof counts !== 'object') return null
      const parts = []
      for (const [state, count] of Object.entries(counts)) {
        if (typeof count === 'number' && count > 0) parts.push(`${String(count)} ${state}`)
      }
      return parts.length === 0 ? null : parts.join(' · ')
    }

    function ProjectCard(props) {
      const project = props.project
      const busy = props.busy
      const status = statusOf(project)
      const [goal, setGoal] = React.useState('')

      const idle = busy !== null
      const chips = []
      const taskText = taskLine(project.taskCounts)
      if (taskText !== null) chips.push(taskText)
      const today = money(project.costUsdDay)
      if (today !== null) chips.push(`${today} today`)
      if (project.own === true) chips.push('own root')

      const children = [
        React.createElement(
          'div',
          { key: 'head', style: STYLES.row },
          React.createElement('span', { style: { ...STYLES.name, display: 'inline-flex', alignItems: 'center', gap: 6 } },
            React.createElement(LoopMark, { size: 13 }),
            project.name,
          ),
          React.createElement('span', { style: STYLES.chip }, status.label),
          React.createElement('span', { style: STYLES.spacer }),
          project.armed === true
            ? React.createElement(Button, {
                key: 'toggle',
                disabled: idle,
                onClick: () => props.onVerb(project, project.paused === true ? 'resume' : 'pause'),
              }, busy === project.id ? '…' : (project.paused === true ? 'Resume' : 'Pause'))
            : null,
        ),
        React.createElement('div', { key: 'root', style: STYLES.root }, project.root),
      ]

      // Halt reasons are the loop's own words for why it stopped, so they are
      // shown verbatim rather than mapped to prose this file would have to own.
      if (Array.isArray(project.haltReasons) && project.haltReasons.length > 0) {
        children.push(React.createElement('div', { key: 'halts', style: STYLES.banner }, project.haltReasons.join(' · ')))
      }
      if (project.error !== null && project.error !== undefined) {
        children.push(React.createElement('div', { key: 'error', style: STYLES.banner }, String(project.error)))
      }
      if (project.question !== null && project.question !== undefined) {
        children.push(React.createElement('div', { key: 'question', style: STYLES.banner },
          'Waiting on you: ', String(project.question)))
      }
      if (chips.length > 0) {
        children.push(React.createElement(
          'div',
          { key: 'chips', style: STYLES.row },
          chips.map((text, index) => React.createElement('span', { key: index, style: STYLES.chip }, text)),
        ))
      }

      // Arming is creating `.devloop/GOAL.md`, and it is the only action here
      // that needs text, so it is the one place this card grows a field.
      if (project.armed !== true && project.error === null) {
        children.push(React.createElement('textarea', {
          key: 'goal',
          style: STYLES.goal,
          value: goal,
          placeholder: 'The goal for this repository, in a sentence or two…',
          disabled: idle,
          onChange: (event) => setGoal(event.target.value),
        }))
        children.push(React.createElement(
          'div',
          { key: 'start', style: STYLES.row },
          React.createElement(Button, {
            tone: 'primary',
            disabled: idle || goal.trim() === '',
            onClick: () => props.onStart(project, goal),
          }, 'Start the loop'),
          React.createElement('span', { style: STYLES.muted }, 'Creates .devloop/GOAL.md'),
        ))
      }

      return React.createElement('section', {
        style: props.focused === true ? { ...STYLES.card, ...STYLES.cardFocused } : STYLES.card,
      }, children)
    }

    /**
     * The DevLoop page.
     *
     * It polls rather than subscribing: the loops already write their state to
     * `<root>/.devloop/`, and the projects route is the read model over it, so
     * there is nothing to subscribe to that would not be a second cache of the
     * same fact.
     */
    function DevloopView(props) {
      const [snapshot, setSnapshot] = React.useState({ loading: true, error: null, projects: [], global: null, at: null })
      const [busy, setBusy] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [focus, setFocus] = React.useState(null)

      const read = React.useCallback(async () => {
        try {
          const value = await readProjects()
          const projects = value !== null && typeof value === 'object' && Array.isArray(value.projects) ? value.projects : []
          const global = value !== null && typeof value === 'object' ? value.global : null
          setSnapshot({ loading: false, error: null, projects, global, at: Date.now() })
        } catch (error) {
          setSnapshot((previous) => ({ ...previous, loading: false, error: messageOf(error) }))
        }
      }, [])

      React.useEffect(() => {
        let live = true
        const tick = () => { if (live) void read() }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => {
          live = false
          clearInterval(timer)
        }
      }, [read])

      // A view request names this view and a focus; consuming it means handling
      // it and clearing it, so a later render does not re-apply a stale request.
      const request = props.viewRequest
      const completeRequest = props.completeViewRequest
      React.useEffect(() => {
        if (request === null || request === undefined || request.view !== VIEW_ID) return
        setFocus(request.focus === undefined ? null : request.focus)
        if (typeof completeRequest === 'function') completeRequest()
      }, [request, completeRequest])

      /** One verb, then a refresh, so the row the operator clicked is re-read. */
      const act = React.useCallback(async (project, verb, body) => {
        setBusy(project.id)
        setFailure(null)
        try {
          await runVerb(project.id, verb, body)
        } catch (error) {
          setFailure(`${verb} on ${project.name}: ${messageOf(error)}`)
        } finally {
          setBusy(null)
          void read()
        }
      }, [read])

      const onVerb = React.useCallback((project, verb) => {
        // The revision the row was rendered from, which is what makes a stale
        // click a refusal rather than a write against unseen state.
        if (typeof project.revision !== 'number') {
          setFailure(`${project.name} has no readable revision, so nothing was sent.`)
          return
        }
        void act(project, verb, { revision: project.revision })
      }, [act])

      const onStart = React.useCallback((project, goal) => {
        void act(project, 'start', { goal })
      }, [act])

      const projects = snapshot.projects
      const spent = snapshot.global !== null && typeof snapshot.global === 'object' ? money(snapshot.global.costUsdDay) : null
      const cap = snapshot.global !== null && typeof snapshot.global === 'object' ? money(snapshot.global.cap) : null

      const meta = []
      meta.push(`${String(projects.length)} project${projects.length === 1 ? '' : 's'}`)
      if (spent !== null) meta.push(cap === null ? `${spent} today` : `${spent} of ${cap} today`)
      if (snapshot.at !== null) {
        meta.push(`read ${new Date(snapshot.at).toLocaleTimeString()}`)
      }

      const children = [
        React.createElement(
          'header',
          { key: 'header', style: STYLES.header },
          React.createElement('h2', { style: STYLES.title }, 'DevLoop'),
          React.createElement('span', { style: STYLES.muted }, meta.join(' · ')),
          React.createElement('span', { style: STYLES.spacer }),
          React.createElement(Button, { key: 'refresh', disabled: snapshot.loading, onClick: () => { void read() } }, 'Refresh'),
          React.createElement(Button, {
            key: 'open',
            title: 'Gates, repository registration, and cleanup live in the full dashboard',
            onClick: () => { window.open(DASHBOARD_PATH, '_blank', 'noopener,noreferrer') },
          }, 'Open dashboard'),
        ),
      ]

      if (failure !== null) {
        children.push(React.createElement(
          'div',
          { key: 'failure', style: STYLES.banner },
          failure,
          ' ',
          React.createElement('button', {
            type: 'button',
            style: { ...buttonStyle('quiet'), height: 'auto', padding: 0, border: 'none', textDecoration: 'underline' },
            onClick: () => setFailure(null),
          }, 'Dismiss'),
        ))
      }
      if (snapshot.error !== null) {
        children.push(React.createElement('div', { key: 'error', style: STYLES.banner }, snapshot.error))
      }

      if (projects.length === 0) {
        children.push(React.createElement(
          'div',
          { key: 'empty', style: STYLES.card },
          React.createElement('span', { style: STYLES.muted },
            snapshot.loading
              ? 'Reading projects…'
              : 'No projects yet. Add one from the dashboard, then its goal here.'),
        ))
      } else {
        children.push(React.createElement(
          'div',
          { key: 'cards', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          projects.map((project) => React.createElement(ProjectCard, {
            key: project.id,
            project,
            busy,
            focused: focus !== null && project.id === focus,
            onVerb,
            onStart,
          })),
        ))
      }

      return React.createElement('div', { style: STYLES.page }, children)
    }

    /**
     * Bring the DevLoop view forward by pressing its tab.
     *
     * The slot system offers no way to select a view from outside the
     * conversation. The rendered view is the conversation store's `view` field —
     * `ConversationSession` renders `only: resolveActiveView(tabs, useStore((s) =>
     * s.view)).id` — and only `selectView`/`openView` set it. Both are injected by
     * `conversation.session`'s own registration; the slot catalogue states that an
     * occupant outside that subtree receives **no owner-specific values**, and a
     * sidebar occupant is handed only `startSession` and `toggleSidebar`.
     * `uiConversation.binding(id).activate(id)` looks like the missing piece and
     * is not: it activates an assembler target and leaves `view` untouched, so it
     * closes nothing and switches nothing.
     *
     * So this presses the tab the way an operator would, addressed through the
     * accessible contract the tab strip publishes — a `role="tablist"` holding
     * `role="tab"` buttons labelled with each view's registered label — rather
     * than through any styling class. It is the same interaction a click is, and
     * it fails closed: with no such tab it returns false and the caller opens the
     * page instead, which is also the answer for a blank conversation (its view
     * area renders nothing) and for a profile where the view is not registered.
     *
     * @returns whether the tab was pressed.
     */
    function pressDevloopTab() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return false
      for (const tab of document.querySelectorAll('[role="tablist"] [role="tab"]')) {
        if (tab.textContent === null || tab.textContent.trim() !== 'DevLoop') continue
        if (typeof tab.click !== 'function') return false
        tab.click()
        return true
      }
      return false
    }

    /**
     * The footer entry: it leads to the view, and falls back to the page.
     *
     * Pressing the tab is what makes the view reachable from anywhere in the app.
     * The standalone page stays for what the view does not cover — goal gates,
     * registering a repository, cleanup — and as the fallback wherever there is
     * no tab to press.
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
            if (pressDevloopTab()) return
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
     * Registered inside `ctx.slots.inject`, so each occupant belongs to this
     * fiber and is removed on stop/update with nothing left behind. Both slots
     * are `list`, which is why both need an `id`.
     *
     * `order: 20` puts the page after the app's own Chat (0) and Trajectory (10).
     */
    function apply(ctx) {
      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register(
          {
            name: 'conversation.view',
            id: VIEW_ID,
            order: 20,
            label: 'DevLoop',
          },
          DevloopView,
        ),
      )
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
