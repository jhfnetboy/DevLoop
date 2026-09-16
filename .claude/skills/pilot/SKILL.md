---
name: pilot
version: 1.5.0
description: 仓库级开发操作系统。三阶段驱动一个仓库从「盘点 → 规划 → 持续开发」全流程。status=汇报进展+安全清理已合并分支/worktree；plan=建立/汇报 Milestone→Feature→Task 三级规划；run=先交出一条填好的 /goal 交付契约(说清怎么用 plan 的文档、怎么验证、PR 由外部评审服务裁决要怎么等、什么时候才算交付),再照它连续迭代做到交付;起跑前强制检查规划文档齐全。当用户说 pilot / 整理仓库 / 汇报进展 / 清理分支 / 规划里程碑 / 持续开发 / 跑通宵开发时使用。
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, TodoWrite, Monitor, ScheduleWakeup
---

# pilot — 仓库级开发操作系统

一个 skill、三个阶段，把「一个仓库」从盘点带到持续开发。可移植到 Claude Code 与 Codex。

> **pilot 是唯一入口 skill，其余 skill(飞书文档源、Notion、…)都是配套和附属。** 配套能力该不该装、装哪个、装到全局还是项目级、装完怎么验证，由 pilot 安排——见 `reference/doc-sources.md`。
> **注意「入口」是编排责任，不是运行时依赖**：pilot 不 import、不启动任何配套 skill，只探测能力在不在，不在就说明缺什么并降级。硬依赖曾经让 pilot 和一个外部 daemon 死锁在一起，花了 6 轮评审才拆干净——「pilot 是入口」不是把它写回去的理由。

```
pilot status   # 汇报进展 + 安全清理已合并分支/worktree（默认 dry-run）
pilot plan     # Milestone(M1) → Feature(F1.1) → Task(T1.1.1) 三级规划
pilot run      # 交出一条填好的 /goal 交付契约,然后照它一路做到交付(起跑前文档门禁)
pilot resume   # run 的别名:优先处理待办 PR,再挑新 task
pilot doctor   # 自检本地就绪度（config/docs/分支/gh/hook）——**不含**外部评审服务
```

## 分派（第一步永远先做这件事）

从用户输入解析第一个词作为**子命令**，其余作为 flag：

| 子命令 | 打开并严格执行 | 说明 |
|:---|:---|:---|
| `status`（默认） | `phases/status.md` | 无子命令时默认走 status |
| `plan` | `phases/plan.md` | |
| `run` / `resume` | `phases/run.md` | **发 `/goal` 契约 + 无人值守交付循环**:跑到交付为止,不是一轮就停 |
| `doctor` | 见下方 §doctor | 轻量自检，不改动仓库 |

解析后**必须先 Read 对应的 `phases/*.md`**，按其步骤执行；本文件只定义分派与全局硬约束。

## 全局硬约束（任何阶段都不可违反）

这些是「有经验的程序员」的底线，写死在这里，任何子命令都遵守。

**分层强制（谁才是真正的保证）**：
- **机械强制层（不可绕过、非劝告）= 真正的保证**：① GitHub **分支保护**（服务端兜底：主干需 PR + 审批，`enforce_admins`）；② 待建的 Claude Code plugin **PreToolUse hook**（在工具边界拦截模型真正要跑的 `git add -A`/推主干/危险合并，用真运行时判断、让 git 自己解析，模型忘不了也绕不过——见 backlog **TASK-40**，本 skill 的**首要强制手段**）。
- **便利包装 + 纵深防御一层（best-effort）= `scripts/git-guard.sh` / `safe-cleanup.sh`**：覆盖常见危险形状（`add -A`、直推主干、合并 base≠集成分支、只 `-d` 删已合并+干净），日常危险动作**优先走这两个脚本**。但它们是 bash 劝告式包装——**不承诺对抗式滴水不漏**（bash 解析有害字符串本质上有边角），真正兜底靠上面的机械层。

