// DevLoop dashboard.
//
// Everything a project reports is model-influenced text: task titles, gate
// evidence, GOAL.md, PROGRESS.md. It is only ever placed with textContent
// (via `el`), never parsed as markup, and the page CSP forbids inline script.
'use strict'

const API = '/devloop/api'
const REFRESH_MS = 5000

// Labels are looked up when drawn, so a language switch reaches them (strings: i18n.js).
const STATUS_TONE = { ready: '', running: 'accent', review_pending: 'accent', merge_ready: 'ok', rework: 'warn', blocked: 'bad', done: 'ok', failed: 'bad' }
const STATUS = new Proxy({}, { get: (_, key) => (key in STATUS_TONE ? [t(`status.${String(key)}`), STATUS_TONE[key]] : undefined) })
const LOOP_TONE = { running: 'ok', stopped: 'bad', elsewhere: '' }
const LOOP = new Proxy({}, { get: (_, key) => (key in LOOP_TONE ? [t(`loop.${String(key)}`), LOOP_TONE[key]] : undefined) })
const STATUS_ORDER = ['running', 'review_pending', 'merge_ready', 'rework', 'ready', 'blocked', 'failed', 'done']

function el(tag, attrs, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'href') node.setAttribute('href', value)
    else node.setAttribute(key, String(value))
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

function badge(label, tone, plain) {
  return el('span', { class: `badge ${tone || ''} ${plain ? 'plain' : ''}` }, label)
}

function time(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(locale(), { hour12: false })
}

// How long since `iso`, as a duration ("43 min"); empty when unknown.
function since(iso) {
  if (!iso) return ''
  // Clamped: a clock a little ahead of this one would otherwise read as "-3 s".
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (!Number.isFinite(s)) return ''
  if (s < 60) return t('dur.s', { n: s })
  if (s < 3600) return t('dur.m', { n: Math.round(s / 60) })
  if (s < 86400) return t('dur.h', { n: Math.round(s / 3600) })
  return t('dur.d', { n: Math.round(s / 86400) })
}

function ago(iso) {
  const d = since(iso)
  return d ? t('ago', { d }) : ''
}

function usd(n) {
  return typeof n === 'number' ? `$${n.toFixed(n < 1 ? 4 : 2)}` : '—'
}

// Writes carry the revision the page was showing. If the loop moved on in the
// meantime the server refuses (409), because the operator decided about a
// state that no longer exists.
async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed = await res.json().catch(() => null)
  if (res.status === 401) throw new Error(t('err.login'))
  if (!parsed || !parsed.ok) {
    const error = new Error((parsed && parsed.error && parsed.error.message) || `HTTP ${res.status}`)
    error.code = parsed && parsed.error && parsed.error.code
    throw error
  }
  return parsed.value
}

async function getJson(path) {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' })
  if (res.status === 401) throw new Error(t('err.loginHint'))
  const body = await res.json().catch(() => null)
  if (!body || !body.ok) throw new Error((body && body.error && body.error.message) || `HTTP ${res.status}`)
  return body.value
}

// ---- views ----------------------------------------------------------------

function loopBadges(p) {
  const out = []
  const [loopLabel, loopTone] = LOOP[p.loop] || [p.loop, '']
  // A halt outranks whatever the process timer is doing: "running" next to
  // "halted" would ask the reader to work out which one to believe.
  if (!p.armed) out.push(badge(t('badge.unarmed'), ''))
  else if (p.completed) out.push(badge(t('badge.completed'), 'ok'))
  else if (p.paused) out.push(badge(t('badge.paused'), 'warn'))
  else if (p.halted) out.push(badge(t('badge.halted'), 'bad'))
  else out.push(badge(loopLabel, loopTone))
  if (p.armed && p.halted && p.loop === 'elsewhere') out.push(badge(loopLabel, '', true))
  if (p.question) out.push(badge(t('badge.question'), 'warn'))
  if (p.error) out.push(badge(t('badge.unreadable'), 'bad'))
  return out
}

function countPills(counts) {
  return STATUS_ORDER
    .filter(s => counts[s])
    .map(s => badge(`${(STATUS[s] || [s])[0]} ${counts[s]}`, (STATUS[s] || [])[1], true))
}

// The home page's columns, in the order a person should look at them.
const LANES = ['needs_you', 'running', 'idle', 'done']

const DOING = new Set(['plan', 'delegate', 'review', 'merge'])

// One sentence: what happens next, or what it is waiting for. The question itself, when there is one.
function nextStep(p) {
  if (p.error) return null
  if (p.lane === 'needs_you') return p.question ? null : t('next.stopped')
  if (!p.armed) return t('next.unarmed')
  if (p.lane === 'done') return t('next.done')
  if (p.paused) return t('next.paused', { resume: t('btn.resume') })
  if (p.lane === 'idle') return t('next.left')
  const [verb, task] = String(p.lastAction || '').split(':')
  return DOING.has(verb) ? t(`doing.${verb}`, { task: task || '' }) : t('next.tick')
}

