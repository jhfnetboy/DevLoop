# DevLoop 0.6 设计：盘点、规划、每任务一个小 PR

状态：**已采纳**（2026-09-12）。0.6.0 已发布（盘点与清理）；下面第 6 节标出了每一版的进度。

0.6 让 DevLoop 自己完成过去要靠 pilot skill 在 Claude Code 里做的两件事——**盘点（status）**和**规划（plan）**——并把每个任务变成**一个小 PR**：先过机械规则和本地自查，再交给 PR-daemon 独立评审。pilot 的文件格式（`.pilot.yml`、`docs/agent/` 七件套）保持兼容：在 Claude Code 里继续用 pilot 不冲突，只是 DevLoop 不再依赖它。

## 已确认的决定

| 日期 | 决定 |
|---|---|
| 09-11 | 三方分工：Codex 规划（`plannerRoute`），DeepSeek 写代码（`routing[tier]`），Claude 评审（`reviewerRoute`）。已在 Mac mini 生效并实测。 |
| 09-11 | **一个 task 一个 PR**，PR 必须小：≤200 行（加+删，不含 lockfile/生成文件/快照）、≤5 个文件、≤2 个顶层目录；高风险内容单独一个 PR。依据：PR-daemon 1,400 个 PR 的历史（≤200 行首轮被打回 23%，201–300 行 42%）。 |
| 09-11 | **开 PR 前必须先过机械规则，再过本地 Claude 自查**；本地这层必须保留。上限先跑一段时间，**全程记日志**，之后用数据调整。 |
| 09-12 | 任务 PR **开向工作分支** `devloop/<目标>`；目标完成后，再从工作分支开**一个发布 PR** 到主干。 |
| 09-12 | PR-daemon **APPROVE 后由 DSH（DevLoop）合并**，用 **jhfnetboy** 账号（PR-daemon 用 clestons 评审，两个身份分开）。 |
| 09-12 | **规划文档不交给 PR-daemon**：DevLoop 内部让不同模型 PK 后定稿。 |
| 09-12 | PR-daemon 的机械规则分支可以推送、合并，前提是**充分测试、证明真的生效**，并且有**更新流程**让各仓库持续拿到新规则。 |

---

## 1. 盘点（status）——不用模型

pilot `status` 的确定性部分，由宿主代码完成，结果显示在项目页新的「仓库状态」面板。

**扫描**（只读，`GIT_OPTIONAL_LOCKS=0`）：当前分支、未提交改动、本地分支、worktree、已合并进工作分支/主干的分支、DevLoop 留下的 `devloop/*` 分支和 worktree、与主干的 ahead/behind。

**清理**：页面先列 dry-run 计划（删 / 留及原因），点「执行清理」才动手。与 pilot `safe-cleanup.sh` 同一套边界：

- 只执行 `git branch -d`（git 自己拒绝未合并的、被 worktree 占用的）。
- 永远保留：主干、当前工作分支、`.pilot.yml` 的 `protect_patterns`、有未提交改动的 worktree、正在运行的任务分支。
- **不做**：`-D`、删远程分支、`git worktree remove`——只列出来附原因和命令，由人决定。
- squash 合并的仓库用 `gh` 按 PR 查；查不了就说「未检查」，不说「没有」。

启动检查（0.5.4）并入「仓库状态」，红色项仍然拦住启动。

## 2. 规划（plan）——多模型 PK 定稿

pilot `plan` 的规划，搬进 DevLoop。全程在 `_loop-plan` worktree 里，只允许改 `docs_dir` 下的文件。**不交给 PR-daemon。**

