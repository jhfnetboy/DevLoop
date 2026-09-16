# Phase: run — 无人值守交付循环（跑到交付为止，不是跑一轮就停）

**一次调用 = 一直干到交付**。不是「推进一步就收工」——`run` 会**连续迭代**：处理回执 → 开下一个
task → 等评审 → 合并 → 再挑下一个，**直到 §3 的交付条件全部满足**，或撞上必须由人拍板的
`BLOCKED`。绝不并行动多个 task（一次一个 task，但一个接一个不停）。

## 步骤 0：起跑前的两道闸（顺序不可颠倒，都不可跳过）

### 0a. 文档齐全门禁（**FAIL-CLOSED，不齐不许跑**）
无人值守意味着**半夜没人回答「你这里什么意思」**——规划层的每一个空档，都会变成模型独自替你
拍板的猜测。所以先跑确定性检查，不靠眼力判断：

```bash
bash <skill>/scripts/check-docs.sh --docs-dir <docs_dir> --strict
```

- `rc=0` → 规划层齐全且**已填写**（脚本会识别「还是原样模板」——占位符没填等于没答，比没有更危险），继续 0b。
- **`rc≠0` 一律停下**（`1`=有缺口，`2`=用法/参数错，例如 `PILOT_DOC_MIN_BYTES` 不是正整数）。把脚本输出原样报给用户；`rc=1` 时建议 `pilot plan` 补齐。**不要把非零当成「大概能跑」**。
- **规划已经在别处的仓库**（backlog.md / issue tracker / 别的工具）：不要为了过门禁去把已有规划重抄一份到七件套里——那正违反 plan.md §A.3。在 `.pilot.yml` 里写 `planning_source: external`，门禁会放行并打印 `NOTHING WAS CHECKED`。**这条放行是人担保的，不是脚本核实的**：汇报时照实说「本仓库声明规划在别处、门禁未核实」，绝不能写成「规划已验证」。
  **不许带着缺口开跑**，也不许自己动手把文档编出来替用户拍板（违反 SKILL.md 硬约束 7）。
- 用户明确说「有人盯着、先跑起来」→ 才可降级 `--minimal`（只要 roadmap+tasks+progress），
  并在汇报里写明**这是降级运行、缺哪几份文档**。降级是用户的决定，不是你的。
- **`PILOT_DOC_MIN_BYTES`（一份文档要有多少实质内容才算填过，默认 120 字节 ≈ 40 汉字）**：
  这是唯一能从环境里削弱门禁的旋钮，**别自己设**。脚本拒绝 `0` 和非整数值（那等于关掉门禁而非调参），
  且每次都会在 `PILOT_DOCS:` 行回显生效值 —— 汇报时把那行原样带上，让用户看得见门槛是多少。

### 0b. 交出 `/goal` 交付契约（**这就是 `run` 的主产出**）

**`run` 是发模板的，不是自己闷头开干的。** 无人值守的动力来自 Claude Code 内置的 `/goal`
（`Set a goal Claude checks before stopping`）——它在**会话层**拦住「活没干完就收工」，是本 skill
拿不到的那层强制力（skill 只有 §3 的自我纪律，模型自己可以忘；`/goal` 由 harness 在每次想停下来
时检查，忘不掉）。所以 `run` 这一步的**交付物就是一条填好的 `/goal` 命令**。

做法：

1. **Read `<skill>/templates/goal.md`**（和本文件其它路径一样带 `<skill>/` 前缀——写成相对路径会按 CWD 解析而读不到，届时只能凭记忆编契约，正是这个模板要防的事）,取「标准版」整段。
2. 把 `<M1/全部>`、`<集成分支>` 换成本仓库真实值（从 `.pilot.yml` 和 `roadmap.md` 取）。
   用户已经给了具体目标（「把 M1 做完」）→ 用用户的话当首句，后面四段 `【】` **照抄不动**。
3. **把整条命令放在回复最显眼处，请用户直接执行**，并说明「执行后我就按这个契约一路做到交付」。

那五个 `【】` 段不是口号，是操作契约，各锁一个失效模式：怎么用 `docs/agent/` 的规划、怎么验证才
算做完、PR 由外部评审服务裁决要怎么等、等待期间继续干什么、什么时候才允许停。**少写哪段就会
退化成哪种毛病**（见 `goal.md` 末尾对照表）。

