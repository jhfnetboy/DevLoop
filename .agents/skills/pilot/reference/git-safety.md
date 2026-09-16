# Git 安全规则（不可破）

有经验的程序员的底线。任何阶段、任何模式都遵守。

> **谁强制这些规则**：真正不可绕过的保证是 ① GitHub 分支保护 + ② 待建的 PreToolUse hook（TASK-40）。`git-guard.sh`/`safe-cleanup.sh` 是**便利包装 + 纵深防御一层**（best-effort，覆盖常见危险形状，不承诺 bash 层对抗式滴水不漏）。危险动作优先走它们，但别把它们当唯一防线。

## 提交
- **绝不 `git add -A` / `git add .` / `git add -u`**。只 `git add <显式路径>`。
  - 为什么：`-A` 会把未确认是否该跟踪的文件一起提交——`.env`、密钥、token、构建产物、临时文件、别人的改动。这是日常最危险的动作，一次误提交密钥可能不可逆。
  - 正确姿势：先 `git status` 看全貌 → 明确本次要提交哪些路径 → 逐个 `git add path/to/file`。
- 提交信息用 conventional commits（`feat:` / `fix:` / `docs:` / `chore:` …）。
- 提交前 `git diff --staged` 复核，确认无调试代码、无密钥、无越界改动。

## 分支与主干
- **绝不 `git push` 到主干（main/master）**。主干受保护。
- **绝不合并自己的 PR 到主干**，绝不 `gh pr merge --admin` 绕过 review。
- 所有变更：feature 分支 → PR → review → 合并到**集成分支**（默认 `preview`）。主干只由集成分支经受控流程进入。
- **单主干仓库**（没有集成分支，PR 直接开向 `main`）是合法形态。这时用
  `git-guard.sh merge-pr <n> --integration main --allow-trunk`。这个 flag **不放松「必须被 review」**，
  只放松「合到哪里」：它仍要求该分支的 GitHub 分支保护规则 `required_approving_review_count >= 1`
  **且**该 PR 的 `reviewDecision == APPROVED`；保护规则读不到就直接拒绝（fail-closed）。
  `--admin` 在任何情况下都仍然被拒。
  > 为什么要留这个口子：没有它，护栏在单主干仓库里根本用不了，人只能裸用 `gh pr merge` 绕过去——
  > **一个必须被绕过的护栏，比没有护栏更糟**，因为它教会人绕过护栏。
- 一个 task = 一个分支 = 一个 PR；**一个 Feature = 一个专属 worktree（硬性，v1.5.0 起不再可选）**。开发绝不发生在主 checkout——`git-guard.sh add` 在主 worktree 里直接拒绝 staging（可见例外口子 `PILOT_ALLOW_PRIMARY=1`，仅限用户明确拍板）。同 Feature 的后续 task 在既有 worktree 里 `git checkout -b <新分支> <integration>`（从 ref 建新分支不需要检出该 ref）。分支命名 `<type>/<taskid>-<slug>`，如 `feat/T1.3.2-admin-init`。

## 删除（清理）
- **删本地分支只用 `git branch -d`**。`-d` 会拒绝删除未合并分支，是安全网；`-D` 强删会丢未合并工作。
  **脚本永远不执行 `-D`，不 `git push --delete`，也不 `git worktree remove`。**
  最后那条尤其容易被漏掉：它是**文件系统删除**，而判断它「干净」用的 `git status --porcelain`
  **不列 gitignore 的文件**，`git worktree remove` 不带 `--force` 时也容忍「只有 ignored 文件」的
  工作树 —— 两层各自放行，结果是一个装着 `.env` 的目录被整个删掉、不可恢复。所以 worktree 只列出来
  并附上移除命令和「先查 ignored 文件」的提示。
- **squash-merge 仓库的处理方式：列出来，不删。** 那里 `git branch --merged` **通常返回 0** —— squash 重写补丁，
  原 commit 不是集成分支的祖先。实测本仓库 28 个分支、`git branch --merged main` 返回 0，
  于是这个脚本在自己家里**什么都清理不了**。
  所以 `safe-cleanup.sh --squash-merged` 引入第二种**服务端**证据：GitHub 的
  `/commits/{sha}/pulls` 告诉你「哪个 PR 把这个 commit 引入了仓库」，只有当它给出
  `merged_at != null` 的 PR 时，这个分支才会被**列进清单**（附 PR 号、tip sha、可粘贴的命令）。
  **按 commit 判、不按分支名判**，因为两个方向的错都真实发生过：
  ① 漏报 —— `work-pr18` 这类分支名从没当过 PR head，但 tip 就是别的 PR 的已合并 head；
  ② 错报 —— 分支名可复用，同名分支删掉重开后内容全不同，旧的 MERGED PR 仍然匹配名字。
  没证据 / 没装 gh / 没登录 → **一律不列**，且明确报「无法核实」而不是「没有可清理的」。

  **为什么只列不删。** 早先的版本是真删的（`-D` + `git push --delete`），六轮评审在这一个能力上
  找出六个**实测复现**的缺陷：同名 tag 劫持证据、导致删掉一条**未合并**分支；恢复句柄打印**另一个**
  分支的名字（bash 3.2 会在外层作用域展开 `local a=.. b=${a..}` 的右值）；丢掉了 git 自带的
  「这个 ref 被 worktree 占用」拒绝；证据与删除之间的 TOCTOU 窗口；以及**拿本地分支当判据、
  在服务端删掉同事没合并的工作**。没有一条是理论风险。
  结论不是「防得更严」，而是：**自动执行不可逆删除、而判据又必须从服务端推断**，所需的把握程度
  配不上它买到的东西——它买到的只是不用敲 `git branch -D <名字>`。那六个缺陷全都是「删」的属性，
  不是「列」的属性。所以脚本做难的那半（在 git 自己看不出来的仓库里逐条给出合并证据），
  不可逆的那半留给人。远程分支交给 GitHub 的 auto-delete-on-merge——它在**合并真正发生的那一侧**
  判定，不会被一个还没 push 的本地分支骗到。
- 只删「已合并进集成分支 + 干净」的分支/worktree。
- 一切经 `scripts/safe-cleanup.sh`，默认 dry-run，`--apply` 才执行。**不要在对话里手工逐个删**，避免漏判保护分支。
- **远程分支：脚本完全不处理**（既不删也不列）。用 GitHub 的 auto-delete-on-merge——它在合并真正发生的那一侧判定，而从 clone 里判断要依赖可能过期的 remote-tracking ref，且 bare 仓库不留 reflog，是所有删除里唯一完全没有后悔药的。`.pilot.yml` 的 `allow_remote_cleanup` 因此不再有作用。
- 永不碰：当前分支、集成分支、主干、protected 前缀（release/hotfix…）、脏 worktree 及其远程分支。

## 危险操作一律先确认
- `git reset --hard`、`git clean -fd`、`git rebase`（改写已推送历史）、`git push --force` —— 除非用户明确要求，否则不做；做前先解释后果。
- force push 只允许 `--force-with-lease`，且只在自己的 feature 分支。
