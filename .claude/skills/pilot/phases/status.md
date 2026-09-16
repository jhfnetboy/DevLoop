# Phase: status — 汇报进展 + 安全清理

目标：一屏看清「这个仓库现在在哪」，并把已合并的战场清干净。**只读优先，清理默认 dry-run。**

## 步骤

1. **读配置**：Read `.pilot.yml`；**若不存在但 `.repo-pilot.yml`（旧名）存在，读旧文件并警告用户迁移**（见 SKILL.md「迁移兜底」）；两者都无则用默认 `base=main` / `integration=preview`，并在末尾提示可运行 `pilot doctor` 生成。取出 `integration_branch`、`protect_patterns`、`remote`。

2. **扫描**（只读）：运行
   ```
   bash <skill>/scripts/repo-scan.sh --integration <integration_branch>
   ```
   拿到：当前分支、脏文件数、未跟踪数、本地/远程/worktree 数、已合并候选、当前分支 vs 集成分支的 ahead/behind。

3. **读运行态**：若 `docs/agent/progress.md` 存在，Read 它，提取「正在开发的 Feature / Task、阻塞项」。若不存在，说明还没 `plan` 过。

4. **汇报**（三段式，简明）：
   - **当前进展**：正在开发的 Feature/Task（来自 progress.md）；当前分支 + 是否有未提交改动。
   - **仓库盘点**：本地 N 个分支 / 远程 M 个分支 / K 个 worktree；其中 X 个本地分支已合并进 `<integration>`（可清理）。
   - **清理计划**：运行
     ```
     bash <skill>/scripts/safe-cleanup.sh --integration <integration_branch> [--protect "<patterns>"]
     ```
     （**dry-run**，只打印 would-delete / would-remove / KEEP）。把结果原样呈现。
     这条命令**不带** `--squash-merged`，所以「Squash-merged local branches」一节会打印
     `(not checked — one gh API call per branch; pass --squash-merged to check)` ——
     那是**没查**，不是**没有**，别当成「干净」。
   - **本仓库用 squash 合并时必看**：`git branch --merged` 在 squash 仓库里**通常返回 0**（零提交的废弃分支仍会被它列出），
     上面那条命令的「Local merged branches」会永远是 `(none)`。脚本会在
     「Squash-merged local branches」一节把候选列出来（每条附已合并的 PR 号），
     此时改用：
     ```
     bash <skill>/scripts/safe-cleanup.sh --integration <integration_branch> --squash-merged
     ```
     若该节打印 `(cannot verify …)`，说明 `gh` 没装/没登录 —— 那是**查不了**，不是**没有**，
     照实说，不要报成「没有可清理的」。

5. **征询清理**：把 dry-run 计划给用户，**问是否执行**。得到确认后才加 `--apply`：
   ```
   bash <skill>/scripts/safe-cleanup.sh --integration <integration_branch> [--squash-merged] --apply
   ```
   - **远程分支脚本不处理**（`--remote` 只会打印一段说明）。让用户去仓库设置里开 GitHub 的
     **auto-delete-on-merge** —— 它在合并真正发生的那一侧判定，而从 clone 里判断要靠可能过期的
     remote-tracking ref，且 bare 仓库不留 reflog。
   - 无人值守模式（由 /loop 调用且用户已预先授权清理）：可直接 `--apply`。脚本此时唯一会执行的
     删除仍是 `git branch -d`，其余照样只列。

6. **建议下一步**：基于 progress.md 指出「下一个该做的 READY task」；若没有规划文档，建议 `pilot plan`。

## 纪律

- 清理的所有安全判断在 `safe-cleanup.sh` 里确定性执行（只删已合并+干净、护住 main/集成/当前/protected/脏 worktree）。**不要在对话里手工 `git branch -d`/`-D`** —— 走脚本，避免漏判。
- **脚本唯一会执行的删除是 `git branch -d`**（git 自己拒绝未合并的、以及被 worktree 占用的）。`-D`、`git push --delete`、`git worktree remove` **都不执行**——`--squash-merged` 拿到服务端证据后只把分支/worktree **列出来**（附 PR 号、tip sha、可粘贴的命令），删不删由人决定。把那份清单**原样**呈现给用户，不要代劳执行。远程分支脚本完全不处理，让用户去仓库设置里开 GitHub 的 auto-delete-on-merge。
- 汇报前若对某个数字存疑，重跑 `repo-scan.sh` 核对，不要凭记忆报数。