function projectCard(p) {
  const total = Object.values(p.taskCounts || {}).reduce((a, b) => a + b, 0)
  const next = nextStep(p)
  return el('a', { class: 'card', href: `#/p/${p.id}` },
    el('h2', {}, p.name, p.own ? el('span', { class: 'muted' }, t('card.own')) : null),
    el('div', { class: 'path' }, p.root),
    el('div', { class: 'row' }, loopBadges(p)),
    next ? el('div', { class: 'next' }, next) : null,
    p.question ? el('div', { class: 'question' }, p.question) : null,
    p.since && p.lane !== 'running' && since(p.since) ? el('div', { class: 'muted since' }, p.lane === 'done' ? t('since.done', { ago: ago(p.since) }) : t('since.waiting', { d: since(p.since) })) : null,
    p.error ? el('div', { class: 'question' }, p.error) : null,
    total ? el('div', { class: 'row' }, countPills(p.taskCounts)) : null,
    p.armed ? el('div', { class: 'kv' },
      el('span', {}, t('card.lastAction'), el('b', {}, p.lastAction || '—')),
      el('span', {}, t('card.costToday'), el('b', {}, usd(p.costUsdDay))),
      el('span', {}, t('card.updated'), el('b', {}, ago(p.updatedAt) || '—')),
    ) : null,
  )
}

function renderHome(value) {
  const parts = [flashNode()]
  const g = value.global
  if (g && g.cap !== null && g.costUsdDay >= g.cap) {
    parts.push(el('div', { class: 'banner bad' },
      t('home.capReached', { spent: usd(g.costUsdDay), cap: usd(g.cap) })))
  }
  if (value.registryError) parts.push(el('div', { class: 'banner' }, t('home.registryError', { error: value.registryError })))
  // What needs the operator comes first; the guide and the picker move below once there is anything to show.
  const setup = [guidePanel(), addProjectPanel()]
  if (!value.projects.length) {
    parts.push(...setup, el('div', { class: 'empty' }, t('home.empty', { browse: t('btn.browse') })))
  }
  for (const lane of LANES) {
    // A lane this page does not know (a newer server) is shown as needing a look rather than dropped or called fine.
    const here = value.projects.filter(p => (LANES.includes(p.lane) ? p.lane : 'needs_you') === lane)
    if (!here.length) continue
    parts.push(el('section', { class: `lane lane-${lane}` },
      el('h2', {}, t(`lane.${lane}`), el('span', { class: 'count' }, String(here.length))),
      el('p', { class: 'muted' }, t(`lane.${lane}.hint`)),
      el('div', { class: 'grid' }, here.map(projectCard))))
  }
  if (value.projects.length) parts.push(...setup)
  if (g) {
    parts.push(el('p', { class: 'note' }, t('home.spent', { spent: usd(g.costUsdDay) }),
      g.cap !== null ? t('home.cap', { cap: usd(g.cap) }) : t('home.noCap'),
      t('home.costNote')))
  }
  return parts
}

// The picker's state lives here rather than in the DOM, because a refresh
// rebuilds the page; while it is open the refresh holds off (see `editing`).
const picker = { open: false, path: [], listing: null, loading: false, error: null, selected: null, seq: 0 }

async function browseTo(path) {
  // Two quick clicks can answer out of order; only the last one may land, or
  // the crumbs would name one directory while the list shows another.
  const seq = ++picker.seq
  Object.assign(picker, { open: true, path, loading: true, error: null, selected: null })
  redrawPicker()
  let listing = null
  let error = null
  try {
    listing = await getJson(`${API}/browse?path=${encodeURIComponent(path.join('/'))}`)
  } catch (failure) {
    error = failure.message
  }
  if (seq !== picker.seq) return
  Object.assign(picker, { listing, error, loading: false })
  redrawPicker()
}

function closePicker() {
  // Bumping seq also drops a listing still in flight.
  Object.assign(picker, { open: false, path: [], listing: null, loading: false, error: null, selected: null, seq: picker.seq + 1 })
}

function redrawPicker() {
  const panel = document.getElementById('add-panel')
  if (panel) panel.replaceWith(addProjectPanel())
}

function addProject(root) {
  return async () => {
    if (!root) throw new Error(t('add.pickFirst'))
    const value = await postJson(`${API}/projects`, { root })
    closePicker()
    return { text: t('add.done', { root: value.root }) }
  }
}

function addProjectPanel() {
  const note = el('p', { class: 'note' }, t('add.note'))
  if (!picker.open) {
    const open = el('button', { type: 'button', class: 'btn primary' }, t('btn.browse'))
    open.addEventListener('click', () => void browseTo([]))
    return el('section', { class: 'panel add', id: 'add-panel' },
      el('h3', {}, t('add.title')), el('div', { class: 'actions' }, open), note)
  }

  const listing = picker.listing
  const top = listing ? listing.root.split('/').filter(Boolean).pop() || '/' : '…'
  const crumbs = [top, ...picker.path].map((name, depth) => {
    if (depth === picker.path.length) return el('b', {}, name)
    const link = el('button', { type: 'button', class: 'crumb' }, name)
    link.addEventListener('click', () => void browseTo(picker.path.slice(0, depth)))
    return link
  })

  let body
  if (picker.loading) body = el('p', { class: 'muted' }, t('add.reading'))
  else if (picker.error) body = el('div', { class: 'banner bad' }, picker.error)
  else if (!listing.entries.length) body = el('p', { class: 'muted' }, t('add.empty'))
  else {
    body = el('div', { class: 'picker-list' }, listing.entries.map((entry) => {
      const selected = picker.selected === entry.root
      const row = el('button', {
        type: 'button',
        class: `pick-row ${entry.repo ? 'repo' : 'folder'} ${selected ? 'selected' : ''}`,
        disabled: entry.registered,
        title: entry.root,
      },
      el('span', { class: 'pick-icon' }, entry.repo ? '⎇' : '▸'),
      el('span', { class: 'pick-name' }, entry.name),
      entry.registered ? badge(t('add.added'), 'ok', true) : entry.repo ? badge(t('add.repo'), 'accent', true) : el('span', { class: 'muted' }, t('add.open')))
      row.addEventListener('click', () => {
        if (!entry.repo) return void browseTo([...picker.path, entry.name])
        picker.selected = selected ? null : entry.root
        redrawPicker()
      })
      return row
    }))
  }

  const add = actionButton(t('add.add'), 'primary', null, addProject(picker.selected))
  add.disabled = !picker.selected
  const cancel = el('button', { type: 'button', class: 'btn' }, t('btn.cancel'))
  cancel.addEventListener('click', () => { closePicker(); void load(true) })

  return el('section', { class: 'panel add', id: 'add-panel' },
    el('h3', {}, t('add.title')),
    el('div', { class: 'crumbs' }, crumbs.flatMap((c, i) => i ? [el('span', { class: 'muted' }, ' / '), c] : [c])),
    listing ? el('div', { class: 'path' }, [listing.root, ...picker.path].join('/')) : null,
    body,
    listing && listing.truncated ? el('p', { class: 'note' }, t('add.truncated')) : null,
    el('div', { class: 'actions' },
      add, cancel,
      el('span', { class: 'path selected-path' }, picker.selected || t('add.pickHint'))),
    note)
}

