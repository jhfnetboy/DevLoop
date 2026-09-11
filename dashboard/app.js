// DevLoop dashboard.
//
// Everything a project reports is model-influenced text: task titles, gate
// evidence, GOAL.md, PROGRESS.md. It is only ever placed with textContent
// (via `el`), never parsed as markup, and the page CSP forbids inline script.
'use strict'

const API = '/devloop/api'
const REFRESH_MS = 5000

const STATUS = {
  ready: ['待开始', ''],
  running: ['进行中', 'accent'],
  review_pending: ['待评审', 'accent'],
  merge_ready: ['待合并', 'ok'],
  rework: ['返工', 'warn'],
  blocked: ['阻塞', 'bad'],
  done: ['完成', 'ok'],
  failed: ['失败', 'bad'],
}
const LOOP = {
  running: ['循环运行中', 'ok'],
  stopped: ['循环已停止', 'bad'],
  elsewhere: ['未在本进程运行', ''],
}
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
  return d.toLocaleString('zh-CN', { hour12: false })
}

function ago(iso) {
  if (!iso) return ''
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (!Number.isFinite(s)) return ''
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`
  return `${Math.round(s / 86400)} 天前`
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
  if (res.status === 401) throw new Error('未登录 DSH')
  if (!parsed || !parsed.ok) {
    const error = new Error((parsed && parsed.error && parsed.error.message) || `HTTP ${res.status}`)
    error.code = parsed && parsed.error && parsed.error.code
    throw error
  }
  return parsed.value
}

async function getJson(path) {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' })
  if (res.status === 401) throw new Error('未登录 DSH：先用 dsh 打印的 ?token= 链接打开一次首页')
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
  if (!p.armed) out.push(badge('未启用（没有 GOAL.md）', ''))
  else if (p.completed) out.push(badge('已完成', 'ok'))
  else if (p.paused) out.push(badge('已暂停', 'warn'))
  else if (p.halted) out.push(badge('已停机', 'bad'))
  else out.push(badge(loopLabel, loopTone))
  if (p.armed && p.halted && p.loop === 'elsewhere') out.push(badge(loopLabel, '', true))
  if (p.question) out.push(badge('等你回答', 'warn'))
  if (p.error) out.push(badge('读取失败', 'bad'))
  return out
}

function countPills(counts) {
  return STATUS_ORDER
    .filter(s => counts[s])
    .map(s => badge(`${(STATUS[s] || [s])[0]} ${counts[s]}`, (STATUS[s] || [])[1], true))
}

function projectCard(p) {
  const total = Object.values(p.taskCounts || {}).reduce((a, b) => a + b, 0)
  return el('a', { class: 'card', href: `#/p/${p.id}` },
    el('h2', {}, p.name, p.own ? el('span', { class: 'muted' }, ' · 本进程') : null),
    el('div', { class: 'path' }, p.root),
    el('div', { class: 'row' }, loopBadges(p)),
    p.question ? el('div', { class: 'question' }, p.question) : null,
    p.error ? el('div', { class: 'question' }, p.error) : null,
    total ? el('div', { class: 'row' }, countPills(p.taskCounts)) : null,
    p.armed ? el('div', { class: 'kv' },
      el('span', {}, '最近动作 ', el('b', {}, p.lastAction || '—')),
      el('span', {}, '今日花费 ', el('b', {}, usd(p.costUsdDay))),
      el('span', {}, '更新 ', el('b', {}, ago(p.updatedAt) || '—')),
    ) : null,
  )
}