危险动作优先走 git-guard/safe-cleanup，不裸用 git/gh。

1. **绝不 `git add -A` / `git add .`**。只 `git-guard.sh add <显式路径>`（裸 `git add -A` 会被 git-guard 拒绝）。理由：`-A` 会把未确认是否该跟踪的文件（密钥、`.env`、构建产物、临时文件）一起提交，是最危险的日常动作。提交前先 `git status` 看清，逐一列出要提交的路径。
2. **绝不直接 push 到主干（main/master），绝不直接合并自己的 PR 到主干**。push 走 `git-guard.sh push`、**开 PR 走 `git-guard.sh pr-create`**(先 `preflight.sh run` 让本仓库的检查真跑过)、合并走 `git-guard.sh merge-pr --integration <b>`（推主干 / 合并 base≠集成分支都会被硬拒绝）。所有代码变更走：feature 分支 → PR → review → 合并到**集成分支**（默认 `preview`，见 `.pilot.yml`）。主干只由集成分支经受控流程进入。**单主干仓库**（没有集成分支，PR 直接开向 `main`）加 `--allow-trunk`——它**不是绕过**：仍要求该分支的 GitHub 保护规则要求审批、且这个 PR 已经 `APPROVED`，读不到保护规则就拒绝（fail-closed）。
3. **一个 task = 一个分支 = 一个 PR；一个 Feature = 一个专属 worktree（硬性，不再可选）**。开发绝不发生在主 checkout：开工某 Feature 的第一个 task 时建 `git worktree add ../<repo>-<Fid> -b <分支> <integration>`；同 Feature 的后续 task 在这个 worktree 里 `git checkout -b <新分支> <integration>`（从 ref 建新分支不需要检出该 ref，不会撞「integration 已在主 checkout 检出」的限制）。不属于任何 Feature 的开发分支（`chore/followups-*`、规划文档分支）同样单独开 worktree。主 checkout 只用于读代码、盘点、合并操作。**机械强制**：`git-guard.sh add` 在主 worktree 里直接拒绝 staging（可见的例外口子 `PILOT_ALLOW_PRIMARY=1`，仅限用户明确拍板的场景）。不在一个分支里顺手做别的 task。worktree 的**清理**仍受第 4 条管辖——只列出来，删除由人执行。
4. **绝不 `git branch -D`，绝不 `git push --delete`，绝不 `git worktree remove`**（最后这条是文件系统删除，会连 gitignore 掉的文件一起抹掉，而 `git status --porcelain` 看不见它们）。脚本唯一会执行的删除是 `git branch -d`——git 自己会拒绝未合并的、以及被 worktree 占用的，这是安全网。worktree 和远程分支只**列出来**给人。一切经 `scripts/safe-cleanup.sh`，默认 dry-run。**squash-merge 仓库**里 `git branch --merged` 通常为空，`--squash-merged` 会按 commit 向 GitHub 核实哪个已合并 PR 引入了它，**但只把结果列出来给人，脚本不执行 `-D`**——不可逆的那一下由人来敲（详见 `reference/git-safety.md`）。
5. **PR 之前必须自审 + 对抗 review**（怎么审见 `reference/pr-quality.md`，**审几轮由 `scripts/grade-change.sh` 机械定级，见 `reference/pre-pr-review.md`**——A/B 级 3 轮，不是作者自己说了算）。没过 review 的代码不进 PR，没 approve 的 PR 不合并。
6. **状态即文档**。每推进一步都更新 `docs/agent/tasks.md` 与 `docs/agent/progress.md`；宁可慢，不可让文档与仓库真实状态脱节。
7. **无人值守时不猜产品决策**。遇到影响产品方向/验收/架构的未知，把相关 task 标 `BLOCKED` 并记录待决问题，继续做不受影响的 task；绝不擅自替用户拍板。