// Blocking checks refuse a start (the server refuses it too); the rest advise.
function readinessPanel(r) {
  if (!r) return el('div', { class: 'banner bad' }, t('start.unreadable', { recheck: t('start.recheck') }))
  return el('div', { class: 'readiness' },
    el('div', { class: 'readiness-head' },
      r.ready ? badge(t('start.ready'), 'ok') : badge(t('start.fixRed'), 'bad'),
      el('span', { class: 'muted' }, t('start.trunk', { base: r.base }))),
    el('ul', { class: 'checks' }, r.checks.map(c => el('li', { class: c.ok ? 'ok' : c.blocking ? 'bad' : 'warn' },
      el('span', { class: 'mark' }, c.ok ? '✓' : c.blocking ? '✕' : '!'),
      el('span', { class: 'msg' }, c.message)))))
}

function startPanel(p) {
  const area = el('textarea', { class: 'goal-input', rows: '8', placeholder: t('start.placeholder') })
  area.value = goalDrafts.get(p.id) || ''
  area.addEventListener('input', () => goalDrafts.set(p.id, area.value))
  // Unknown is not ready: a readiness the server could not read is refused there too.
  const ready = Boolean(p.readiness && p.readiness.ready)
  const start = actionButton(t('start.button'), 'primary',
    t('start.confirm'),
    async () => {
      const goal = area.value.trim()
      if (!goal) throw new Error(t('start.emptyGoal'))
      await postJson(`${API}/projects/${p.id}/start`, { goal })
      goalDrafts.delete(p.id)
      return { text: t('start.done') }
    })
  start.disabled = !ready
  const recheck = el('button', { type: 'button', class: 'btn' }, t('start.recheck'))
  recheck.addEventListener('click', () => void load(true))
  return el('section', { class: 'panel start' },
    el('h3', {}, t('start.title')),
    el('p', {}, t('start.intro')),
    readinessPanel(p.readiness),
    area,
    el('div', { class: 'actions' }, start, recheck),
    el('p', { class: 'note' }, t('start.note')))
}

// A half-typed goal survives the rebuild that a failed start or a re-check causes.
const goalDrafts = new Map()

function removeButton(p) {
  if (p.own) return null
  if (p.armed && !p.halted) return null
  return actionButton(t('remove.button'), '',
    t('remove.confirm'),
    async () => {
      await postJson(`${API}/projects/${p.id}/unregister`, {})
      location.hash = '#/'
      return { text: t('remove.done', { name: p.name }) }
    })
}

// What an answer costs, in the words a person decides in. Empty for a server that does not say.
function impactText(o) {
  if (!o.impact) return ''
  if (!o.impact.spends && !o.impact.discards) return t('impact.free')
  return [o.impact.spends ? t('impact.spends') : t('impact.noSpend'), o.impact.discards ? t('impact.discards') : t('impact.keeps')].join(t('impact.sep'))
}

function answerRow(p, o, tone) {
  const label = STRINGS[`answer.${o.key}`] ? t(`answer.${o.key}`) : o.key
  const impact = impactText(o)
  return el('div', { class: 'option' },
    actionButton(label, tone, t('answer.confirm', { label, impact: impact || o.summary }),
      () => postJson(`${API}/projects/${p.id}/answer`, { revision: p.revision, choice: o.key })),
    el('span', {}, impact ? el('b', {}, impact) : null, impact ? el('br') : null, el('span', { class: 'muted' }, el('code', {}, o.key), ' ', o.summary)))
}

// One primary answer, with its cost said up front; the rest folded away. A gate
// whose only answer is to leave it leads with what the person has to do instead.
function gatePanel(p) {
  const g = p.gate
  if (!g) return null
  const options = g.options || []
  const primary = options.find(o => o.key === g.recommended) || null
  const rest = options.filter(o => o !== primary)
  return el('section', { class: 'panel gate' },
    el('h3', {}, t('badge.question')),
    el('p', { class: 'q' }, g.question),
    g.evidence && g.evidence.length ? el('ul', { class: 'plain' }, g.evidence.map(e => el('li', {}, e))) : null,
    !primary && g.manual ? el('div', { class: 'manual' }, el('b', {}, t('gate.manual')), g.manual) : null,
    primary ? el('div', { class: 'options' }, answerRow(p, primary, 'primary')) : null,
    rest.length ? (primary
      ? el('details', { class: 'more' }, el('summary', {}, t('gate.more', { n: rest.length })), el('div', { class: 'options' }, rest.map(o => answerRow(p, o, ''))))
      : el('div', { class: 'options' }, rest.map(o => answerRow(p, o, '')))) : null,
    primary && g.manual ? el('p', { class: 'note' }, g.manual) : null,
  )
}

