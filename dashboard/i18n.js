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
    return saved in LANG_INDEX ? saved : 'en'
  } catch {
    return 'en'
  }
})()

function setLang(lang) {
  if (!(lang in LANG_INDEX)) return
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
  'status.merge_ready': ['Ready to merge', '待合并', 'พร้อมรวม'],
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
  'doing.merge': ['Merging {task}.', '正在合并 {task}。', 'กำลังรวม {task}'],
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
  'start.intro': ['Write the goal for this work. Once saved as .devloop/GOAL.md, the loop plans it into tasks, then has models implement, review and merge them one by one.', '写下这个需求的目标。保存为 .devloop/GOAL.md 后，循环会先规划出一系列任务，再逐个交给模型实现、评审、合并。', 'เขียนเป้าหมายของงานนี้ เมื่อบันทึกเป็น .devloop/GOAL.md แล้ว ลูปจะวางแผนเป็นงานย่อย แล้วให้โมเดลพัฒนา รีวิว และรวมทีละงาน'],
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
}