function renderHome(value) {
  const parts = [flashNode()]
  const g = value.global
  if (g && g.cap !== null && g.costUsdDay >= g.cap) {
    parts.push(el('div', { class: 'banner bad' },
      `所有项目今日合计花费 ${usd(g.costUsdDay)}，已达到共享上限 ${usd(g.cap)}：各循环都在等待，UTC 零点后自动继续。`))
  }
  if (value.registryError) parts.push(el('div', { class: 'banner' }, `项目注册表有问题：${value.registryError}`))
  parts.push(addProjectPanel())
  if (!value.projects.length) parts.push(el('div', { class: 'empty' }, '还没有项目。点上面的「浏览仓库…」选一个 git 仓库来添加。'))
  parts.push(el('div', { class: 'grid' }, value.projects.map(projectCard)))
  if (g) {
    parts.push(el('p', { class: 'note' }, `今日合计花费 ${usd(g.costUsdDay)}`,
      g.cap !== null ? ` / 共享上限 ${usd(g.cap)}` : '（只有一个项目时，由它自己的每日上限管）',
      '。只统计会报告花费的后端。'))
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
    if (!root) throw new Error('先选一个仓库')
    const value = await postJson(`${API}/projects`, { root })
    closePicker()
    return { text: `已添加：${value.root}。它还没有目标，点进去写一个就会开始。` }
  }
}

function addProjectPanel() {
  const note = el('p', { class: 'note' }, '一个项目就是一个需求：一个 git 仓库，写好目标后它的循环会把目标拆成任务逐个完成。')
  if (!picker.open) {
    const open = el('button', { type: 'button', class: 'btn primary' }, '浏览仓库…')
    open.addEventListener('click', () => void browseTo([]))
    return el('section', { class: 'panel add', id: 'add-panel' },
      el('h3', {}, '添加项目'), el('div', { class: 'actions' }, open), note)
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
  if (picker.loading) body = el('p', { class: 'muted' }, '读取中…')
  else if (picker.error) body = el('div', { class: 'banner bad' }, picker.error)
  else if (!listing.entries.length) body = el('p', { class: 'muted' }, '这里没有子目录。')
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
      entry.registered ? badge('已添加', 'ok', true) : entry.repo ? badge('git 仓库', 'accent', true) : el('span', { class: 'muted' }, '打开 ›'))
      row.addEventListener('click', () => {
        if (!entry.repo) return void browseTo([...picker.path, entry.name])
        picker.selected = selected ? null : entry.root
        redrawPicker()
      })
      return row
    }))
  }

  const add = actionButton('添加', 'primary', null, addProject(picker.selected))
  add.disabled = !picker.selected
  const cancel = el('button', { type: 'button', class: 'btn' }, '取消')
  cancel.addEventListener('click', () => { closePicker(); void load(true) })

  return el('section', { class: 'panel add', id: 'add-panel' },
    el('h3', {}, '添加项目'),
    el('div', { class: 'crumbs' }, crumbs.flatMap((c, i) => i ? [el('span', { class: 'muted' }, ' / '), c] : [c])),
    listing ? el('div', { class: 'path' }, [listing.root, ...picker.path].join('/')) : null,
    body,
    listing && listing.truncated ? el('p', { class: 'note' }, '目录太多，只列出了前 500 个。') : null,
    el('div', { class: 'actions' },
      add, cancel,
      el('span', { class: 'path selected-path' }, picker.selected || '点一个 git 仓库选中它')),
    note)
}

// Blocking checks refuse a start (the server refuses it too); the rest advise.
function readinessPanel(r) {
  if (!r) return el('div', { class: 'banner bad' }, '读不到这个仓库的状态，暂时不能启动。处理后点「重新检查」。')
  return el('div', { class: 'readiness' },
    el('div', { class: 'readiness-head' },
      r.ready ? badge('可以启动', 'ok') : badge('先处理红色项', 'bad'),
      el('span', { class: 'muted' }, ` 主干 ${r.base}`)),
    el('ul', { class: 'checks' }, r.checks.map(c => el('li', { class: c.ok ? 'ok' : c.blocking ? 'bad' : 'warn' },
      el('span', { class: 'mark' }, c.ok ? '✓' : c.blocking ? '✕' : '!'),
      el('span', { class: 'msg' }, c.message)))))
}