function haltPanel(p) {
  if (p.completed && !p.supervisor) {
    return el('section', { class: 'panel' },
      el('h3', {}, t('halt.completed')),
      el('p', {}, t('halt.completedText')),
      el('p', { class: 'note' }, t('halt.completedNote')))
  }
  if (!p.halted && !p.supervisor) return null
  return el('section', { class: 'panel' },
    el('h3', {}, p.paused ? t('badge.paused') : t('halt.title')),
    p.haltReasons && p.haltReasons.length
      ? el('ul', { class: 'plain' }, p.haltReasons.map(r => el('li', {}, r)))
      : el('p', { class: 'muted' }, '—'),
    p.supervisor ? el('p', { class: 'note' }, p.supervisor.taskId ? t('halt.holdTask', { reason: p.supervisor.reason, task: p.supervisor.taskId }) : t('halt.hold', { reason: p.supervisor.reason })) : null,
    p.acknowledged ? el('p', { class: 'note' }, t('halt.acknowledged', { at: time(p.acknowledged.at) })) : null,
    el('div', { class: 'actions' },
      actionButton(t('btn.resume'), 'primary',
        p.paused ? t('halt.resumePaused') : t('halt.resumeHalted'),
        () => postJson(`${API}/projects/${p.id}/resume`, { revision: p.revision }))),
    el('p', { class: 'note' }, t('halt.cliNote')),
  )
}

// Who did what, as the route identities STATE records: the three-way split made visible.
function rolesLine(task) {
  const roles = [[t('role.planner'), task.planner], [t('role.implementer'), task.implementer], [t('role.reviewer'), task.reviewer]].filter(([, who]) => who)
  if (!roles.length) return null
  return el('div', { class: 'roles' }, roles.flatMap(([role, who], i) => [i ? ' · ' : '', `${role} `, el('span', { class: 'mono' }, who)]))
}

function tasksPanel(p) {
  if (!p.tasks.length) {
    return el('section', { class: 'panel' }, el('h3', {}, t('tasks.title')),
      el('p', { class: 'muted' }, p.armed ? t('tasks.none') : '—'))
  }
  const rows = p.tasks.map(task => {
    const [label, tone] = STATUS[task.status] || [task.status, '']
    return el('tr', {},
      el('td', { class: 'mono' }, task.id),
      el('td', { class: 'title-cell' }, task.title,
        task.allowedPaths && task.allowedPaths.length ? el('div', { class: 'path' }, task.allowedPaths.join('  ')) : null,
        task.acceptance && task.acceptance.length ? el('ul', { class: 'accept' }, task.acceptance.map(a => el('li', {}, a))) : null,
        rolesLine(task)),
      el('td', {}, badge(label, tone)),
      el('td', {}, task.tier),
      el('td', { class: 'num' }, task.attempts),
      el('td', { class: 'num' }, task.reviewCycles),
      el('td', {}, task.lastReviewVerdict || '—'),
    )
  })
  return el('section', { class: 'panel' },
    el('h3', {}, t('tasks.count', { n: p.tasks.length })),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['id', 'title', 'status', 'tier', 'attempts', 'reviews', 'verdict'].map(h => el('th', {}, t(`tasks.col.${h}`))))),
      el('tbody', {}, rows))))
}

function meter(used, cap) {
  const ratio = typeof used === 'number' && cap > 0 ? Math.min(used / cap, 1) : 0
  const fill = el('span', {})
  fill.style.width = `${Math.round(ratio * 100)}%` // CSSOM, which the CSP allows
  return el('div', { class: `meter ${ratio >= 1 ? 'over' : ''}` }, fill)
}

function budgetPanel(p) {
  if (!p.budget) return null
  const l = p.budget.limits
  return el('section', { class: 'panel' },
    el('h3', {}, t('budget.title')),
    el('div', {}, t('budget.session', { used: usd(p.costUsdSession), cap: usd(l.maxCostUsdPerSession) })), meter(p.costUsdSession, l.maxCostUsdPerSession),
    el('div', {}, t('budget.day', { used: usd(p.costUsdDay), cap: usd(l.maxCostUsdPerDay) })), meter(p.costUsdDay, l.maxCostUsdPerDay),
    el('div', { class: 'kv' },
      el('span', {}, t('budget.attempts'), el('b', {}, l.maxTaskAttempts)),
      el('span', {}, t('budget.reviews'), el('b', {}, l.maxReviewCycles)),
      el('span', {}, t('budget.noProgress'), el('b', {}, t('dur.m', { n: l.noProgressMinutes }))),
    ),
    el('p', { class: 'note' }, t('budget.note', { source: p.budget.source })),
  )
}

function eventsPanel(p) {
  return el('section', { class: 'panel' },
    el('h3', {}, t('events.title')),
    p.events.length
      ? el('ul', { class: 'events' }, p.events.map(e => el('li', {},
          el('span', { class: 'rev' }, `#${e.revision ?? '?'}`),
          el('span', {}, el('span', { class: 'mono' }, e.action || '—'), el('span', { class: 'when' }, time(e.at))))))
      : el('p', { class: 'muted' }, '—'))
}

