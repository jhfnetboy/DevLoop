# ADR-0004: TypeScript on the DSH ecosystem

**状态**: Accepted
**日期**: 2026-08-25

## 背景

独立 Runtime 讨论过 Node.js vs Python。选定 DSH 插件后，语言被生态约束。

## 决策

- **主语言：TypeScript**
- **包管理：pnpm**（禁止 npm 作为安装入口）
- **Node：跟随 DSH `engines`**：`^22.19.0 || >=24.0.0`（当前环境为 22.22.2；DSH 明确不含 Node 23）
- Python 只用于以后的评测 / 成本分析脚本，不进 orchestration core

## 理由

- DSH 与 Cordis 插件 API 就是 TypeScript
- 本项目主要是进程、CLI、JSON/YAML、git、状态机，不是 ML 训练
- 与 DSH 共享类型比跨语言 JSON-RPC 更适合第一版

## 后果

**正面**：
- 插件、测试、schema 同一语言
- 安装方式与官方教程一致

**负面/权衡**：
- 通用项目规则里的「Node 23+」在本仓库让位于 DSH engines
- DSH Preview 的类型包可能落后于源码 checkout；构建期允许 `link:` 本地 harness，运行时依赖走 npm
