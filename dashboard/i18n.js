// DevLoop dashboard strings, in English, Chinese and Thai. Loaded before app.js.
//
// Each entry is [English, 中文, ไทย]. A missing translation falls back to
// English, and an unknown key to the key itself, so a gap shows as a gap
// rather than an empty button. `{name}` is replaced from the vars given to t().
'use strict'

const LANGS = [['en', 'EN', 'English'], ['zh', '中', '中文'], ['th', 'ไทย', 'ภาษาไทย']]
const LANG_INDEX = { en: 0, zh: 1, th: 2 }
const LANG_LOCALE = { en: 'en-US', zh: 'zh-CN', th: 'th-TH' }
const LANG_KEY = 'devloop.lang'

// English unless the reader chose otherwise on this browser.
let currentLang = (() => {
  try {
    const saved = localStorage.getItem(LANG_KEY)
    return saved !== null && Object.hasOwn(LANG_INDEX, saved) ? saved : 'en'
  } catch {
    return 'en'
  }
})()

function setLang(lang) {
  if (!Object.hasOwn(LANG_INDEX, lang)) return
  currentLang = lang
  try { localStorage.setItem(LANG_KEY, lang) } catch { /* private window: this visit only */ }
  document.documentElement.lang = LANG_LOCALE[lang]
}

function locale() {
  return LANG_LOCALE[currentLang]
}

function t(key, vars) {
  const entry = STRINGS[key]
  const text = entry ? (entry[LANG_INDEX[currentLang]] || entry[0]) : key
  return vars ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole)) : text
}