function startPanel(p) {
  const area = el('textarea', { class: 'goal-input', rows: '8', placeholder: '# 目标\n\n对应哪个 Feature / Task（如 docs/agent/tasks.md 里的 T1.2.x）、做到什么程度算完成（验收命令）、范围、不做什么……' })
  area.value = goalDrafts.get(p.id) || ''
  area.addEventListener('input', () => goalDrafts.set(p.id, area.value))
  // Unknown is not ready: a readiness the server could not read is refused there too.
  const ready = Boolean(p.readiness && p.readiness.ready)
  const start = actionButton('写入 GOAL.md 并启动', 'primary',
    '启动这个项目的循环？之后它会按配置调用模型、花费预算，并在当前分支上合并任务。目标写入后不能从页面修改。',
    async () => {
      const goal = area.value.trim()
      if (!goal) throw new Error('目标是空的')
      await postJson(`${API}/projects/${p.id}/start`, { goal })
      goalDrafts.delete(p.id)
      return { text: '已写入 GOAL.md，循环已唤醒。' }
    })
  start.disabled = !ready
  const recheck = el('button', { type: 'button', class: 'btn' }, '重新检查')
  recheck.addEventListener('click', () => void load(true))
  return el('section', { class: 'panel start' },
    el('h3', {}, '启动循环'),
    el('p', {}, '写下这个需求的目标。保存为 .devloop/GOAL.md 后，循环会先规划出一系列任务，再逐个交给模型实现、评审、合并。'),
    readinessPanel(p.readiness),
    area,
    el('div', { class: 'actions' }, start, recheck),
    el('p', { class: 'note' }, '建议先在 Claude Code 里用 pilot status 清理、pilot plan 写好 docs/agent/，规划器会读它们。已有的目标只能在本机手工修改：正在跑的循环按旧目标规划的任务不会因为目标被替换而自动作废。'))
}

// A half-typed goal survives the rebuild that a failed start or a re-check causes.
const goalDrafts = new Map()

function removeButton(p) {
  if (p.own) return null
  if (p.armed && !p.halted) return null
  return actionButton('移除项目', '',
    '把这个项目从列表里移除？它的循环会停下；仓库里的 .devloop、worktree 和分支都原样保留，随时可以重新添加。',
    async () => {
      await postJson(`${API}/projects/${p.id}/unregister`, {})
      location.hash = '#/'
      return { text: `已移除：${p.name}` }
    })
}

function gatePanel(p) {
  const g = p.gate
  if (!g) return null
  return el('section', { class: 'panel gate' },
    el('h3', {}, '等你回答'),
    el('p', { class: 'q' }, g.question),
    g.evidence && g.evidence.length ? el('ul', { class: 'plain' }, g.evidence.map(e => el('li', {}, e))) : null,
    g.options && g.options.length ? el('div', { class: 'options' },
      g.options.map(o => el('div', { class: 'option' },
        actionButton(ANSWER_LABEL[o.key] || o.key, o.key === 'stop' ? '' : 'primary',
          `回答「${ANSWER_LABEL[o.key] || o.key}」：${o.summary}`,
          () => postJson(`${API}/projects/${p.id}/answer`, { revision: p.revision, choice: o.key })),
        el('span', {}, el('code', {}, o.key), ' ', o.summary)))) : null,
    g.manual ? el('p', { class: 'note' }, g.manual) : null,
  )
}

