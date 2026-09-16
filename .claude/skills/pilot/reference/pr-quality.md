# PR 质量：自测 + 对抗式 review（PR 前必做）

一个 PR 在开出去之前，必须已经过「自己这一关」。目标是让外部评审尽量一次 approve，而不是来回 request-change。

## 1. 自测（顺序不能省）
1. **针对性测试**：先跑与本次改动直接相关的测试。
2. **lint / format**：无新增告警。
3. **typecheck**：零类型错误（有类型系统的语言）。
4. **build**：能构建通过。
5. **集成测试 / 端到端**：跑通受影响的主流程，不只看单测。

任何一步失败 → 修到全绿再继续。没有绿测的代码不进 PR。

## 2. 对抗式 review（换视角挑刺）
用**新上下文或独立 reviewer**（子 agent，或 Codex `/codex:rescue`）审这段 diff，指令是「找问题」而非「看看还行」：
- 竞态 / 并发 / 顺序依赖
- 错误处理与边界（空、超长、并发、超时、部分失败）
- 安全（注入、鉴权、越权、密钥泄漏）
- 涉钱逻辑的精度 / 溢出 / 幂等 / 重放
- 性能 / gas / N+1 / 无界循环
- off-by-one、资源泄漏、生产失败模式

有阻塞问题 → 修 → 重新自测 → 再挑战一轮，直到无阻塞（或明确记录为「本 task 范围外，另开 task」）。

> 全局 CLAUDE.md 的 review 分层（Codex → gh Copilot → 本地模型）在这里适用：优先 Codex，不可用则降级。

## 3. 自审 diff（提交前最后一眼）
- `git diff` 逐块读：没有 `console.log`/调试代码、没有注释掉的大块、没有 TODO 占位当完成。
- 没有密钥 / token / `.env` / 本地路径 / 构建产物混进来。
- 改动范围 = task 范围，没有「顺手改的无关文件」。
- 用 `git add <显式路径>` 只暂存该提交的文件（**绝不 `-A`**）。

## 4. 开 PR
- base = 集成分支（默认 `preview`），不是主干。
- 标题 conventional；body 写：解决哪个 Task、验收命令 + 自测结果、对抗 review 结论、有无已知遗留。
- 开完 PR 后盯状态，按裁决行动（见 `review-contract.md`）。**绝不自己直合。**

## 收到 CHANGES_REQUESTED 之后
1. 读**全部** review 意见（`gh pr view <n> --comments`），逐条理解，别只挑简单的改。
2. 修 → 重新自测（第 1 节）→ 自审（第 3 节）。
3. `git add <显式路径>` + commit + push 新 commit —— 推新 commit 会自动触发再评审，无需手动请求。
4. 更新 tasks.md/progress.md 状态。