// ---- markdown ---------------------------------------------------------------
//
// Planning documents are model-written, so this builds DOM nodes with `el`
// (text nodes only) and never parses markup: raw HTML in a document stays text.
// It covers what these documents use — headings, lists and checkboxes, tables,
// code, quotes — and shows anything else as plain text.

const MD_BLOCK = /^\s*(```|#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/

function mdInline(text) {
  const nodes = []
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))/g
  let last = 0
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    if (m[1]) nodes.push(el('code', {}, m[1].slice(1, -1)))
    else if (m[2]) nodes.push(el('b', {}, m[2].slice(2, -2)))
    else nodes.push(el('a', { href: m[4], target: '_blank', rel: 'noopener noreferrer' }, m[3].slice(1, m[3].indexOf(']'))))
    last = m.index + m[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function mdTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
}

function renderMarkdown(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*$/.test(line)) { i++; continue }
    if (/^\s*```/.test(line)) {
      const code = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++])
      i++
      out.push(el('pre', { class: 'md-code' }, code.join('\n')))
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      out.push(el(`h${Math.min(heading[1].length + 2, 6)}`, { class: 'md-h' }, mdInline(heading[2])))
      i++
      continue
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push(el('hr', {})); i++; continue }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = mdTableRow(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(mdTableRow(lines[i++]))
      out.push(el('div', { class: 'table-wrap' }, el('table', { class: 'md-table' },
        el('thead', {}, el('tr', {}, head.map(h => el('th', {}, mdInline(h))))),
        el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, mdInline(c)))))))))
      continue
    }
    const listItem = /^\s*([-*+]|\d+[.)])\s+(.*)$/
    if (listItem.test(line)) {
      const ordered = /^\s*\d/.test(line)
      const items = []
      while (i < lines.length && listItem.test(lines[i])) {
        const body = listItem.exec(lines[i])[2]
        const box = /^\[([ xX])\]\s+(.*)$/.exec(body)
        items.push(box
          ? el('li', { class: `md-task ${box[1] === ' ' ? '' : 'done'}` }, el('span', { class: 'md-box' }, box[1] === ' ' ? '☐' : '☑'), ' ', mdInline(box[2]))
          : el('li', {}, mdInline(body)))
        i++
      }
      out.push(el(ordered ? 'ol' : 'ul', { class: 'md-list' }, items))
      continue
    }
    if (/^\s*>/.test(line)) {
      const quote = []
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push(el('blockquote', { class: 'md-quote' }, mdInline(quote.join(' '))))
      continue
    }
    const para = [line.trim()]
    i++
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !MD_BLOCK.test(lines[i])) para.push(lines[i++].trim())
    out.push(el('p', { class: 'md-p' }, mdInline(para.join(' '))))
  }
  return el('div', { class: 'md' }, out)
}

// Which document each project page has open, kept across the refresh rebuild.
const openDoc = new Map()

function docsPanel(p) {
  const docs = []
  if (p.goal) docs.push({ key: 'goal', label: '目标', path: '.devloop/GOAL.md', text: p.goal })
  for (const d of p.documents || []) docs.push({ key: d.path, label: DOC_LABEL[d.name] || d.name, path: d.path, text: d.text, truncated: d.truncated })
  if (p.planNote) docs.push({ key: 'plan', label: '规划记录', path: '.devloop/PLAN.md', text: p.planNote })
  if (p.reviewNote) docs.push({ key: 'review', label: '评审记录', path: '.devloop/REVIEW.md', text: p.reviewNote })
  if (p.progress) docs.push({ key: 'progress', label: '循环进度', path: '.devloop/PROGRESS.md', text: p.progress })
  if (!docs.length) {
    return el('section', { class: 'panel' }, el('h3', {}, '文档'),
      el('p', { class: 'muted' }, `还没有可看的文档。${p.docsDir || 'docs/agent'}/ 里的 roadmap、tasks、acceptance 等规划文档，以及循环写下的 PLAN / REVIEW / PROGRESS 都会显示在这里。`))
  }
  const current = docs.find(d => d.key === openDoc.get(p.id)) || docs[0]
  const tabs = docs.map((d) => {
    const tab = el('button', { type: 'button', class: `doc-tab ${d === current ? 'active' : ''}`, title: d.path }, d.label)
    tab.addEventListener('click', () => { openDoc.set(p.id, d.key); void load(true) })
    return tab
  })
  return el('section', { class: 'panel docs' },
    el('h3', {}, '文档'),
    el('div', { class: 'doc-tabs' }, tabs),
    el('div', { class: 'path' }, current.path, current.truncated ? '（只显示了前 64 KB）' : ''),
    renderMarkdown(current.text))
}

const DOC_LABEL = {
  'roadmap.md': '路线图', 'tasks.md': '任务清单', 'progress.md': '仓库进展', 'acceptance.md': '验收',
  'architecture.md': '架构', 'spec.md': '规格', 'research.md': '调研',
}

// ---- guide ------------------------------------------------------------------

const GUIDE_KEY = 'devloop.guide.open'

// Open until the reader folds it away; that choice is remembered per browser.
function guideOpen() {
  try {
    return localStorage.getItem(GUIDE_KEY) !== '0'
  } catch {
    return true
  }
}