> 详细的 git 安全规则见 `reference/git-safety.md`；PR 质量与 review 流程见 `reference/pr-quality.md`；task 状态机与字段见 `reference/task-schema.md`；**收到评审回执后怎么中立裁决（不盲从/不盲拒、按业务上下文判 comment 对错）见 `reference/review-triage.md`；判为「不阻塞」的跟进项怎么记进账本、绝不丢、主线做完后批量做掉见 `reference/followup-ledger.md`**；**pilot 是唯一入口 skill，飞书/Notion 等文档源是配套——该装什么、怎么装、怎么探测、拿不到怎么降级，都由 pilot 安排，见 `reference/doc-sources.md`**（注意：入口是编排责任，pilot 运行时仍不 import、不启动任何配套 skill）。子命令会在需要时指引你读它们。

## 配置：`.pilot.yml`

每个仓库根目录一份（`doctor`/`plan` 会在缺失时创建）。关键字段：

```yaml
base_branch: main            # 主干，受保护，禁止直推
integration_branch: preview  # PR 合并进这里；不存在则回退到 base_branch
protect_patterns: [release, hotfix]   # 额外保护的分支前缀
remote: origin
# allow_remote_cleanup 已废弃:脚本不再删远程分支,没有任何代码读这个键(用 GitHub auto-delete-on-merge)
docs_dir: docs/agent         # 规划/运行态文档目录
planning_source: docs        # docs(默认)=查上面那七个文件 | external=规划在别处,门禁不查(见下)
```

读取方式：用 Read 工具读该文件，把值作为 flag 传给脚本（脚本本身不解析 YAML，保持简单确定）。文件不存在时用上表默认值，并提示用户运行 `pilot doctor` 生成。

**迁移兜底（重要）**：本 skill 曾用 `.repo-pilot.yml`。读配置时：**先读 `.pilot.yml`；若不存在但 `.repo-pilot.yml` 存在，则读旧文件并明确警告用户「`.repo-pilot.yml` 已弃用，请 `git mv .repo-pilot.yml .pilot.yml`」**。绝不静默忽略旧文件——某些仓库的 `.repo-pilot.yml` 里 `integration_branch` 是真实的（如 `master`），静默忽略会让 `run` 用错集成分支、甚至无人值守时把 外部评审的 APPROVE 直合进主干。**若两个文件同时存在且 `integration_branch` 不一致，视为危险，停下让用户先合并/删除旧文件（见 doctor 第 2b 步）。**

## doctor（内联，不改仓库）

轻量自检，只读并汇报。**只覆盖本地可验证的条件**——外部评审服务是否真的会来评审,doctor 无从探测(那正是解耦的代价与目的),所以它的结论只能是「本地就绪」,**不等于「PR 一定会被自动评审」**。汇报时必须把这条界限说清楚,不要让用户以为万事俱备:

1. `git rev-parse --is-inside-work-tree` — 是否 git 仓库。
2. `.pilot.yml` 是否存在；不存在则**询问用户**是否用默认值创建（复制 `templates/pilot.example.yml`，把 `base_branch`/`integration_branch` 填真实值）。
2b. **配置迁移硬检查**：若旧文件 `.repo-pilot.yml` 存在——
    - 只有旧文件、无 `.pilot.yml`：红字提示「`.repo-pilot.yml` 已弃用，运行 `git mv .repo-pilot.yml .pilot.yml`」；在迁移前 `run`/`status` 会读旧文件兜底。
    - **两个文件都在、且 `integration_branch` 不一致：`FAIL`（阻断）**——因为哪个生效不确定、错的那个可能把 PR 直合进主干。要求用户先删掉/合并旧文件再继续，`doctor` 不擅自改。
