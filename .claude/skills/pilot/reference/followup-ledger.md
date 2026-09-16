# 跟进账本（follow-up ledger）—— 怎么保证「不丢 + 不提前做 + 最后批量做掉」

review triage 里判为 **B（真问题但不阻塞）**、以及决定要做的延后项，都不在当前 PR 里顺手做，
而是记进一个**账本**，等主线全部完成后由 `pilot run` §2.5 **批量合成一个 cleanup PR** 一次做掉。
这份文档说明这个机制怎么保证「绝不丢失、也绝不提前做」。

## 三层「不丢」保证

1. **单一真相 = 提交进仓库的账本文件** `<docs_dir>/followups.md`（默认 `docs/agent/followups.md`）。
   不是对话状态、不是模型记忆、不是某个 session 的 memory——它是**仓库里被 git 跟踪、会提交的文件**，
   跨对话、跨 /loop、跨机器、跨人都看得见。换台机器、换个会话，`status` 一跑就重新读到。
2. **GitHub PR comment 是永久兜底**。就算本地账本某条丢了（比如某个 feature 分支被废弃、账本没跟着合并），
   评审意见本身永久留在 GitHub PR 上；`status` 的 triage 会从 PR 重新发现它、重新入账。**双保险。**
3. **run 循环的停止条件被门禁**。`run` §3 停止前必须 `followups.sh count-open == 0`；
   **只要账本还有 OPEN 项，循环就不许宣布「没活了、停」**——它会先进 §2.5 把跟进项批量做掉。
   所以「跑通宵」的 loop 不会在留着一堆未清跟进项的情况下悄悄结束。

## 账本长什么样（append-only，永不删行）

```
- [ ] FU-3 · B · src=PR#13 · 2026-08-01 · 把 admin 路由错误码统一成 4xx      (OPEN)
- [x] FU-2 · D · src=PR#13 · 2026-08-01 · 变量名 tmp→buf · done=PR#20        (DONE)
```

`- [ ]`=OPEN，`- [x]`=DONE。标完成只把 `[ ]`→`[x]` 并追加 `done=PR#n`，**从不删行**——
保留完整审计轨迹（和你 4Seas TODO「旧版留着，一眼看出哪条到现在还没答」是同一哲学）。
这也是 GitHub 原生 task list，PR/文件里直接勾选渲染，人也能读。

## 确定性脚本（不靠模型手抖）

记录/回忆/完成全走 `scripts/followups.sh`，格式由脚本保证一致，不靠模型自己拼字符串：

```
followups.sh add   --docs-dir <dir> --class <A|B|C|D> --source "PR#13" --desc "<要做什么>"   # -> FU-<n>
followups.sh list  [--open] --docs-dir <dir>
followups.sh count-open --docs-dir <dir>
followups.sh done  FU-<n> --pr <合并的PR号> --docs-dir <dir>          # 翻 [x] + done=PR#n
```

## 完整生命周期

1. **记录**（run §1 triage）：B 类 → `followups.sh add --docs-dir <dir>` 写入账本 →
   把 `followups.md` 和当前分支的其它改动一起 `git-guard.sh add` 进 commit，**随分支 PR 合并落库**（别留工作区）。
2. **回忆 / 强制不丢**（run §2.5 + §3 停止条件）：run 每轮 §2.5 先 `count-open` 看还剩几条；**§3 停止条件在 `count-open != 0` 时拒绝宣布收工**——账本没清空就不会停 loop，这才是"绝不丢"的强制层（不依赖任何 `status` 步骤）。
3. **完成**（run §2.5，主线全清后）：把小/相关的 OPEN 项**合并成一个 `chore/followups-<date>` 分支 → 一个 cleanup PR**，
   逐条 `followups.sh done --docs-dir <dir>`，走正常评审合并。规模其实是真 feature/bug 的 → 提升为 `tasks.md` 正常 READY task，不塞批量。

## 铁律

- **绝不提前做**：主线（§2 的 READY task）还有得做时，不碰跟进账本——避免主线被小事打断、避免小改动散在各处。
- **绝不丢**：记录即入库文件 + PR comment 兜底 + 停止条件门禁，三层。
- **绝不一项一 PR**：小项批量合一个 PR，省 review 开销。
- **绝不删行**：只翻 `[x]`，保留轨迹。