const GUIDE_STEPS = [
  ['准备仓库', '在 Claude Code 里对这个仓库跑 pilot status（清理已合并的分支、确认工作区干净）和 pilot plan（写出 docs/agent/ 下的路线图、任务清单、验收标准）。规划器会读这些文档。'],
  ['切到工作分支', 'git switch -c devloop/<目标名>。DevLoop 把每个任务在本地合并进当前分支，从不合进 main / master；启动和每次合并前都会检查。'],
  ['添加项目', '点下面的「浏览仓库…」，选中仓库，点「添加」。'],
  ['写目标并启动', '进入项目页，先看「启动检查」全绿，再看「文档」里的规划，然后写目标：对应哪个 Feature / Task、验收命令、范围、不做什么。点「写入 GOAL.md 并启动」。'],
  ['看着它跑', '任务表显示每个任务的状态和验收标准；「文档」里能看到规划、评审记录和进度。需要你拍板时，项目会标「等你回答」，页面上直接回答。'],
  ['收尾', '目标完成后，从 devloop/<目标名> 分支开一个 PR，交给 PR-daemon 评审，通过后再合并进主干。'],
]

function guidePanel() {
  const details = el('details', { class: 'guide' },
    el('summary', {}, '使用说明：从一个仓库到交付'),
    el('p', { class: 'note' }, '推荐分工：Codex 做规划，DeepSeek 写代码，Claude 做评审和验收（在 web profile 的 plannerRoute / routing / reviewerRoute 里配置）。每个任务在独立的 worktree 里完成，评审通过才合并。'),
    el('ol', { class: 'guide-steps' }, GUIDE_STEPS.map(([title, body]) => el('li', {}, el('b', {}, title), el('span', {}, body)))),
    el('p', { class: 'note' }, '随时可以在项目页暂停；已停下的项目可以恢复，或从列表里移除（仓库里的文件原样保留）。'))
  details.open = guideOpen()
  details.addEventListener('toggle', () => {
    try { localStorage.setItem(GUIDE_KEY, details.open ? '1' : '0') } catch { /* storage blocked */ }
  })
  return details
}

// ---- repository status --------------------------------------------------------
//
// Scanned once when a project is opened and on 重新检查, not every 5 s: it runs
// several git commands. Kept here, like the picker, so a refresh rebuild keeps
// the result and the operator's checkbox choices.

const repoViews = new Map()

async function loadRepo(id) {
  const entry = repoViews.get(id) || { selected: null }
  repoViews.set(id, { ...entry, loading: true, error: null })
  try {
    const view = await getJson(`${API}/projects/${id}/status`)
    // Default: every branch the plan offers is ticked; ones the operator untick stay unticked.
    const previous = entry.selected
    const selected = new Set(view.plan.delete.filter(name => !previous || previous.has(name) || !entry.view || !entry.view.plan.delete.includes(name)))
    repoViews.set(id, { view, selected, loading: false, error: null })
  } catch (error) {
    repoViews.set(id, { ...entry, loading: false, error: error.message })
  }
  void load(true)
}

function repoPanel(p) {
  const entry = repoViews.get(p.id)
  if (!entry) { void loadRepo(p.id); return el('section', { class: 'panel' }, el('h3', {}, '仓库状态'), el('p', { class: 'muted' }, '读取中…')) }
  const recheck = el('button', { type: 'button', class: 'btn' }, entry.loading ? '读取中…' : '重新检查')
  recheck.disabled = entry.loading
  recheck.addEventListener('click', () => void loadRepo(p.id))
  if (entry.error || !entry.view) {
    return el('section', { class: 'panel' }, el('h3', {}, '仓库状态'), el('div', { class: 'banner bad' }, entry.error || '还没有结果'), recheck)
  }
  const { status, plan } = entry.view
  const summary = el('div', { class: 'kv' },
    el('span', {}, '当前分支 ', el('b', {}, status.branch || '（游离）')),
    el('span', {}, '主干 ', el('b', {}, status.base)),
    status.ahead !== null ? el('span', {}, '领先 / 落后主干 ', el('b', {}, `${status.ahead} / ${status.behind}`)) : null,
    el('span', {}, '未提交改动 ', el('b', {}, String(status.trackedChanges))))
  const boxes = plan.delete.map((name) => {
    const box = el('input', { type: 'checkbox' })
    box.checked = entry.selected.has(name)
    box.addEventListener('change', () => { box.checked ? entry.selected.add(name) : entry.selected.delete(name) })
    return el('label', { class: 'branch-row' }, box, el('span', { class: 'mono' }, name))
  })
  const chosen = () => plan.delete.filter(name => entry.selected.has(name))
  const del = actionButton('删除选中的分支', 'primary',
    '用 git branch -d 删除选中的已合并分支？git 会拒绝任何没合并或正被检出的分支；仓库里的提交不会丢。',
    async () => {
      const names = chosen()
      if (!names.length) throw new Error('没有选中任何分支')
      const result = await postJson(`${API}/projects/${p.id}/cleanup`, { branches: names })
      void loadRepo(p.id)
      const refused = result.refused.map(r => `${r.name}（${r.reason}）`).join('、')
      return { text: `已删除 ${result.deleted.length} 个分支${result.deleted.length ? `：${result.deleted.join('、')}` : ''}。${refused ? `没有删：${refused}` : ''}` }
    })
  del.disabled = plan.delete.length === 0
  // A deny-list entry that silently protects nothing is exactly what must be said out loud.
  const dropped = status.protectDropped && status.protectDropped.length
    ? el('div', { class: 'banner' }, '.pilot.yml 的 protect_patterns 里有项不起作用：',
      status.protectDropped.map((d, i) => [i ? '；' : '', el('code', {}, d.item), `（${d.reason}）`]).flat())
    : null
  return el('section', { class: 'panel repo' },
    el('h3', {}, '仓库状态'),
    summary,
    dropped,
    el('h4', {}, `可以删除的已合并分支（${plan.delete.length}）`),
    plan.delete.length ? el('div', { class: 'branch-list' }, boxes) : el('p', { class: 'muted' }, '没有：已合并的分支都清理过了。'),
    el('div', { class: 'actions' }, del, recheck),
    plan.manual.length ? el('details', {}, el('summary', {}, `需要你手动处理（${plan.manual.length}）`),
      el('ul', { class: 'plain' }, plan.manual.map(m => el('li', {}, m.reason, '：', el('code', {}, m.command))))) : null,
    el('details', {}, el('summary', {}, `保留的分支（${plan.keep.length}）`),
      el('ul', { class: 'plain' }, plan.keep.map(k => el('li', {}, el('span', { class: 'mono' }, k.name), ' — ', k.reason)))),
    el('p', { class: 'note' }, '只会执行 git branch -d，只处理本地分支。强制删除、删 worktree 只列出命令，由你决定；远程分支不在这里处理（建议在 GitHub 开启合并后自动删除分支）。'))
}