const STRINGS = {
  // The frame around every page.
  'chrome.sub': ['Projects and loops', '项目与循环', 'โปรเจกต์และลูป'],
  'chrome.version': ['Installed @jhfnetboy/dsh-devloop version', '已安装的 @jhfnetboy/dsh-devloop 版本', 'เวอร์ชัน @jhfnetboy/dsh-devloop ที่ติดตั้ง'],
  'chrome.lang': ['Language', '语言', 'ภาษา'],
  'chrome.loading': ['Loading…', '加载中…', 'กำลังโหลด…'],
  'refresh.editing': ['Editing: auto-refresh paused', '编辑中，暂停自动刷新', 'กำลังแก้ไข: หยุดรีเฟรชอัตโนมัติ'],
  'refresh.every': ['Refreshes every {s}s · {time}', '每 {s} 秒刷新 · {time}', 'รีเฟรชทุก {s} วินาที · {time}'],
  'refresh.failed': ['Refresh failed: {error}', '刷新失败：{error}', 'รีเฟรชไม่สำเร็จ: {error}'],
  'err.login': ['Not signed in to DSH', '未登录 DSH', 'ยังไม่ได้ลงชื่อเข้าใช้ DSH'],
  'err.loginHint': ['Not signed in to DSH: open the DSH home page once with the ?token= link dsh printed', '未登录 DSH：先用 dsh 打印的 ?token= 链接打开一次首页', 'ยังไม่ได้ลงชื่อเข้าใช้ DSH: เปิดหน้าแรกของ DSH หนึ่งครั้งด้วยลิงก์ ?token= ที่ dsh พิมพ์ออกมา'],

  // Times. `ago` wraps a duration.
  'dur.s': ['{n}s', '{n} 秒', '{n} วินาที'],
  'dur.m': ['{n} min', '{n} 分钟', '{n} นาที'],
  'dur.h': ['{n} h', '{n} 小时', '{n} ชั่วโมง'],
  'dur.d': ['{n} d', '{n} 天', '{n} วัน'],
  'ago': ['{d} ago', '{d}前', '{d}ที่แล้ว'],

  // Task and loop states.
  'status.ready': ['Ready', '待开始', 'พร้อมเริ่ม'],
  'status.running': ['Running', '进行中', 'กำลังทำ'],
  'status.review_pending': ['Awaiting review', '待评审', 'รอรีวิว'],
  'status.merge_ready': ['Ready to merge', '待合并', 'พร้อมรวมโค้ด'],
  'status.rework': ['Rework', '返工', 'แก้ไขใหม่'],
  'status.blocked': ['Blocked', '阻塞', 'ติดขัด'],
  'status.done': ['Done', '完成', 'เสร็จแล้ว'],
  'status.failed': ['Failed', '失败', 'ล้มเหลว'],
  'loop.running': ['Loop running', '循环运行中', 'ลูปกำลังทำงาน'],
  'loop.stopped': ['Loop stopped', '循环已停止', 'ลูปหยุดแล้ว'],
  'loop.elsewhere': ['Not running in this process', '未在本进程运行', 'ไม่ได้รันในโปรเซสนี้'],
  'badge.unarmed': ['Not started (no GOAL.md)', '未启用（没有 GOAL.md）', 'ยังไม่เริ่ม (ไม่มี GOAL.md)'],
  'badge.completed': ['Completed', '已完成', 'เสร็จสมบูรณ์'],
  'badge.paused': ['Paused', '已暂停', 'หยุดชั่วคราว'],
  'badge.halted': ['Halted', '已停机', 'หยุดทำงาน'],
  'badge.question': ['Needs your answer', '等你回答', 'รอคำตอบจากคุณ'],
  'badge.unreadable': ['Unreadable', '读取失败', 'อ่านไม่ได้'],

  // The home page.
  'lane.needs_you': ['Needs you', '等你处理', 'รอคุณ'],
  'lane.needs_you.hint': ['Stuck, or nothing is running it: it moves only once you look.', '卡住了，或者没人在跑它：要你看一眼才会动。', 'ติดอยู่ หรือไม่มีอะไรรันอยู่: จะไปต่อได้เมื่อคุณเข้ามาดู'],
  'lane.running': ['Running', '进行中', 'กำลังทำงาน'],
  'lane.running.hint': ['The loop is running on its own; nothing to do.', '循环在自己跑，不用管。', 'ลูปทำงานเองอยู่ ไม่ต้องทำอะไร'],
  'lane.idle': ['Idle', '闲置', 'ว่าง'],
  'lane.idle.hint': ['Not started, paused, or a halt you chose to leave.', '还没启动、已暂停，或你选择了先不处理。', 'ยังไม่เริ่ม หยุดชั่วคราว หรือการหยุดที่คุณเลือกปล่อยไว้ก่อน'],
  'lane.done': ['Done', '已完成', 'เสร็จแล้ว'],
  'lane.done.hint': ['The goal is finished.', '目标做完了。', 'เป้าหมายเสร็จแล้ว'],
  'doing.plan': ['Planning tasks.', '正在规划任务。', 'กำลังวางแผนงาน'],
  'doing.delegate': ['Implementing {task}.', '正在实现 {task}。', 'กำลังพัฒนา {task}'],
  'doing.review': ['Reviewing {task}.', '正在评审 {task}。', 'กำลังรีวิว {task}'],
  'doing.merge': ['Merging {task}.', '正在合并 {task}。', 'กำลังรวมโค้ด {task}'],
  'next.tick': ['Waiting for the next tick.', '等下一轮。', 'รอรอบถัดไป'],
  'next.stopped': ['The loop is not running: restart dsh web, or check this project\'s config.', '循环没在运行：重启 dsh web，或检查这个项目的配置。', 'ลูปไม่ได้ทำงาน: รีสตาร์ต dsh web หรือตรวจสอบการตั้งค่าของโปรเจกต์นี้'],
  'next.unarmed': ['Not started: open it, write the goal, and start.', '还没启动：进去写下目标，点启动。', 'ยังไม่เริ่ม: เปิดเข้าไป เขียนเป้าหมาย แล้วกดเริ่ม'],
  'next.done': ['Goal complete. Add new work as a new project.', '目标已完成。新需求建议作为新项目添加。', 'เป้าหมายเสร็จแล้ว งานใหม่ควรเพิ่มเป็นโปรเจกต์ใหม่'],
  'next.paused': ['Paused: open it and press {resume}.', '已暂停：进去点「{resume}」继续。', 'หยุดชั่วคราว: เปิดเข้าไปแล้วกด "{resume}"'],
  'next.left': ['You chose to leave this halt: open it to resume at any time.', '你选择了先不处理这次停机：进去可以随时恢复。', 'คุณเลือกปล่อยการหยุดนี้ไว้ก่อน: เปิดเข้าไปเพื่อทำงานต่อได้ทุกเมื่อ'],
  'since.waiting': ['Waiting {d}', '已等 {d}', 'รอมา {d}'],
  'since.done': ['Finished {ago}', '{ago}完成', 'เสร็จเมื่อ {ago}'],
  'card.own': [' · this process', ' · 本进程', ' · โปรเซสนี้'],
  'card.lastAction': ['Last action ', '最近动作 ', 'การกระทำล่าสุด '],
  'card.costToday': ['Spent today ', '今日花费 ', 'ค่าใช้จ่ายวันนี้ '],
  'card.updated': ['Updated ', '更新 ', 'อัปเดต '],
  'home.capReached': ['All projects have spent {spent} today, reaching the shared cap of {cap}: every loop waits and resumes after midnight UTC.', '所有项目今日合计花费 {spent}，已达到共享上限 {cap}：各循环都在等待，UTC 零点后自动继续。', 'ทุกโปรเจกต์ใช้ไป {spent} วันนี้ ถึงเพดานรวม {cap} แล้ว: ทุกลูปจะรอและทำงานต่อหลังเที่ยงคืน UTC'],
  'home.registryError': ['The project registry has a problem: {error}', '项目注册表有问题：{error}', 'ทะเบียนโปรเจกต์มีปัญหา: {error}'],
  'home.empty': ['No projects yet. Press "{browse}" above and pick a git repository to add.', '还没有项目。点上面的「{browse}」选一个 git 仓库来添加。', 'ยังไม่มีโปรเจกต์ กด "{browse}" ด้านบนแล้วเลือกรีโพ git เพื่อเพิ่ม'],
  'home.spent': ['Spent today across projects: {spent}', '今日合计花费 {spent}', 'ค่าใช้จ่ายรวมวันนี้: {spent}'],
  'home.cap': [' / shared cap {cap}', ' / 共享上限 {cap}', ' / เพดานรวม {cap}'],
  'home.noCap': [' (with one project, its own daily cap applies)', '（只有一个项目时，由它自己的每日上限管）', ' (ถ้ามีโปรเจกต์เดียว ใช้เพดานรายวันของโปรเจกต์นั้น)'],
  'home.costNote': ['. Only backends that report spend are counted.', '。只统计会报告花费的后端。', ' นับเฉพาะแบ็กเอนด์ที่รายงานค่าใช้จ่าย'],

  // Named here because home-page sentences point at them; their panels are translated with the rest.
  'btn.resume': ['Resume loop', '恢复循环', 'ให้ลูปทำงานต่อ'],
  'btn.browse': ['Browse repositories…', '浏览仓库…', 'เลือกรีโพ…'],

  // Adding a project, and starting its loop.
  'btn.cancel': ['Cancel', '取消', 'ยกเลิก'],
  'add.title': ['Add a project', '添加项目', 'เพิ่มโปรเจกต์'],
  'add.note': ['One project is one piece of work: a git repository whose loop, once it has a goal, splits it into tasks and finishes them one by one.', '一个项目就是一个需求：一个 git 仓库，写好目标后它的循环会把目标拆成任务逐个完成。', 'หนึ่งโปรเจกต์คืองานหนึ่งชิ้น: รีโพ git ที่เมื่อมีเป้าหมายแล้ว ลูปจะแบ่งเป็นงานย่อยและทำทีละงานจนเสร็จ'],
  'add.reading': ['Reading…', '读取中…', 'กำลังอ่าน…'],
  'add.empty': ['No folders here.', '这里没有子目录。', 'ไม่มีโฟลเดอร์ย่อยที่นี่'],
  'add.added': ['Added', '已添加', 'เพิ่มแล้ว'],
  'add.repo': ['git repository', 'git 仓库', 'รีโพ git'],
  'add.open': ['Open ›', '打开 ›', 'เปิด ›'],
  'add.add': ['Add', '添加', 'เพิ่ม'],
  'add.truncated': ['Too many folders: only the first 500 are listed.', '目录太多，只列出了前 500 个。', 'โฟลเดอร์มากเกินไป: แสดงเพียง 500 รายการแรก'],
  'add.pickHint': ['Click a git repository to select it', '点一个 git 仓库选中它', 'คลิกรีโพ git เพื่อเลือก'],
  'add.pickFirst': ['Pick a repository first', '先选一个仓库', 'เลือกรีโพก่อน'],
  'add.done': ['Added {root}. It has no goal yet: open it and write one to start.', '已添加：{root}。它还没有目标，点进去写一个就会开始。', 'เพิ่ม {root} แล้ว ยังไม่มีเป้าหมาย: เปิดเข้าไปแล้วเขียนเป้าหมายเพื่อเริ่ม'],
  'start.title': ['Start the loop', '启动循环', 'เริ่มลูป'],
  'start.intro': ['Write the goal for this work. Once saved as .devloop/GOAL.md, the loop plans it into tasks, then has models implement, review and merge them one by one.', '写下这个需求的目标。保存为 .devloop/GOAL.md 后，循环会先规划出一系列任务，再逐个交给模型实现、评审、合并。', 'เขียนเป้าหมายของงานนี้ เมื่อบันทึกเป็น .devloop/GOAL.md แล้ว ลูปจะวางแผนเป็นงานย่อย แล้วให้โมเดลพัฒนา รีวิว และรวมโค้ดทีละงาน'],
  'start.placeholder': ['# Goal\n\nWhich feature or task (e.g. T1.2.x in docs/agent/tasks.md), what counts as done (the acceptance commands), the scope, what not to do…', '# 目标\n\n对应哪个 Feature / Task（如 docs/agent/tasks.md 里的 T1.2.x）、做到什么程度算完成（验收命令）、范围、不做什么……', '# เป้าหมาย\n\nฟีเจอร์หรืองานไหน (เช่น T1.2.x ใน docs/agent/tasks.md) แค่ไหนถือว่าเสร็จ (คำสั่งตรวจรับ) ขอบเขต และสิ่งที่ไม่ต้องทำ…'],
  'start.button': ['Write GOAL.md and start', '写入 GOAL.md 并启动', 'เขียน GOAL.md แล้วเริ่ม'],
  'start.confirm': ['Start this project\'s loop? It will call models as configured, spend budget, and merge tasks into the current branch. The goal cannot be changed from the page once written.', '启动这个项目的循环？之后它会按配置调用模型、花费预算，并在当前分支上合并任务。目标写入后不能从页面修改。', 'เริ่มลูปของโปรเจกต์นี้? ลูปจะเรียกโมเดลตามที่ตั้งค่าไว้ ใช้งบประมาณ และรวมงานเข้ากับสาขาปัจจุบัน เมื่อเขียนเป้าหมายแล้วจะแก้จากหน้านี้ไม่ได้'],
  'start.emptyGoal': ['The goal is empty', '目标是空的', 'เป้าหมายว่างอยู่'],
  'start.done': ['GOAL.md written; the loop is awake.', '已写入 GOAL.md，循环已唤醒。', 'เขียน GOAL.md แล้ว ลูปเริ่มทำงาน'],
  'start.recheck': ['Check again', '重新检查', 'ตรวจอีกครั้ง'],
  'start.note': ['Tip: in Claude Code, run pilot status to tidy up and pilot plan to write docs/agent/ first; the planner reads them. An existing goal can only be edited on the machine, and tasks already planned from the old goal are not cancelled when it changes.', '建议先在 Claude Code 里用 pilot status 清理、pilot plan 写好 docs/agent/，规划器会读它们。已有的目标只能在本机手工修改：正在跑的循环按旧目标规划的任务不会因为目标被替换而自动作废。', 'คำแนะนำ: ใน Claude Code ให้รัน pilot status เพื่อจัดระเบียบ และ pilot plan เพื่อเขียน docs/agent/ ก่อน ตัววางแผนจะอ่านเอกสารเหล่านี้ เป้าหมายที่มีอยู่แก้ได้บนเครื่องเท่านั้น และงานที่วางแผนจากเป้าหมายเดิมจะไม่ถูกยกเลิกเมื่อเปลี่ยนเป้าหมาย'],
  'start.unreadable': ['Could not read this repository\'s state, so it cannot start yet. Fix it, then press {recheck}.', '读不到这个仓库的状态，暂时不能启动。处理后点「{recheck}」。', 'อ่านสถานะของรีโพนี้ไม่ได้ จึงยังเริ่มไม่ได้ แก้ไขแล้วกด "{recheck}"'],
  'start.ready': ['Ready to start', '可以启动', 'พร้อมเริ่ม'],
  'start.fixRed': ['Fix the red items first', '先处理红色项', 'แก้รายการสีแดงก่อน'],
  'start.trunk': [' trunk {base}', ' 主干 {base}', ' สาขาหลัก {base}'],
  'remove.button': ['Remove project', '移除项目', 'นำโปรเจกต์ออก'],
  'remove.confirm': ['Remove this project from the list? Its loop stops; .devloop, worktrees and branches in the repository are left as they are, and it can be added again at any time.', '把这个项目从列表里移除？它的循环会停下；仓库里的 .devloop、worktree 和分支都原样保留，随时可以重新添加。', 'นำโปรเจกต์นี้ออกจากรายการ? ลูปจะหยุด ส่วน .devloop, worktree และสาขาในรีโพจะคงอยู่ตามเดิม และเพิ่มกลับได้ทุกเมื่อ'],
  'remove.done': ['Removed {name}', '已移除：{name}', 'นำ {name} ออกแล้ว'],

  // A project's page: its gate, halt, tasks, budget and events, and what an action says back.
  'project.back': ['← All projects', '← 所有项目', '← โปรเจกต์ทั้งหมด'],
  'project.lastProgress': ['Last progress ', '最近进展 ', 'ความคืบหน้าล่าสุด '],
  'btn.pause': ['Pause', '暂停', 'หยุดชั่วคราว'],
  'pause.confirm': ['Pause this loop? The step now running stops and counts as an attempt; it is redone after resuming.', '暂停这个循环？正在跑的那一步会中止，并计为一次尝试；恢复后重做。', 'หยุดลูปนี้ชั่วคราว? ขั้นตอนที่กำลังทำจะหยุดและนับเป็นหนึ่งครั้ง แล้วทำใหม่หลังจากทำงานต่อ'],
  'answer.retry': ['Redo', '重做', 'ทำใหม่'],
  'answer.review': ['Review again', '重新评审', 'รีวิวอีกครั้ง'],
  'answer.accept': ['Accept', '接受', 'ยอมรับ'],
  'answer.stop': ['Leave it for now', '先不处理', 'ปล่อยไว้ก่อน'],
  'answer.confirm': ['Answer "{label}": {impact}. Continue?', '回答「{label}」：{impact}。继续？', 'ตอบ "{label}": {impact} ดำเนินการต่อ?'],
  'impact.free': ['Costs nothing, and keeps the existing work', '不花钱，不动已有的改动', 'ไม่มีค่าใช้จ่าย และเก็บงานเดิมไว้'],
  'impact.spends': ['Calls a model again, which costs money', '会再调用一次模型，产生费用', 'เรียกโมเดลอีกครั้ง ซึ่งมีค่าใช้จ่าย'],
  'impact.noSpend': ['Costs nothing', '不花钱', 'ไม่มีค่าใช้จ่าย'],
  'impact.discards': ['throws this attempt away and starts over', '丢弃这次的改动，从头再做', 'ทิ้งงานครั้งนี้แล้วเริ่มใหม่'],
  'impact.keeps': ['keeps the existing work', '保留已有的改动', 'เก็บงานเดิมไว้'],
  'impact.sep': ['; ', '；', '; '],
  'gate.manual': ['What you need to do: ', '要你做的事：', 'สิ่งที่คุณต้องทำ: '],
  'gate.more': ['Other answers ({n})', '其他选项（{n}）', 'ตัวเลือกอื่น ({n})'],
  'halt.completed': ['Goal complete', '目标已完成', 'เป้าหมายเสร็จแล้ว'],
  'halt.completedText': ['Every task was reviewed, passed and merged. This loop has nothing more to do.', '所有任务都已评审通过并合并到主分支。这个循环不会再做别的事。', 'ทุกงานผ่านการรีวิวและรวมโค้ดแล้ว ลูปนี้ไม่มีอะไรต้องทำอีก'],
  'halt.completedNote': ['Add new work as a new project. To reopen a task here, run devloop resume --task <task id> on the machine.', '新需求建议作为新项目添加。确实要在这里重开某个任务，在本机用 devloop resume --task <任务ID>。', 'งานใหม่ควรเพิ่มเป็นโปรเจกต์ใหม่ หากต้องการเปิดงานใหม่ที่นี่ ให้รัน devloop resume --task <รหัสงาน> บนเครื่อง'],
  'halt.title': ['Why it stopped', '停机原因', 'สาเหตุที่หยุด'],
  'halt.hold': ['supervisor hold: {reason}', 'supervisor hold：{reason}', 'supervisor hold: {reason}'],
  'halt.holdTask': ['supervisor hold: {reason} (task {task})', 'supervisor hold：{reason}（任务 {task}）', 'supervisor hold: {reason} (งาน {task})'],
  'halt.acknowledged': ['Left alone at {at} (answer stop)', '已于 {at} 选择暂不处理（answer stop）', 'เลือกปล่อยไว้ก่อนเมื่อ {at} (answer stop)'],
  'halt.resumePaused': ['Resume this loop?', '恢复这个循环？', 'ให้ลูปนี้ทำงานต่อ?'],
  'halt.resumeHalted': ['Lift the halt and clear the breakers built on old history? If the cause is still there, the next tick stops again. Continue?', '解除停机并清掉基于旧历史的熔断。如果停机原因还在，下一轮会再次停下。继续？', 'ยกเลิกการหยุดและล้างตัวตัดวงจรจากประวัติเก่า? ถ้าสาเหตุยังอยู่ รอบถัดไปจะหยุดอีก ดำเนินการต่อ?'],
  'halt.cliNote': ['Redoing a single task (--task) or clearing spend (--reset-cost) still needs devloop resume on the machine.', '只重做某个任务（--task）或清零花费（--reset-cost）仍需在本机用 devloop resume。', 'การทำงานเดียวใหม่ (--task) หรือล้างค่าใช้จ่าย (--reset-cost) ยังต้องใช้ devloop resume บนเครื่อง'],
  'role.planner': ['planned', '规划', 'วางแผน'],
  'role.implementer': ['built', '实现', 'พัฒนา'],
  'role.reviewer': ['reviewed', '评审', 'รีวิว'],
  'tasks.title': ['Tasks', '任务', 'งาน'],
  'tasks.count': ['Tasks ({n})', '任务（{n}）', 'งาน ({n})'],
  'tasks.none': ['No tasks yet: the loop plans from GOAL.md first.', '还没有任务：循环会先根据 GOAL.md 做规划。', 'ยังไม่มีงาน: ลูปจะวางแผนจาก GOAL.md ก่อน'],
  'tasks.col.id': ['ID', 'ID', 'รหัส'],
  'tasks.col.title': ['Title', '标题', 'ชื่อ'],
  'tasks.col.status': ['Status', '状态', 'สถานะ'],
  'tasks.col.tier': ['Tier', '层级', 'ระดับ'],
  'tasks.col.attempts': ['Attempts', '尝试', 'ครั้งที่ลอง'],
  'tasks.col.reviews': ['Reviews', '评审', 'รีวิว'],
  'tasks.col.verdict': ['Verdict', '结论', 'ผลรีวิว'],
  'budget.title': ['Budget', '预算', 'งบประมาณ'],
  'budget.session': ['This session {used} / {cap}', '本次会话 {used} / {cap}', 'เซสชันนี้ {used} / {cap}'],
  'budget.day': ['Today {used} / {cap}', '今日 {used} / {cap}', 'วันนี้ {used} / {cap}'],
  'budget.attempts': ['Attempts per task ', '每任务尝试 ', 'จำนวนครั้งต่องาน '],
  'budget.reviews': ['Review cycles ', '评审轮次 ', 'รอบรีวิว '],
  'budget.noProgress': ['No progress ', '无进展 ', 'ไม่มีความคืบหน้า '],
  'budget.note': ['Source: {source}. Only backends that report spend are counted; dsh headless does not, so its spend is not shown here.', '来源：{source}。只有会报告花费的后端才计入；dsh headless 不报告，所以它的花费这里看不到。', 'ที่มา: {source} นับเฉพาะแบ็กเอนด์ที่รายงานค่าใช้จ่าย dsh headless ไม่รายงาน จึงไม่เห็นค่าใช้จ่ายของมันที่นี่'],
  'events.title': ['Recent events', '最近事件', 'เหตุการณ์ล่าสุด'],
  'result.declined': ['Recorded: left for now (revision {revision}).', '已记录：先不处理（revision {revision}）。', 'บันทึกแล้ว: ปล่อยไว้ก่อน (revision {revision})'],
  'result.stillBlocked': ['Written (revision {revision}), but the next tick will stop again: {why}', '已写入（revision {revision}），但下一轮还会被挡住：{why}', 'บันทึกแล้ว (revision {revision}) แต่รอบถัดไปจะหยุดอีก: {why}'],
  'result.written': ['Written (revision {revision}). The loop continues on the next tick.', '已写入（revision {revision}）。循环会在下一轮接着跑。', 'บันทึกแล้ว (revision {revision}) ลูปจะทำงานต่อในรอบถัดไป'],
  'result.stale': ['The state changed and the page was refreshed. Look again before deciding.', '状态已经变了，页面已刷新。请看一眼再决定。', 'สถานะเปลี่ยนแล้วและหน้าได้รีเฟรช โปรดดูอีกครั้งก่อนตัดสินใจ'],
  'result.failed': ['Not done: {error}', '没有执行：{error}', 'ไม่ได้ดำเนินการ: {error}'],

  // The documents panel and the guide.
  'docs.title': ['Documents', '文档', 'เอกสาร'],
  'docs.none': ['No documents to show yet. Planning documents in {dir}/ (roadmap, tasks, acceptance…) and the PLAN / REVIEW / PROGRESS the loop writes appear here.', '还没有可看的文档。{dir}/ 里的 roadmap、tasks、acceptance 等规划文档，以及循环写下的 PLAN / REVIEW / PROGRESS 都会显示在这里。', 'ยังไม่มีเอกสารให้ดู เอกสารวางแผนใน {dir}/ (roadmap, tasks, acceptance…) และ PLAN / REVIEW / PROGRESS ที่ลูปเขียนจะแสดงที่นี่'],
  'docs.truncated': [' (first 64 KB only)', '（只显示了前 64 KB）', ' (แสดงเพียง 64 KB แรก)'],
  'docs.goal': ['Goal', '目标', 'เป้าหมาย'],
  'docs.planNote': ['Planning notes', '规划记录', 'บันทึกการวางแผน'],
  'docs.reviewNote': ['Review notes', '评审记录', 'บันทึกการรีวิว'],
  'docs.progressNote': ['Loop progress', '循环进度', 'ความคืบหน้าของลูป'],
  'docs.roadmap.md': ['Roadmap', '路线图', 'แผนงาน'],
  'docs.tasks.md': ['Tasks', '任务清单', 'รายการงาน'],
  'docs.progress.md': ['Progress', '仓库进展', 'ความคืบหน้า'],
  'docs.acceptance.md': ['Acceptance', '验收', 'การตรวจรับ'],
  'docs.architecture.md': ['Architecture', '架构', 'สถาปัตยกรรม'],
  'docs.spec.md': ['Spec', '规格', 'ข้อกำหนด'],
  'docs.research.md': ['Research', '调研', 'การค้นคว้า'],
  'guide.title': ['How to use it: from a repository to a delivery', '使用说明：从一个仓库到交付', 'วิธีใช้: จากรีโพจนถึงส่งมอบ'],
  'guide.roles': ['Recommended split: Codex plans, DeepSeek writes the code, Claude reviews and accepts (set in the web profile\'s plannerRoute / routing / reviewerRoute). Each task is done in its own worktree and merged only after review passes.', '推荐分工：Codex 做规划，DeepSeek 写代码，Claude 做评审和验收（在 web profile 的 plannerRoute / routing / reviewerRoute 里配置）。每个任务在独立的 worktree 里完成，评审通过才合并。', 'การแบ่งงานที่แนะนำ: Codex วางแผน DeepSeek เขียนโค้ด Claude รีวิวและตรวจรับ (ตั้งค่าใน plannerRoute / routing / reviewerRoute ของ web profile) แต่ละงานทำใน worktree ของตัวเอง และรวมเมื่อผ่านการรีวิวเท่านั้น'],
  'guide.prepare': ['Prepare the repository', '准备仓库', 'เตรียมรีโพ'],
  'guide.prepare.text': ['In Claude Code, run pilot status on the repository (clean up merged branches, check the tree is clean) and pilot plan (write the roadmap, task list and acceptance criteria under docs/agent/). The planner reads them.', '在 Claude Code 里对这个仓库跑 pilot status（清理已合并的分支、确认工作区干净）和 pilot plan（写出 docs/agent/ 下的路线图、任务清单、验收标准）。规划器会读这些文档。', 'ใน Claude Code ให้รัน pilot status กับรีโพ (ล้างสาขาที่รวมแล้ว ตรวจว่าไม่มีไฟล์ค้าง) และ pilot plan (เขียนแผนงาน รายการงาน และเกณฑ์ตรวจรับใน docs/agent/) ตัววางแผนจะอ่านเอกสารเหล่านี้'],
  'guide.branch': ['Switch to a work branch', '切到工作分支', 'สลับไปสาขาทำงาน'],
  'guide.branch.text': ['git switch -c devloop/<goal-name>. DevLoop merges each task into the current branch locally, never into main / master, and checks this at start and before every merge.', 'git switch -c devloop/<目标名>。DevLoop 把每个任务在本地合并进当前分支，从不合进 main / master；启动和每次合并前都会检查。', 'git switch -c devloop/<ชื่อเป้าหมาย> DevLoop รวมแต่ละงานเข้าสาขาปัจจุบันบนเครื่อง ไม่รวมเข้า main / master และตรวจสอบตอนเริ่มและก่อนรวมทุกครั้ง'],
  'guide.add': ['Add the project', '添加项目', 'เพิ่มโปรเจกต์'],
  'guide.add.text': ['Press "{browse}" below, select the repository, and press "{add}".', '点下面的「{browse}」，选中仓库，点「{add}」。', 'กด "{browse}" ด้านล่าง เลือกรีโพ แล้วกด "{add}"'],
  'guide.start': ['Write the goal and start', '写目标并启动', 'เขียนเป้าหมายแล้วเริ่ม'],
  'guide.start.text': ['Open the project page, check the start checks are all green, read the plan under "{docs}", then write the goal: which feature or task, the acceptance commands, the scope, what not to do. Press "{start}".', '进入项目页，先看启动检查全绿，再看「{docs}」里的规划，然后写目标：对应哪个 Feature / Task、验收命令、范围、不做什么。点「{start}」。', 'เปิดหน้าโปรเจกต์ ตรวจว่าการตรวจก่อนเริ่มเป็นสีเขียวทั้งหมด อ่านแผนใน "{docs}" แล้วเขียนเป้าหมาย: ฟีเจอร์หรืองานไหน คำสั่งตรวจรับ ขอบเขต และสิ่งที่ไม่ต้องทำ กด "{start}"'],
  'guide.watch': ['Watch it run', '看着它跑', 'ดูการทำงาน'],
  'guide.watch.text': ['The task table shows each task\'s state and acceptance criteria; "{docs}" shows the plan, review notes and progress. When it needs your decision the project shows "{question}", and you answer on the page.', '任务表显示每个任务的状态和验收标准；「{docs}」里能看到规划、评审记录和进度。需要你拍板时，项目会标「{question}」，页面上直接回答。', 'ตารางงานแสดงสถานะและเกณฑ์ตรวจรับของแต่ละงาน "{docs}" แสดงแผน บันทึกรีวิว และความคืบหน้า เมื่อต้องการการตัดสินใจของคุณ โปรเจกต์จะแสดง "{question}" และคุณตอบได้บนหน้านี้'],
  'guide.finish': ['Finish', '收尾', 'ปิดงาน'],
  'guide.finish.text': ['When the goal is done, open a PR from the devloop/<goal-name> branch, have PR-daemon review it, and merge it into the trunk once it passes.', '目标完成后，从 devloop/<目标名> 分支开一个 PR，交给 PR-daemon 评审，通过后再合并进主干。', 'เมื่อเป้าหมายเสร็จ เปิด PR จากสาขา devloop/<ชื่อเป้าหมาย> ให้ PR-daemon รีวิว แล้วรวมเข้าสาขาหลักเมื่อผ่าน'],
  'guide.after': ['You can pause from the project page at any time; a stopped project can be resumed, or removed from the list (the files in the repository stay as they are).', '随时可以在项目页暂停；已停下的项目可以恢复，或从列表里移除（仓库里的文件原样保留）。', 'หยุดชั่วคราวจากหน้าโปรเจกต์ได้ทุกเมื่อ โปรเจกต์ที่หยุดแล้วสามารถทำงานต่อ หรือนำออกจากรายการได้ (ไฟล์ในรีโพยังอยู่ตามเดิม)'],

  // Repository status and the PR record.
  'repo.title': ['Repository status', '仓库状态', 'สถานะรีโพ'],
  'repo.noResult': ['No result yet', '还没有结果', 'ยังไม่มีผล'],
  'repo.branch': ['Branch ', '当前分支 ', 'สาขาปัจจุบัน '],
  'repo.detached': ['(detached)', '（游离）', '(ไม่ได้อยู่บนสาขา)'],
  'repo.trunk': ['Trunk ', '主干 ', 'สาขาหลัก '],
  'repo.aheadBehind': ['Ahead / behind trunk ', '领先 / 落后主干 ', 'นำหน้า / ตามหลังสาขาหลัก '],
  'repo.uncommitted': ['Uncommitted changes ', '未提交改动 ', 'การแก้ไขที่ยังไม่คอมมิต '],
  'repo.delete': ['Delete selected branches', '删除选中的分支', 'ลบสาขาที่เลือก'],
  'repo.deleteConfirm': ['Delete the selected merged branches with git branch -d? git refuses any branch that is not merged or is checked out; no commit is lost.', '用 git branch -d 删除选中的已合并分支？git 会拒绝任何没合并或正被检出的分支；仓库里的提交不会丢。', 'ลบสาขาที่รวมแล้วที่เลือกด้วย git branch -d? git จะปฏิเสธสาขาที่ยังไม่รวมหรือกำลังเช็กเอาต์อยู่ ไม่มีคอมมิตใดหายไป'],
  'repo.noneSelected': ['No branch selected', '没有选中任何分支', 'ยังไม่ได้เลือกสาขา'],
  'repo.listSep': [', ', '、', ', '],
  'repo.deletedNames': ['Deleted {n} branch(es): {names}.', '已删除 {n} 个分支：{names}。', 'ลบแล้ว {n} สาขา: {names}'],
  'repo.deletedNone': ['Deleted no branches.', '没有删除任何分支。', 'ไม่ได้ลบสาขาใด'],
  'repo.refused': ['Not deleted: {list}', '没有删：{list}', 'ไม่ได้ลบ: {list}'],
  'repo.refusedOne': ['{name} ({reason})', '{name}（{reason}）', '{name} ({reason})'],
  'repo.protectDropped': ['Some entries in .pilot.yml protect_patterns have no effect: ', '.pilot.yml 的 protect_patterns 里有项不起作用：', 'บางรายการใน protect_patterns ของ .pilot.yml ไม่มีผล: '],
  'repo.paren': [' ({text})', '（{text}）', ' ({text})'],
  'repo.colon': [': ', '：', ': '],
  'repo.deletable': ['Merged branches that can go ({n})', '可以删除的已合并分支（{n}）', 'สาขาที่รวมแล้วซึ่งลบได้ ({n})'],
  'repo.nothingToDelete': ['None: merged branches are all cleaned up.', '没有：已合并的分支都清理过了。', 'ไม่มี: สาขาที่รวมแล้วถูกล้างหมดแล้ว'],
  'repo.manual': ['For you to do by hand ({n})', '需要你手动处理（{n}）', 'ต้องทำเอง ({n})'],
  'repo.kept': ['Branches kept ({n})', '保留的分支（{n}）', 'สาขาที่เก็บไว้ ({n})'],
  'repo.note': ['Only git branch -d is run, and only on local branches. Force deletes and removing worktrees are listed as commands for you to decide; remote branches are not handled here (turn on GitHub\'s delete-branch-on-merge).', '只会执行 git branch -d，只处理本地分支。强制删除、删 worktree 只列出命令，由你决定；远程分支不在这里处理（建议在 GitHub 开启合并后自动删除分支）。', 'รันเฉพาะ git branch -d และเฉพาะสาขาในเครื่อง การลบแบบบังคับและการลบ worktree จะแสดงเป็นคำสั่งให้คุณตัดสินใจ สาขาระยะไกลไม่ได้จัดการที่นี่ (แนะนำให้เปิดการลบสาขาอัตโนมัติหลังรวมบน GitHub)'],
  'prlog.title': ['PR record', 'PR 记录', 'บันทึก PR'],
  'prlog.count': ['PR record (latest {n})', 'PR 记录（最近 {n} 条）', 'บันทึก PR (ล่าสุด {n} รายการ)'],
  'prlog.none': ['Nothing recorded yet. With a pre-PR checker configured, every task\'s check and review verdict is recorded here (.devloop/PR-LOG.jsonl).', '还没有记录。配置了 pre-PR 检查器后，每个任务的检查结果和评审结论都会记在这里（.devloop/PR-LOG.jsonl）。', 'ยังไม่มีบันทึก เมื่อตั้งค่าตัวตรวจก่อนเปิด PR แล้ว ผลการตรวจและผลรีวิวของทุกงานจะถูกบันทึกที่นี่ (.devloop/PR-LOG.jsonl)'],
  'prlog.passed': ['Passed', '通过', 'ผ่าน'],
  'prlog.blocked': ['Blocked', '拦下', 'ถูกบล็อก'],
  'prlog.unavailable': ['No verdict', '无结论', 'ไม่มีผลตัดสิน'],
  'prlog.elastic': ['Elastic', '弹性', 'ยืดหยุ่น'],
  'prlog.over': ['Over', '超限', 'เกินกำหนด'],
  'prlog.review': ['Review {verdict}', '评审 {verdict}', 'รีวิว {verdict}'],
  'prlog.size': ['{lines} lines / {files} files', '{lines} 行 / {files} 文件', '{lines} บรรทัด / {files} ไฟล์'],
  'prlog.estimate': ['Estimated {lines} lines / {files} files', '预估 {lines} 行 / {files} 文件', 'ประมาณ {lines} บรรทัด / {files} ไฟล์'],
  'prlog.col.time': ['Time', '时间', 'เวลา'],
  'prlog.col.task': ['Task', '任务', 'งาน'],
  'prlog.col.result': ['Result', '结果', 'ผล'],
  'prlog.col.size': ['Size', '大小', 'ขนาด'],
  'prlog.col.rules': ['Rules / reviewer', '规则 / 评审者', 'กฎ / ผู้รีวิว'],
  'prlog.col.version': ['Rules version', '规则版本', 'เวอร์ชันกฎ'],
  'prlog.col.commit': ['Commit', '提交', 'คอมมิต'],
  'prlog.note': ['Limits (trial): each PR ≤200 lines, ≤5 files, ≤2 top-level directories. A little over (elastic) is still reviewed, and the reviewer is told by how much and judges whether it should have been split; further over is sent back to be split. A blocked row names the blocking rules, otherwise the advisory ones; a rules version with * means the checker had uncommitted changes.', '上限（试行）：每个 PR ≤200 行、≤5 个文件、≤2 个顶层目录；略超（弹性）照常评审，评审会被告知超了多少、判断该不该拆；超出更多（超限）打回重拆。拦下时标出的是阻断规则，否则是提示规则；规则版本带 * 表示检查器有未提交的改动。', 'ขีดจำกัด (ทดลอง): แต่ละ PR ≤200 บรรทัด ≤5 ไฟล์ ≤2 ไดเรกทอรีบนสุด เกินเล็กน้อย (ยืดหยุ่น) ยังรีวิวตามปกติ โดยผู้รีวิวจะรู้ว่าเกินเท่าไรและพิจารณาว่าควรแยกหรือไม่ เกินมากกว่านั้นจะถูกส่งกลับให้แยก แถวที่ถูกบล็อกจะแสดงกฎที่บล็อก ไม่เช่นนั้นแสดงกฎที่แนะนำ เวอร์ชันกฎที่มี * หมายถึงตัวตรวจมีการแก้ไขที่ยังไม่คอมมิต'],

  // The server's readiness checks, by the code it sends with each (src/readiness.ts).
  'ready.repo.notToplevel': ['This folder is not the top of a git repository (it was deleted or moved, or is a folder inside another repository), so it cannot start.', '这个目录不是一个 git 仓库的顶层（仓库被删除、移走，或它只是别的仓库里的子目录），不能启动。', 'โฟลเดอร์นี้ไม่ใช่ระดับบนสุดของรีโพ git (ถูกลบ ย้าย หรือเป็นโฟลเดอร์ย่อยในรีโพอื่น) จึงเริ่มไม่ได้'],
  'ready.branch.detached': ['HEAD is detached: DevLoop merges tasks into the current branch, and there is none. Switch to a branch first.', 'HEAD 是游离状态：DevLoop 会把任务合并到当前分支，而现在没有分支。先切到一个分支。', 'HEAD ไม่ได้อยู่บนสาขา: DevLoop รวมงานเข้าสาขาปัจจุบัน แต่ตอนนี้ไม่มีสาขา สลับไปที่สาขาก่อน'],
  'ready.branch.ok': ['On branch {branch}', '当前分支 {branch}', 'สาขาปัจจุบัน {branch}'],
  'ready.trunk.onTrunk': ['The repository is on {branch}, and DevLoop would merge every task straight into it. Switch to a work branch first, and merge back into {base} with a PR when done: {command}', '仓库停在 {branch} 上，DevLoop 会把每个任务直接在本地合并进它。先切到一个工作分支，做完再用 PR 合回 {base}：{command}', 'รีโพอยู่บน {branch} และ DevLoop จะรวมทุกงานเข้าสาขานี้โดยตรง สลับไปสาขาทำงานก่อน แล้วเมื่อเสร็จให้รวมกลับเข้า {base} ด้วย PR: {command}'],
  'ready.trunk.ok': ['Tasks merge into {branch}. If the checkout is switched back to {trunks} while it runs, it stops and asks you before merging.', '任务会合并到 {branch}。运行中如果检出被切回 {trunks}，合并前会停下来问你。', 'งานจะรวมเข้า {branch} ถ้าระหว่างทำงานมีการสลับกลับไป {trunks} ลูปจะหยุดถามคุณก่อนรวม'],
  'ready.clean.ok': ['No uncommitted changes to tracked files', '已跟踪的文件没有未提交的改动', 'ไม่มีการแก้ไขที่ยังไม่คอมมิตในไฟล์ที่ติดตาม'],
  'ready.clean.dirty': ['{n} tracked file(s) have uncommitted changes; every merge would be refused (after planning, implementing and reviewing were already paid for). Commit or stash first.', '有 {n} 个已跟踪文件有未提交的改动，每次合并都会被拒绝（而那时规划、实现、评审的钱已经花了）。先提交或 stash。', 'มีไฟล์ที่ติดตาม {n} ไฟล์ที่ยังไม่คอมมิต การรวมทุกครั้งจะถูกปฏิเสธ (หลังจากจ่ายค่าวางแผน พัฒนา และรีวิวไปแล้ว) คอมมิตหรือ stash ก่อน'],
  'ready.pilot.missing': ['No {file}, so {base} is taken as the trunk. Consider running pilot status / pilot doctor in Claude Code first: tidy the branches and record the real trunk.', '没有 {file}，按 {base} 当主干。建议先在 Claude Code 里跑 pilot status / pilot doctor：清理分支，并记下真实的主干。', 'ไม่มี {file} จึงใช้ {base} เป็นสาขาหลัก แนะนำให้รัน pilot status / pilot doctor ใน Claude Code ก่อน: จัดระเบียบสาขาและบันทึกสาขาหลักจริง'],
  'ready.pilot.ok': ['{file}: trunk {base}', '{file}：主干 {base}', '{file}: สาขาหลัก {base}'],
  'ready.pilot.okExternal': ['{file}: trunk {base}, planning declared outside the repository', '{file}：主干 {base}，规划声明在仓库外', '{file}: สาขาหลัก {base} แผนงานประกาศไว้นอกรีโพ'],
  'ready.plan.external': ['.pilot.yml declares planning outside the repository: the planner can only use GOAL.md and AGENTS.md / CLAUDE.md', '.pilot.yml 声明规划在仓库外：规划器只能参考 GOAL.md 和 AGENTS.md / CLAUDE.md', '.pilot.yml ประกาศว่าแผนงานอยู่นอกรีโพ: ตัววางแผนใช้ได้เพียง GOAL.md และ AGENTS.md / CLAUDE.md'],
  'ready.plan.found': ['The planner will read from {dir}/: {files}', '规划器会读 {dir}/ 里的：{files}', 'ตัววางแผนจะอ่านจาก {dir}/: {files}'],
  'ready.plan.none': ['No planning documents in {dir}/. pilot plan writes them; without them the planner only has GOAL.md.', '{dir}/ 里没有规划文档。pilot plan 会写出它们；没有的话规划器只能看 GOAL.md。', 'ไม่มีเอกสารวางแผนใน {dir}/ pilot plan จะเขียนให้ ถ้าไม่มี ตัววางแผนจะมีเพียง GOAL.md'],

  // Why the server keeps a branch, leaves something to you, or refused a delete (src/cleanup.ts).
  'cleanup.current': ['current branch', '当前分支', 'สาขาปัจจุบัน'],
  'cleanup.trunk': ['trunk', '主干', 'สาขาหลัก'],
  'cleanup.pattern': ['protected prefix (.pilot.yml protect_patterns, or release/hotfix/deploy)', '受保护前缀（.pilot.yml protect_patterns 或 release/hotfix/deploy）', 'คำนำหน้าที่ถูกป้องกัน (protect_patterns ของ .pilot.yml หรือ release/hotfix/deploy)'],
  'cleanup.worktree': ['checked out by a worktree', '被某个 worktree 检出', 'ถูกเช็กเอาต์โดย worktree'],
  'cleanup.active_task': ['a task the loop has not finished', '循环里还没完成的任务', 'งานที่ลูปยังทำไม่เสร็จ'],
  'cleanup.unmerged': ['not merged into the current branch yet', '还没合并进当前分支', 'ยังไม่ได้รวมเข้าสาขาปัจจุบัน'],
  'cleanup.unmergedTask': ['unmerged DevLoop task branch', '未合并的 DevLoop 任务分支', 'สาขางาน DevLoop ที่ยังไม่รวม'],
  'cleanup.dirtyWorktree': ['the worktree has uncommitted changes: look first', 'worktree 有未提交的改动，先看一眼', 'worktree มีการแก้ไขที่ยังไม่คอมมิต: ดูก่อน'],
  'cleanup.cleanWorktree': ['a clean worktree: remove it if it is no longer needed', '干净的 worktree，不需要了可以删', 'worktree ที่สะอาด: ลบได้ถ้าไม่ต้องใช้แล้ว'],
  'cleanup.notOffered': ['no longer on the list to delete (the state changed), so not deleted', '现在已经不在可删除列表里（状态变了），没有删', 'ไม่อยู่ในรายการที่ลบได้แล้ว (สถานะเปลี่ยน) จึงไม่ได้ลบ'],
  'cleanup.notMerged': ['git refused: the branch is not fully merged', 'git 拒绝：分支没有完全合并', 'git ปฏิเสธ: สาขายังรวมไม่ครบ'],
  'cleanup.checkedOut': ['git refused: the branch is checked out by a worktree', 'git 拒绝：分支被某个 worktree 检出', 'git ปฏิเสธ: สาขาถูกเช็กเอาต์โดย worktree'],
  'cleanup.gitRefused': ['git refused to delete this branch', 'git 拒绝删除这个分支', 'git ปฏิเสธการลบสาขานี้'],

  // Why a .pilot.yml protect_patterns entry has no effect (src/readiness.ts).
  'protect.glob': ['wildcards have no effect: protection matches a literal prefix', '通配符不起作用：保护按字面前缀匹配', 'ไวลด์การ์ดไม่มีผล: การป้องกันจับคู่คำนำหน้าตามตัวอักษร'],
  'protect.invalid': ['not a valid branch name', '不是合法的分支名', 'ไม่ใช่ชื่อสาขาที่ถูกต้อง'],
}