3. **规划层齐全度**（`run` 无人值守的硬前提）：`bash <skill>/scripts/check-docs.sh --docs-dir <docs_dir> --strict`。
   报 MISSING/EMPTY 就照实列出并建议 `pilot plan` 补齐——`run` 会在同一道门禁上 fail-closed 拒跑，
   在这里先看见比半夜被拦住强。（脚本会识别「文件在但还是原样模板」：占位符没填等于没答。）
   **规划已经在 backlog.md / issue tracker / 别的工具里的仓库**：报 NOT ready 时**不要**建议把规划重抄进
   七件套——那违反 plan.md §A.3(已有规划不要重复造)。正确做法是在 `.pilot.yml` 里写 `planning_source: external`。
   之后门禁会打印 `source=external — NOTHING WAS CHECKED` 并放行：**它没有检查任何东西**。
   汇报时必须照实说「本仓库声明规划在别处、门禁未核实」，**不能说成「规划已验证」或「就绪」**——
   那句放行是人担保的，不是脚本核实的。
4. **集成分支**（`git show-ref refs/heads/<integration>`）。**分支不存在时不要一律说「先建一个」**——先分清是哪一种，三种情况的正确答案完全不同：
   - **`.pilot.yml` 里 `integration_branch` == `base_branch`**（单主干仓库，PR 直接开向主干）→ **这是合法配置，什么都不缺**。不要建议建集成分支。提示：合并走 `git-guard.sh merge-pr <n> --integration <base> --allow-trunk`，并说明 `--allow-trunk` 不是绕过（仍要求分支保护要求审批、PR 已 `APPROVED`、且该分支开启了 stale-dismissal，读不到就 fail-closed）。
   - **没有 `.pilot.yml`**（于是 `integration_branch` 落到默认值 `preview`）**且默认分支存在** → **默认值对这个仓库很可能是错的**，别让用户去建一个 `preview` 来迁就默认值。先问：这个仓库是单主干（PR 直接进 `main`）还是双分支流（`preview` 汇总后再进 `main`）？单主干 → 写 `.pilot.yml` 把 `integration_branch` 设成主干名，合并加 `--allow-trunk`；确实要双分支流 → 才建 `preview`。
   - **`.pilot.yml` 明写了一个既不是主干、也不存在的集成分支** → 这才是真缺失，提示建它（或改配置）。

   本仓库（Brood）就是第一种，`.pilot.yml` 里有注释写明原因，可作范例。
5. `gh auth status` 是否可用（PR 流程需要）。
5b. **git hook 是否真的在生效**（别假设 commit 有保护）：`bash <skill>/scripts/check-hooks.sh`。常见坑：`core.hooksPath` 指到**另一个 clone** 的 hooks 目录 → pre-commit 密钥扫描根本没跑,commit 裸奔却无人察觉。报 `BYPASSED` 就红着提示,并说明「**不要自动切回 `.githooks`**——扫描器有历史误报会让每次 commit 卡死,得先给已知误报加 baseline/allowlist 降噪,再手动开钩子」。只报告,不擅自 rewire。
6. **评审契约提醒**（不探测、不启动任何外部服务）：本仓库的 PR 由**外部评审服务**裁决，
   契约见 `reference/review-contract.md`——开 PR 后约 20 分钟内出裁决。pilot 只负责盯自己 PR 的状态。
   汇报时提示一句：若开 PR 后长时间没有裁决，说明该服务这会儿没覆盖本仓库，需要人工 review，
   **这不是 pilot 能修的，也不要自己给自己 approve**。
7. 汇报一张「就绪 / 待补」清单，不擅自修改。**措辞要诚实**:说「本地就绪」,不要说「可以无人值守跑到底」——外部评审是否会来,doctor 查不到;PR 长时间无裁决时按 `reference/review-contract.md` 的超时路径处理。

## 阶段间关系

```
status  ── 知道现在在哪、清干净战场
   ↓
plan    ── 知道要去哪（M→F→T）、补齐规划层文档
   ↓
run ↺   ── 连续推进 READY task(一次一个,一个接一个),直到交付条件全满足
```

`run` 依赖 `plan` 产出的 `docs/agent/` 文档做 check/对照；`plan` 依赖 `status` 给出的真实仓库状态。三者可单独调用，但首次接手一个仓库建议按序走一遍。