// The pre-PR checks and review verdicts, newest first: the data the PR budget
// trial is to be judged on. Everything in it came from a checker or a model, so
// it is placed as text, like every other field here.
const CHECK_LABEL = { passed: ['通过', 'ok'], blocked: ['拦下', 'bad'], unavailable: ['无结论', 'warn'] }

// Normal needs no mark: the budget is only worth pointing at where it was stretched or broken.
const BAND_LABEL = { elastic: ['弹性', 'warn'], over: ['超限', 'bad'] }

function prLogPanel(p) {
  const entries = (p.prLog || []).slice().reverse()
  if (!entries.length) {
    return el('section', { class: 'panel' }, el('h3', {}, 'PR 记录'),
      el('p', { class: 'muted' }, '还没有记录。配置了 pre-PR 检查器后，每个任务的检查结果和评审结论都会记在这里（.devloop/PR-LOG.jsonl）。'))
  }
  const rows = entries.map((e) => {
    const [label, tone] = e.kind === 'check' ? (CHECK_LABEL[e.status] || [e.status, '']) : [`评审 ${e.verdict}`, e.verdict === 'PASS' || e.verdict === 'PASS_WITH_NOTES' ? 'ok' : 'warn']
    return el('tr', {},
      el('td', { class: 'mono' }, time(e.at)),
      el('td', { class: 'mono' }, e.taskId),
      el('td', {}, badge(label, tone, true)),
      el('td', { class: 'num' }, e.kind === 'check' && e.size ? `${e.size.lines} 行 / ${e.size.files} 文件` : '—',
        e.kind === 'check' && BAND_LABEL[e.band] ? [' ', badge(...BAND_LABEL[e.band], true)] : null,
        e.kind === 'check' && e.estimate ? el('div', { class: 'muted' }, `预估 ${e.estimate.lines} 行 / ${e.estimate.files} 文件`) : null),
      el('td', { class: 'mono' }, e.kind === 'check' ? (e.blocking.length ? e.blocking.join(' ') : e.rules.join(' ') || '—') : (e.reviewer || '—')),
      el('td', { class: 'mono' }, e.kind === 'check' && e.checker ? `${e.checker.rulesVersion || '?'}${e.checker.dirty ? '*' : ''}` : ''),
      el('td', { class: 'mono' }, e.head ? e.head.slice(0, 7) : ''))
  })
  return el('section', { class: 'panel' },
    el('h3', {}, `PR 记录（最近 ${entries.length} 条）`),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['时间', '任务', '结果', '大小', '规则 / 评审者', '规则版本', '提交'].map(h => el('th', {}, h)))),
      el('tbody', {}, rows))),
    el('p', { class: 'note' }, '上限（试行）：每个 PR ≤200 行、≤5 个文件、≤2 个顶层目录；略超（弹性）照常评审，评审会被告知超了多少、判断该不该拆；超出更多（超限）打回重拆。拦下时标出的是阻断规则，否则是提示规则；规则版本带 * 表示检查器有未提交的改动。'))
}

function renderProject(p) {
  const canPause = p.armed && !p.halted && !p.error
  const head = el('div', { class: 'head' },
    el('h1', {}, p.name),
    loopBadges(p),
    p.revision !== null ? badge(`revision ${p.revision}`, '', true) : null,
    el('span', { class: 'spacer' }),
    canPause ? actionButton(t('btn.pause'), '',
      t('pause.confirm'),
      () => postJson(`${API}/projects/${p.id}/pause`, { revision: p.revision })) : null,
    removeButton(p))
  const sub = el('div', { class: 'path' }, p.root)
  if (p.error) return [back(), head, sub, el('div', { class: 'banner bad' }, p.error)]
  if (!p.armed) return [back(), head, sub, flashNode(), startPanel(p), repoPanel(p), docsPanel(p)]
  const main = [gatePanel(p), haltPanel(p), tasksPanel(p), docsPanel(p)]
  const side = [budgetPanel(p), repoPanel(p), eventsPanel(p)]
  main.push(prLogPanel(p))
  return [back(), head, sub, flashNode(),
    el('div', { class: 'kv' },
      el('span', {}, t('card.lastAction'), el('b', {}, p.lastAction || '—')),
      el('span', {}, t('project.lastProgress'), el('b', {}, ago(p.lastProgressAt) || '—')),
      el('span', {}, t('card.updated'), el('b', {}, time(p.updatedAt)))),
    el('div', { class: 'sections' }, el('div', {}, main), el('div', {}, side))]
}