1. **探测**：已有 `docs/agent/` → 先读，汇报 M/F/T 现状和缺口，不重复造。
2. **提问**（只问产品方向、验收标准、架构）：规划器返回 `kind: "questions"`，页面显示为「等你回答」。实现细节不问。
3. **起草**：Codex（`plannerRoute`）写出 roadmap、tasks、acceptance、architecture、spec、progress（需要时 research）。每个 Task 必须有**机器可验证的验收命令**，并**按第 3 节的 PR 上限估过大小**，估计会超的当场拆。
4. **PK**：Claude（`reviewerRoute`）以挑战者身份逐条质疑（范围、验收能否机器验证、任务大小、遗漏）；Codex 逐条回应并修改；最多 N 轮（默认 2）。分歧仍在的条目标 `BLOCKED` 并变成第 2 步的问题问你，不由模型替你拍板。
5. **定稿**：PK 收敛后自动定稿，宿主校验（只改了 `docs_dir`、每个 Task 有验收命令、估算大小在上限内），提交到工作分支，页面「文档」面板可看全文和 PK 记录。
6. **选 Feature 开跑**：从 tasks.md 选一个 Feature，DevLoop 生成 GOAL.md，进入第 3 节的循环。

新增结果类型 `questions`、`planning_docs`、`plan_challenge`（PK 用），均按现有 `<devloop_result>` 信封校验。

## 3. 每个任务：小 PR → 工作分支；目标完成 → 发布 PR → 主干

```
delegate（DeepSeek）→ 宿主提交到任务分支
  → ① 大小预算检查（宿主，确定性）
  → ② 机械规则（PR-daemon 的 pre-pr-check，确定性）
  → ③ 本地 Claude 自查（reviewerRoute）
  → ④ 开 PR：任务分支 → devloop/<目标>，PR-daemon 四轮评审
  → APPROVE（且审的是当前 head）+ CI 绿 → DSH 用 jhfnetboy 合并进工作分支
  → REQUEST_CHANGES → 同一任务返工，推新提交，再评
所有任务完成 → 发布 PR：devloop/<目标> → 主干 → PR-daemon 评审 → APPROVE 后 DSH 合并
```

**① 大小预算**：统计任务分支相对起点的 diff（排除 lockfile、`dist/`、生成文件、快照）。超限 → 不开 PR，停下要求重新拆分（新 hold `task_over_budget`，答案是 REPLAN）。上限可配置，默认 200 行 / 5 个文件 / 2 个顶层目录。

**② 机械规则**：调 PR-daemon 的检查器，只扫这个任务的 diff，读 JSON。阻断命中 → 回 delegate 返工（命中项写进返工说明），不开 PR。自答类规则写进 PR 描述由作者按编号回答。检查器缺失或自检失败 → 明确记「未检查」并停下，不假装通过。

**③ 本地自查**：现有 `reviewerRoute`（Claude）评审，通过才开 PR。

**④ PR 与合并**：

- 任务 PR 的目标分支 = 工作分支 `devloop/<目标>`（启动时所在的分支）。
- **forge 改为读 GitHub 原生 review**：只认 `forge.reviewers`（如 `clestons`），用 review 的 `commit_id` 绑定被审的提交；APPROVED → PASS，CHANGES_REQUESTED → REWORK（review 正文作返工说明），COMMENTED 忽略。合并前重新读一遍结论。
- **DSH 合并用 jhfnetboy**：`gh pr merge` 以 jhfnetboy 身份执行（forge 已固定 gh 的身份与目标仓库）；评审者（clestons）与合并者分开。
- 本地检出随后 `fetch` + fast-forward 到工作分支最新；不再在本地做合并。本地模式（不配 forge）保持现状，主干守卫照旧。
- DevLoop 开的 PR 打 `devloop` 标签并在正文注明，**PR-daemon 的 `$pr-fix` 跳过**这类 PR。
- **发布 PR**：所有任务合并后，DevLoop 开 `devloop/<目标> → 主干`。它是已评审提交的汇总，**不受 200 行上限约束**（每一块都已单独审过）；PR 描述列出包含的任务 PR 及各自结论，方便 PR-daemon 按「汇总」审。APPROVE 后同样由 DSH 用 jhfnetboy 合并。

## 4. 日志（为了以后调上限）