> **为什么是「交给用户执行」而不是「我自己调用」**：斜杠命令由 harness 派发；本 skill 的
> `allowed-tools` 未包含任何斜杠命令派发工具，因此调不了（不同环境的工具集可能不同，但本 skill
> 的授权范围是确定的）。这不是绕不过的缺陷——`/goal` 本来就该由用户来定「什么
> 算交付完成」，pilot 的职责是把那段难写的契约**写好递到手上**，用户看一眼就知道自己授权了什么。
>
> **用户没执行 `/goal` 怎么办**：照样按 §3 一路干到交付，**绝不因为没设 goal 就退回「一轮就停」**。
> 设了 = 双层保险（harness 闸 + skill 纪律），没设 = 单层，但目标不变。

## 前置配置
读 `.pilot.yml` 取 `base_branch`、`integration_branch`、`remote`；**若无 `.pilot.yml` 但有旧的 `.repo-pilot.yml`，读旧文件并警告迁移**（见 SKILL.md「迁移兜底」——静默忽略会用错集成分支）。

## 主循环：每一迭代的决策顺序（从上到下，命中即执行，**做完回到本表顶端再来一遍**）

> **不要执行完一条就收工。** 每条动作末尾的「→ 回到顶端」是字面意思：立刻重新走一遍
> §1→§2→§2.5→§3，直到 §3 的交付条件满足。唯一允许停下的地方是 §3 和「必须由人拍板的
> BLOCKED」。等评审也不算停——按 §PR 监控节奏等，等到回执继续干。

### 0. 安全前置
- `git status` 看当前分支与改动。若在主干（main/master）且有未提交改动 → 停下报告，不自动处理。
- 绝不 `git add -A`；绝不直推主干；一个 task 一个分支一个 PR；**开发一律在 Feature 专属 worktree 里，绝不在主 checkout**（`git-guard.sh add` 在主 worktree 会硬拒绝，见 §2 第 2 步）。
- **暂存/推送/合并三个危险动作一律走 `scripts/git-guard.sh`**（脚本层硬拦截），不要裸用 `git add`/`git push`/`gh pr merge`。
- **保护分支是自动的**：`git-guard.sh` 每次运行都**自己直接读本仓库根的 `.pilot.yml`**（`base_branch`/`integration_branch`/`protect_patterns`），无需你传任何东西——因为 run 的每一步是**独立的 Bash 调用**，变量/env 都不跨步存活，靠调用者传 `--protect`/`export` 会静默失效。所以底下的 `push`/`merge-pr` 直接调即可，护栏已覆盖本仓库真实分支。
  ```bash
  #   bash <skill>/scripts/git-guard.sh push <remote> <branch>
  #   bash <skill>/scripts/git-guard.sh merge-pr <n> --integration <b> --squash
  #   # 单主干仓库（integration_branch == base_branch）必须再加 --allow-trunk，否则被硬拒绝
  #   bash <skill>/scripts/git-guard.sh merge-pr <n> --integration <b> --squash --allow-trunk
  ```
  （内置 main/master/develop/preview/integration/release/hotfix + .pilot.yml 实际值，前缀匹配。仅当要临时补充 .pilot.yml 之外的分支时，才可选加 `--protect "<csv>"`。）

