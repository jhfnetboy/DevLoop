# Changes

## 0.1.0 — 2026-08-25

文档与 DSH 插件骨架。范围仅限 0.1：把已确认的技术决策落成 ADR，并把可安装的插件和可测试的调度核心立起来。

### 文档

- 新增 `docs/Solution.md`：从原始对话提取需求与约束（信息源头）
- 新增 `docs/Design.md`、`docs/Features.md`、`docs/Plan.md`、`docs/CONTEXT.md`
- 新增 `docs/adr/0001`–`0009`：以文末决策为准的架构记录

### 代码

- 新增 DSH bundle 插件 `dsh-devloop`（`cordis.patch.yml` + Cordis Service）
- 新增确定性 Loop、Budget 熔断、Tier 路由、`.devloop/` 持久化
- 新增 vitest 单测覆盖上述纯函数与 tick 空转

### 可能影响

- 尚不派真实 Worker，不影响任何业务仓库的代码，除非用户主动 `dsh plugin add` 并在项目里放置 `.devloop/`
- 安装后 DSH profile 会多一行 `devloop` 插件；未配置 GOAL 时 tick 保持 idle

### 构建与测试

```bash
pnpm install
pnpm test
pnpm build
```

安装到 DSH 见仓库根 README。