每个任务 PR 追加一行到 `.devloop/PR-LOG.jsonl`：

```json
{"taskId":"T1.2.2","pr":123,"base":"devloop/f12","head":"<sha>","lines":142,"files":4,"areas":2,
 "highRisk":false,"overBudget":false,"rules":{"version":"<pre-pr-check 版本>","sha":"<PR-daemon 提交>"},
 "ruleHits":[{"rule":"B2","severity":"block"}],"localReview":"PASS",
 "prDaemon":[{"verdict":"REQUEST_CHANGES","at":"…"},{"verdict":"APPROVE","at":"…"}],
 "cycles":2,"openedAt":"…","mergedAt":"…"}
```

页面加一张「PR 记录」表；`devloop pr-log --csv` 导出。PR-daemon 那边按规则编号和 PR 大小记录后，两边按 `repo#pr@head` 对上。

## 5. 机械规则：来源与更新流程

来源：PR-daemon 的 `pre-pr-rules`（首版已在本机验证：拦下超限的 0.5.5 diff；U1 规则命中了真实的「选中暂停刷新」问题）。

**更新流程**（要求 PR-daemon 提供，DevLoop 这边照此消费）：

1. 规则和检查器住在 **PR-daemon 仓库的 main**，入口是固定路径；每次规则变更写 CHANGELOG、升规则版本。
2. `pre-pr-check.sh --version` 输出规则版本；JSON 输出里带版本和 PR-daemon 的 git SHA。
3. DevLoop 启动时（和每天一次）跑检查器自检；每次检查把版本和 SHA 记进 PR-LOG；页面显示当前规则版本和最近一次自检结果。
4. 本机的 PR-daemon 仓库跟随它的 main（PR-daemon 常驻评审本来就从 main 跑）；其他机器/仓库按 PR-daemon 文档的安装/更新命令更新。
5. **验收**：在 PR-daemon 里改一条规则并合并 → 不发 DevLoop 新版，下一次 DevLoop 检查就用上新规则（版本号变化可见）。

## 6. 发布顺序（我们自己的 PR 也守上限）

每一版内部再拆成 ≤200 行的 PR，每个 PR 都过机械规则 + 本地自查 + PR-daemon。

| 版本 | 内容 | 用户能看到什么 |
|---|---|---|
| **0.6.0** ✅ 已发布 | 盘点：「仓库状态」面板 + 执行清理（只 `branch -d`）；循环保存结果时等锁、停机标记持久化（#43–#54） | 项目页一眼看到分支、worktree、可清理项，点一下清掉已合并分支 |
| **0.6.1** | 大小预算：任务完成后统计 diff，超限停下要求拆分（`task_over_budget`）；规划器提示词写入上限；PR-LOG（从 0.6.0 挪来：有了写入方才建） | 超大的任务不会被提交，会停下说「拆一下」；页面有「PR 记录」表 |
| **0.6.2** | 接入机械规则：调用 PR-daemon 检查器、读 JSON、阻断即返工；启动自检、版本记录（依赖 PR-daemon 规则进 main） | 每个任务显示规则检查结果和规则版本 |
| **0.6.3** | 每任务一个 PR：forge 读原生 review、合并前复读、`devloop` 标签、DSH 用 jhfnetboy 合并进工作分支；目标完成开发布 PR 到主干 | 每个任务对应一个 GitHub PR，PR-daemon 评审，通过后自动合并 |
| **0.6.4** | 规划：页面问答（questions）、Codex 起草、Claude 挑战、PK 定稿、选 Feature 生成 GOAL.md | 在页面上从零规划一个仓库，不再需要 pilot |

依赖关系：0.6.2 需要 PR-daemon 的规则在它的 main 上（已满足：rules 1.1.0）；0.6.3 依赖 0.6.1、0.6.2；0.6.4 依赖 0.6.1（规划要按上限拆任务）。

## 7. 待定问题

无。目录规则（测试和文档目录不计入目录数）已在 2026-09-12 定为试行。