// The last action's result, kept across the refresh that follows it.
let flash = null

function flashNode() {
  if (!flash || Date.now() - flash.at > 30000) return null
  const node = el('div', { class: `banner ${flash.tone || ''}` }, flash.text)
  return node
}

function describeResult(value) {
  if (value.declined) return t('result.declined', { revision: value.revision })
  if (value.stillBlocked) return t('result.stillBlocked', { revision: value.revision, why: value.stillBlocked })
  return t('result.written', { revision: value.revision })
}

function actionButton(label, tone, question, run) {
  const button = el('button', { type: 'button', class: `btn ${tone}` }, label)
  button.addEventListener('click', async () => {
    if (question && !window.confirm(question)) return
    for (const b of document.querySelectorAll('button.btn')) b.disabled = true
    try {
      const value = await run()
      flash = { text: value && value.text ? value.text : describeResult(value), tone: '', at: Date.now() }
    } catch (error) {
      flash = error.code === 'stale'
        ? { text: t('result.stale'), tone: 'bad', at: Date.now() }
        : { text: t('result.failed', { error: error.message }), tone: 'bad', at: Date.now() }
    }
    await load(true)
  })
  return button
}

function back() {
  return el('a', { class: 'back', href: '#/' }, t('project.back'))
}

// ---- loop -------------------------------------------------------------------

const app = document.getElementById('app')
const refresh = document.getElementById('refresh')
let timer = null
let inflight = false

function route() {
  const m = /^#\/p\/([0-9a-f]{12})$/.exec(location.hash)
  return m ? { view: 'project', id: m[1] } : { view: 'home' }
}

const SELECTION_HOLD_MS = 60000
let selectionHeldAt = null

function selectingInDocument() {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.anchorNode) return false
  const node = selection.anchorNode.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection.anchorNode.parentElement
  // In the live page (a selection in a replaced view is detached) and in a rendered document.
  return Boolean(node && app.contains(node) && node.closest('.md'))
}

// A refresh rebuilds the page, which would take a half-typed goal with it.
function editing() {
  // Only the home page has a picker; an open one must not freeze another view.
  if (picker.open && route().view === 'home') return true
  // A rebuild would drop text the reader is selecting in a document, so hold
  // for that — but only inside a document, and not for long. A selection
  // anywhere else (a task id double-clicked to copy) must not freeze the
  // gate and budget, and neither may one left behind when the reader walks away.
  if (selectingInDocument()) {
    selectionHeldAt ??= Date.now()
    if (Date.now() - selectionHeldAt < SELECTION_HOLD_MS) return true
  } else {
    selectionHeldAt = null
  }
  const active = document.activeElement
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return true
  return [...document.querySelectorAll('.path-input, .goal-input')].some(field => field.value.trim() !== '')
}

async function load(force) {
  if (inflight) return
  if (!force && editing()) {
    refresh.textContent = t('refresh.editing')
    return
  }
  inflight = true
  const r = route()
  try {
    const nodes = r.view === 'project'
      ? renderProject(await getJson(`${API}/projects/${r.id}`))
      : renderHome(await getJson(`${API}/projects`))
    // Keep the reader's place: a refresh replaces content, not scroll position.
    const y = window.scrollY
    app.replaceChildren(...nodes.filter(Boolean))
    window.scrollTo(0, y)
    refresh.textContent = t('refresh.every', { s: REFRESH_MS / 1000, time: new Date().toLocaleTimeString(locale(), { hour12: false }) })
    refresh.classList.remove('stale')
  } catch (error) {
    refresh.textContent = t('refresh.failed', { error: error.message })
    refresh.classList.add('stale')
    if (!app.querySelector('.card, .panel')) app.replaceChildren(el('div', { class: 'banner bad' }, error.message))
  } finally {
    inflight = false
  }
}

// The frame index.html draws in English: its words, and the switch that changes them.
function drawChrome() {
  document.documentElement.lang = locale()
  document.querySelector('.top .sub').textContent = t('chrome.sub')
  document.querySelector('.top .version').title = t('chrome.version')
  const box = document.getElementById('lang')
  box.setAttribute('aria-label', t('chrome.lang'))
  box.replaceChildren(...LANGS.map(([code, short, name]) => {
    const button = el('button', { type: 'button', class: `btn lang-option${code === currentLang ? ' primary' : ''}`, title: name, 'aria-pressed': String(code === currentLang) }, short)
    button.addEventListener('click', () => { setLang(code); drawChrome(); void load(true) })
    return button
  }))
}

function start() {
  drawChrome()
  clearInterval(timer)
  void load()
  timer = setInterval(() => { if (!document.hidden) void load() }, REFRESH_MS)
}

window.addEventListener('hashchange', () => { flash = null; closePicker(); repoViews.clear(); window.scrollTo(0, 0); clearInterval(timer); void load(true); timer = setInterval(() => { if (!document.hidden) void load() }, REFRESH_MS) })
document.addEventListener('visibilitychange', () => { if (!document.hidden) void load() })
start()