function haltPanel(p) {
  if (p.completed && !p.supervisor) {
    return el('section', { class: 'panel' },
      el('h3', {}, '目标已完成'),
      el('p', {}, '所有任务都已评审通过并合并到主分支。这个循环不会再做别的事。'),
      el('p', { class: 'note' }, '新需求建议作为新项目添加。确实要在这里重开某个任务，在本机用 devloop resume --task <任务ID>。'))
  }
  if (!p.halted && !p.supervisor) return null
  return el('section', { class: 'panel' },
    el('h3', {}, p.paused ? '已暂停' : '停机原因'),
    p.haltReasons && p.haltReasons.length
      ? el('ul', { class: 'plain' }, p.haltReasons.map(r => el('li', {}, r)))
      : el('p', { class: 'muted' }, '—'),
    p.supervisor ? el('p', { class: 'note' }, `supervisor hold：${p.supervisor.reason}${p.supervisor.taskId ? `（任务 ${p.supervisor.taskId}）` : ''}`) : null,
    p.acknowledged ? el('p', { class: 'note' }, `已于 ${time(p.acknowledged.at)} 选择暂不处理（answer stop）`) : null,
    el('div', { class: 'actions' },
      actionButton('恢复循环', 'primary',
        p.paused ? '恢复这个循环？' : '解除停机并清掉基于旧历史的熔断。如果停机原因还在，下一轮会再次停下。继续？',
        () => postJson(`${API}/projects/${p.id}/resume`, { revision: p.revision }))),
    el('p', { class: 'note' }, '只重做某个任务（--task）或清零花费（--reset-cost）仍需在本机用 devloop resume。'),
  )
}

function tasksPanel(p) {
  if (!p.tasks.length) {
    return el('section', { class: 'panel' }, el('h3', {}, '任务'),
      el('p', { class: 'muted' }, p.armed ? '还没有任务：循环会先根据 GOAL.md 做规划。' : '—'))
  }
  const rows = p.tasks.map(t => {
    const [label, tone] = STATUS[t.status] || [t.status, '']
    return el('tr', {},
      el('td', { class: 'mono' }, t.id),
      el('td', { class: 'title-cell' }, t.title,
        t.allowedPaths && t.allowedPaths.length ? el('div', { class: 'path' }, t.allowedPaths.join('  ')) : null),
      el('td', {}, badge(label, tone)),
      el('td', {}, t.tier),
      el('td', { class: 'num' }, t.attempts),
      el('td', { class: 'num' }, t.reviewCycles),
      el('td', {}, t.lastReviewVerdict || '—'),
    )
  })
  return el('section', { class: 'panel' },
    el('h3', {}, `任务（${p.tasks.length}）`),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['ID', '标题', '状态', '层级', '尝试', '评审', '结论'].map(h => el('th', {}, h)))),
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
    el('h3', {}, '预算'),
    el('div', {}, `本次会话 ${usd(p.costUsdSession)} / ${usd(l.maxCostUsdPerSession)}`), meter(p.costUsdSession, l.maxCostUsdPerSession),
    el('div', {}, `今日 ${usd(p.costUsdDay)} / ${usd(l.maxCostUsdPerDay)}`), meter(p.costUsdDay, l.maxCostUsdPerDay),
    el('div', { class: 'kv' },
      el('span', {}, '每任务尝试 ', el('b', {}, l.maxTaskAttempts)),
      el('span', {}, '评审轮次 ', el('b', {}, l.maxReviewCycles)),
      el('span', {}, '无进展 ', el('b', {}, `${l.noProgressMinutes} 分钟`)),
    ),
    el('p', { class: 'note' }, `来源：${p.budget.source}。只有会报告花费的后端才计入；dsh headless 不报告，所以它的花费这里看不到。`),
  )
}

function eventsPanel(p) {
  return el('section', { class: 'panel' },
    el('h3', {}, '最近事件'),
    p.events.length
      ? el('ul', { class: 'events' }, p.events.map(e => el('li', {},
          el('span', { class: 'rev' }, `#${e.revision ?? '?'}`),
          el('span', {}, el('span', { class: 'mono' }, e.action || '—'), el('span', { class: 'when' }, time(e.at))))))
      : el('p', { class: 'muted' }, '—'))
}

function textPanel(title, text, open) {
  if (!text) return null
  const details = el('details', {}, el('summary', {}, title), el('pre', { class: 'box' }, text))
  if (open) details.open = true
  return el('section', { class: 'panel' }, details)
}

