# ADR-0002: Do not fork DSH core

**状态**: Accepted
**日期**: 2026-08-25

## 背景

基于 DSH 二次开发有两种做法：fork `deepseek-ai/deepseek-harness` 改源码，或走官方 Plugin / Profile Bundle。

## 决策

**不 fork DSH core。** 本仓库是独立插件包，通过：

```text
package.json  →  dsh.bundle.patch
cordis.patch.yml  →  insert plugin row
dsh plugin --profile web add <path-or-package>
```

安装进用户的 DSH profile。Harness checkout 保持零改动。

## 理由

- 官方设计就是「配置层选择、替换或扩展」，无需改源码
- fork core 会把我们绑在上游 breaking changes 上，后续无法干净跟随
- 通用改进可以另开 PR 回馈 DSH；产品工作流留在本插件

## 后果

**正面**：
- 升级 DSH 不等于 rebase 我们的 fork
- 安装路径与社区插件一致，方便测试

**负面/权衡**：
- 若官方 API 缺能力，只能先在插件层绕过，或向上游提 PR，不能在 core 里「顺便改一刀」