### 1. 有 PR 已被 review → 先处理回执
运行 `bash <skill>/scripts/pr-monitor.sh`，对我的每个 open PR：
- **`decision=APPROVED` 且 checks 通过** → 合并进**集成分支**（不是主干）：
  `bash <skill>/scripts/git-guard.sh merge-pr <n> --integration <integration_branch> --squash`
  **单主干仓库**（`.pilot.yml` 里 `integration_branch` == `base_branch`，PR 直接开向主干）**必须再加 `--allow-trunk`**：
  `bash <skill>/scripts/git-guard.sh merge-pr <n> --integration <integration_branch> --squash --allow-trunk`
  ——不加就会被 git-guard 硬拒绝（`integration '<b>' is a trunk branch`，rc=3），无人值守就停在这一步。
  它**不是绕过**：仍要求该分支的保护规则要求审批、这个 PR 已 `APPROVED`、且该分支开启了 stale-dismissal，
  三条任一读不到就 fail-closed 拒绝（见 SKILL.md §doctor 第 4 步）。
  （git-guard 会先校验 PR base == `integration_branch`，base 是其它分支会被拒绝；**不加 `--delete-branch`**——分支清理统一交给 §合并后的 safe-cleanup。）

  > 🔴 **谁 approve、谁合并（2026-08-23 定，被一次真实卡死逼出来的）**
  >
  > **APPROVE 必须来自独立评审账号，不能来自 PR 作者本人 —— GitHub 从机制上不允许作者
  > approve 自己的 PR。** 所以「让人来 approve、agent 只管合并」这个分工，在**人就是作者**
  > 的仓库里根本走不通：那个按钮对他是灰的，`reviewDecision` 会一直停在 `REVIEW_REQUIRED`，
  > `mergeStateStatus=BLOCKED`，无人值守循环就卡死在这一步，而且看起来像是「在等人」。
  >
  > 实际可跑的分工只有一种：
  >
  > | 角色 | 做什么 |
  > |---|---|
  > | 独立评审账号（本机是 `clestons`） | 出 `APPROVED` / `CHANGES_REQUESTED` —— 这是 ruleset 要的那一票 |
  > | agent（你） | 拿到该账号的 APPROVE 后**执行合并**，走 `git-guard.sh merge-pr`，绝不 `--admin` |
  > | 人 | **拍板与叫停** —— 决定要不要合、要不要推翻评审结论，而不是去点 approve |
  >
  > 汇报时要说「已由 `<评审账号>` APPROVE，我据此合并」，**不要写成「已获用户批准」** ——
  > 用户的授权是口头的拍板，跟 GitHub 上那一票是两回事，混为一谈会让事后审计对不上。
  >
  > ⚠️ 另一半同样要记：分支若开了 `dismiss_stale_reviews_on_push`，**作者每推一次新
  > commit，上一条 APPROVE 就作废**。所以「已经批过了」不能当成当前状态，合并前必须
  > 重新读一次 `reviewDecision`；拿到 `REVIEW_REQUIRED` 就是要重新评审，不是脚本出错。
  > （实例：`iDoris-ai/Agent24#141`，作者 push 后 APPROVE 被作废，重新评审 + 重新 APPROVE
  > 之后 `mergeStateStatus` 才从 `BLOCKED` 变 `CLEAN`。）
  合并后：把对应 Task 在 `tasks.md` 标 `DONE`、更新 `progress.md`，运行
  `bash <skill>/scripts/safe-cleanup.sh --squash-merged --integration <integration_branch> [--protect "<protect_patterns>"] [--remote-name <remote>] --apply`
  清掉本地已合并分支/worktree（**必须显式带上与 `.pilot.yml` 一致的 `--integration`/`--protect`，不要依赖脚本猜默认值**）。脚本只会 `git branch -d`；squash 合并的分支和 worktree 它**只列出来**，把清单原样报给用户，不要代劳删。**远程分支脚本不处理**——让用户在仓库设置里开 GitHub 的 auto-delete-on-merge。**做完回到主循环顶端,继续下一项。**
- **`decision=CHANGES_REQUESTED`** → 读全部 review 意见（`gh pr view <n> --comments`），**先做中立 triage（见 `reference/review-triage.md`）**：装上本仓库业务上下文（CLAUDE.md / docs/agent / 领域文档），把每条意见分成 A 该修 / B 不重要 / C 缺业务上下文判错了 / D 过激 nitpick。外部评审是独立的、没有业务背景,你有——**既不盲改也不盲拒**。
  - **A（+trivial 的 D）** → 在该 PR 分支**所属的 Feature worktree 里**修复 → 自测 → 自审 → `git-guard.sh add <显式路径>` + commit + `git-guard.sh push <remote> <branch>`（推新 commit 自动触发再评审）。worktree 已被清掉/不存在 → 重建后再修：`git worktree add ../<repo>-<Fid> <该PR分支>`（已有分支不带 `-b`）。**不要图省事在主 checkout 里检出 PR 分支改**——git-guard 会拒绝 staging。
  - **B（真问题但不阻塞）/ 非 trivial 的 D 里决定要做的** → **记进跟进账本,绝不丢**：
    `bash <skill>/scripts/followups.sh add --docs-dir <docs_dir> --class B --source "PR#<n>" --desc "<要做什么>"`。
    **不在本 PR 里做**——留到主线全清后批量合成一个 cleanup PR（见 §2.5）。
  - **C / 不做的 D** → **不改**，`gh pr comment <n>` 回一条讲清业务理由（让下一轮评审和人类都看到）。
  - 把 Task 标 `CHANGES_REQUESTED→IN_PROGRESS`，更新 progress.md。**把 followups.md 一起 `git-guard.sh add` 进本次 commit**（账本随分支合并落库,不留在工作区）。**做完回到主循环顶端,继续下一项。**