function renderProject(p) {
  const canPause = p.armed && !p.halted && !p.error
  const head = el('div', { class: 'head' },
    el('h1', {}, p.name),
    loopBadges(p),
    p.revision !== null ? badge(`revision ${p.revision}`, '', true) : null,
    el('span', { class: 'spacer' }),
    canPause ? actionButton('暂停', '',
      '暂停这个循环？正在跑的那一步会中止，并计为一次尝试；恢复后重做。',
      () => postJson(`${API}/projects/${p.id}/pause`, { revision: p.revision })) : null,
    removeButton(p))
  const sub = el('div', { class: 'path' }, p.root)
  if (p.error) return [back(), head, sub, el('div', { class: 'banner bad' }, p.error)]
  if (!p.armed) return [back(), head, sub, flashNode(), startPanel(p)]
  const main = [gatePanel(p), haltPanel(p), tasksPanel(p), textPanel('目标 GOAL.md', p.goal, true)]
  const side = [budgetPanel(p), eventsPanel(p), textPanel('PROGRESS.md', p.progress, false)]
  return [back(), head, sub, flashNode(),
    el('div', { class: 'kv' },
      el('span', {}, '最近动作 ', el('b', {}, p.lastAction || '—')),
      el('span', {}, '最近进展 ', el('b', {}, ago(p.lastProgressAt) || '—')),
      el('span', {}, '更新 ', el('b', {}, time(p.updatedAt)))),
    el('div', { class: 'sections' }, el('div', {}, main), el('div', {}, side))]
}

const ANSWER_LABEL = { retry: '重做', review: '重新评审', accept: '接受', stop: '先不处理' }

// The last action's result, kept across the refresh that follows it.
let flash = null

function flashNode() {
  if (!flash || Date.now() - flash.at > 30000) return null
  const node = el('div', { class: `banner ${flash.tone || ''}` }, flash.text)
  return node
}

function describeResult(value) {
  if (value.declined) return `已记录：先不处理（revision ${value.revision}）。`
  if (value.stillBlocked) return `已写入（revision ${value.revision}），但下一轮还会被挡住：${value.stillBlocked}`
  return `已写入（revision ${value.revision}）。循环会在下一轮接着跑。`
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
        ? { text: '状态已经变了，页面已刷新。请看一眼再决定。', tone: 'bad', at: Date.now() }
        : { text: `没有执行：${error.message}`, tone: 'bad', at: Date.now() }
    }
    await load(true)
  })
  return button
}

function back() {
  return el('a', { class: 'back', href: '#/' }, '← 所有项目')
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

// A refresh rebuilds the page, which would take a half-typed goal with it.
function editing() {
  // Only the home page has a picker; an open one must not freeze another view.
  if (picker.open && route().view === 'home') return true
  const active = document.activeElement
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return true
  return [...document.querySelectorAll('.path-input, .goal-input')].some(field => field.value.trim() !== '')
}

async function load(force) {
  if (inflight) return
  if (!force && editing()) {
    refresh.textContent = '编辑中，暂停自动刷新'
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
    refresh.textContent = `每 ${REFRESH_MS / 1000} 秒刷新 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
    refresh.classList.remove('stale')
  } catch (error) {
    refresh.textContent = `刷新失败：${error.message}`
    refresh.classList.add('stale')
    if (!app.querySelector('.card, .panel')) app.replaceChildren(el('div', { class: 'banner bad' }, error.message))
  } finally {
    inflight = false
  }
}

function start() {
  clearInterval(timer)
  void load()
  timer = setInterval(() => { if (!document.hidden) void load() }, REFRESH_MS)
}

window.addEventListener('hashchange', () => { flash = null; closePicker(); window.scrollTo(0, 0); clearInterval(timer); void load(true); timer = setInterval(() => { if (!document.hidden) void load() }, REFRESH_MS) })
document.addEventListener('visibilitychange', () => { if (!document.hidden) void load() })
start()