- **`decision=APPROVED` 但带 review comments** → 先按上面 APPROVED 分支**合并**（comment 不阻塞合并）。合并后对每条 comment 过 triage：A/B 用 `followups.sh add --docs-dir <docs_dir>` 记进账本；C/D 在 PR 上回一句说明即可，不在已合并分支补提。**做完回到主循环顶端,继续下一项。**
- **`decision=PENDING`**（还没拿到裁决）→ 正常,按契约还在 20 分钟窗口内。按 §PR 监控节奏继续等,**不要在 PENDING 的 PR 上瞎改**,也不要因此停下——回主循环做下一个 task。

> 裁决由**外部评审服务**做（契约见 `reference/review-contract.md`），本 skill 不自评自审 PR 的最终裁决。我只负责：开好 PR、盯住状态、按回执修、approve 后合并。

### 2. 无待处理回执 → 挑一个新 READY task 开工
从 `tasks.md` 选**优先级最高、依赖已满足**的 `READY` task（一次只选一个）：
1. 标 `READY→IN_PROGRESS`，更新 progress.md。
2. **进入 Feature 专属 worktree 建分支（硬性，任何仓库都无豁免）**：worktree 按 **Feature** 分组——`<taskid>` 形如 `T1.2.3` → Feature id `F1.2`，目录 `../<repo>-F1.2`。先 `git worktree list` 查它在不在：
   - **不存在**（本 Feature 的第一个 task）→ 随分支一起建：`git worktree add ../<repo>-<Fid> -b <type>/<taskid>-<slug> <integration_branch>`。
   - **已存在**（同 Feature 的后续 task）→ 在其中直接建分支：`git -C ../<repo>-<Fid> checkout -b <type>/<taskid>-<slug> <integration_branch>`（从 ref 建**新**分支不需要检出该 ref 本身，不会撞「integration 已在主 checkout 检出」的限制）。
   - 之后第 3–8 步的实现/自测/staging/commit/push **全部在这个 worktree 目录里执行**，主 checkout 只读。**没有「简单仓库可以只建分支」的豁免**——`git-guard.sh add` 在主 worktree 里会硬拒绝 staging（可见例外口子 `PILOT_ALLOW_PRIMARY=1`，仅限用户明确拍板）。
   - Feature 的全部 task 合并后，worktree 照旧走 safe-cleanup **只列不删**（SKILL.md 硬约束 4）。
3. **实现**：对照 `architecture.md`/`spec.md` 写代码，范围严格限制在该 task 的「开发范围」，不顺手做别的。
4. **自测**：先针对性测试，再 lint → typecheck → build → 集成测试。有失败就修到全绿。
5. **对抗式 review**（PR 前必做，见 `reference/pr-quality.md`）：换新上下文/子 agent 或 Codex（`/codex:rescue`），以「找 race/安全/错误处理/边界/生产失败」的挑剔视角审这段 diff。有阻塞问题 → 修 → 重新自测 → 再挑战，直到无阻塞。
   **审几轮不由你自己说了算**：跑 `bash <skill>/scripts/grade-change.sh` 拿 `ROUNDS=`（A/B 级 = 3 轮，每轮换一个 lens），规则见 [`reference/pre-pr-review.md`](../reference/pre-pr-review.md)。
6. **自审 diff**：`git diff` 逐块看，确认没有调试代码、密钥、无关改动。**别指望 pre-commit 钩子兜底**——先 `bash <skill>/scripts/check-hooks.sh`,若报 `BYPASSED`(hooksPath 指到别处/空目录),commit 时的密钥扫描根本没跑,这一步的人肉排查就是**唯一防线**,务必逐字节看清无密钥/token/`.env`/私钥。
7. **提交**：`git status` → **`bash <skill>/scripts/git-guard.sh add <逐个显式路径>`**（绝不 `-A`/`.`，git-guard 会硬拒绝）→ `git commit`（conventional commit）→ **`bash <skill>/scripts/git-guard.sh push <remote> <branch>`**（推主干会被硬拒绝）。
8. **开 PR**：先 `bash <skill>/scripts/preflight.sh run`（跑本仓库自己的检查，全绿才写戳记），再**走闸门**开 PR：
   ```bash
   bash <skill>/scripts/git-guard.sh pr-create --base <integration_branch> --title ... --body ...
   ```
   **绝不裸用 `gh pr create`**——闸门会拒绝「检查没跑过 / 戳记属于别的 commit」的 PR，裸调等于绕过它，
   那道强制就形同虚设（它一度确实零调用：没有任何文档指引用它）。
   body 写清 task、验收命令、自测结果。**绝不 `--admin` 直合，绝不推主干。**
9. 把 Task 标 `IN_PROGRESS→PR_OPEN`，在 tasks.md/progress.md 记 PR 链接。**回到主循环顶端继续**——同时按 §PR 监控节奏盯这个 PR 的裁决（外部评审服务会处理它,见 `reference/review-contract.md`;pilot 不启动也不关心那个服务）。

### 2.5 无 READY task 了 → 批量清跟进账本（主线做完才做，绝不提前）
**只有当 §2 没有可开工的主线 READY task**（都 DONE 或在 PR_OPEN/BLOCKED）时，才处理跟进账本：
1. `n=$(bash <skill>/scripts/followups.sh count-open --docs-dir <docs_dir>)`。为 0 → 跳到 §3。
2. `>0` → **把这些小项合并成一个 cleanup PR 一次做掉**（不是一项一个 PR）：
   - `followups.sh list --open --docs-dir <docs_dir>` 拿到全部 OPEN 项；建一个分支 `chore/followups-<date>`（从集成分支）——**同样硬性走专属 worktree**：`git worktree add ../<repo>-followups -b chore/followups-<date> <integration_branch>`，修复都在里面做，不进主 checkout。
   - 逐条修复（都是小/非阻塞项）；一个 commit 或按主题分几个 commit，`git-guard.sh add` 显式路径（**含 followups.md**）。
   - 对每条修好的 `followups.sh done FU-<n> --pr <本PR号> --docs-dir <docs_dir>` 标掉（append-only,只翻 [x] 不删行）。
   - `git-guard.sh push` → `gh pr create --base <integration_branch>`（title 如 `chore: batch followup fixes (FU-3, FU-7…)`，body 列清每条对应的原 PR/comment）→ 走正常评审→合并。
   - **判断力**：某条其实是真 feature/bug 规模的 → 不塞进批量,**提升为 tasks.md 里的正常 READY task**,走单独流程。批量只装小/相关的。
3. 账本里还有 OPEN 项没清完 → 下一轮继续；**清空前不进 §3**。

### 3. 交付条件（**唯一允许收工的地方**）
只有下面**全部**为真才算交付完成，才可以停：

1. `tasks.md` 里没有 `READY` task（全部 `DONE`，或卡在需人拍板的 `BLOCKED`）；
2. 没有还没拿到裁决/还没合并的 open PR（`pr-monitor.sh` 查确认）；
3. `bash <skill>/scripts/followups.sh count-open --docs-dir <docs_dir>` **为 0**
   （**不许在有 OPEN 跟进项时宣布交付** —— 有就回 §2.5 清完再来）。

**任一条不满足 → 回主循环顶端继续干，不许收工。** 尤其注意这几种「假完成」：
- 「PR 开了在等 review」→ **不是完成**，按 §PR 监控节奏等回执，拿到就继续。
- 「就剩几个小 followup」→ **不是完成**，§2.5 批量清掉。
- 「这一轮没什么可做的」→ 先按上面三条逐条查证，别凭感觉宣布。

**只有 `BLOCKED` 可以提前中断**：确实需要用户拍板产品方向/验收/架构时，把 task 标 `BLOCKED`、在
`progress.md` 写清待决问题，**先把不受它影响的 task 全做完**，最后才带着问题清单停下来问。

交付时的汇报：做完了哪些 task、合并了哪些 PR、清了哪些 followup、还剩什么 BLOCKED 待你拍板。
不要制造无意义的空 commit。

## PR 监控节奏（提交 PR 后怎么等回执）

**核心规则：只要提了 PR，就要盯住它的状态,直到拿到裁决再决定下一步。**

pilot **不裁决自己的 PR**——外部评审服务做这件事,契约见
[`reference/review-contract.md`](../reference/review-contract.md):
**开 PR 后 5–10 分钟内排队,再 5–10 分钟出裁决,通常 20 分钟内结束**(超大 PR 例外)。
那个服务是什么、装在哪、覆盖哪些仓库——**pilot 不知道也不需要知道**,更不去启动它。
pilot 这一侧只有一件事:**轮询自己 PR 的状态**。

1. **盯回执**:脚本是 `pr-monitor.sh`(读 `reviewDecision`,查一次就返回,不自我驱动)。
   真正的监控 = 有东西按节奏反复调它、状态变了再唤醒你行动。按场景选驱动方式:
   - **默认(刚开完 PR、想立刻盯到回执)→ 用 Monitor 工具**:轮询
     `bash <skill>/scripts/pr-monitor.sh --pr <n>`,**3–5 分钟一次**,
     **并设 30 分钟硬上限**:拿到 `APPROVED`/`CHANGES_REQUESTED` 就唤醒回 §1 行动;
     **到点仍是 `PENDING` 也要唤醒**,走第 3 步的超时处理。
     没有上限,服务不存在时 `PENDING` 永远不变,agent 会无限期睡死。
     (`REVIEW_REQUIRED` 与空值已在脚本里归一化为 `PENDING`——它们都表示「还没有裁决」。)
   - **通宵推多个 task → `/loop 10m pilot run`**:每轮 `run` 开头的 §1 自动扫所有 open PR 的回执并行动。
   - 想比固定间隔更聪明地退避 → `ScheduleWakeup` 自排下次唤醒。

   > 别用裸 `sleep` 空转终端等回执——既占着会话又不省 token。要么 Monitor(条件唤醒)、要么 /loop(定时重跑)。

2. **等待期间继续干活**:等回执**不算停工**。回主循环挑下一个 READY task 开工——
   一个 PR 卡住不该让整条线停摆。

3. **到 30 分钟上限仍 `PENDING`**(PR 已开多久看 `pr-monitor.sh` 的 `age_min`):说明外部评审服务这会儿没在覆盖本仓库。
   这**不是 pilot 能修的**,别反复重试、别猜原因、更别自己给自己 approve。
   → **如实告诉用户**「PR #N 已开 X 分钟仍无评审,可能需要人工 review」并给出链接,
   然后**回主循环做下一个 task**,不要空转。

4. **拿到裁决后**回到 §1 按结果行动:
   `APPROVED`→合并 / `APPROVED`+comment→合并后把 comment 过 triage / `CHANGES_REQUESTED`→triage+修+推。
   **推新 commit 会自动触发下一轮评审**,回到本节继续等——
   一个 PR 可能经历多轮「评审→修→再评审」才合并,**每轮都要重新等,别因为等过一次就跳过监控**。

## 无人值守纪律
- 遇到影响产品方向/验收/架构的未知 → 把 task 标 `BLOCKED` + 在 progress.md 记待决问题，跳过它做别的，**绝不替用户拍板**。
- 每一步都落到 `tasks.md` + `progress.md`；宁可文档啰嗦，不可与仓库真实状态脱节。
- 任何一轮都不得违反全局硬约束（见 SKILL.md）：不 `add -A`、不直推/直合主干、一 task 一分支一 PR、**一 Feature 一专属 worktree（开发不进主 checkout）**、删分支只 `-d` 且只删已合并+干净。

