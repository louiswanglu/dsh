# DSH 能力增强：LSP 全语言 + 编辑后自动诊断

对标 Cursor 的能力视图里，DSH 真正落后的四条轴是：语义代码库检索、LSP 反馈闭环、
行内补全、一键 rewind。本轮只做**成本最低、当天可见**的那条 —— **LSP 反馈闭环**。

## 这次做了什么

1. **`packages/dsh-edit-verify`** —— 自研插件。`write` / `edit` 成功落盘后，自动向语言服务器
   请求该文件的诊断，并把 error / warning 追加进模型看到的工具结果。
2. **`config/web-lsp.patch.yml`** —— 把 profile 里只有 rust 一种语言的 `servers` 表补齐到
   5 种：Rust、TypeScript/JavaScript、Python、Go、C/C++。

## 效果

改动前，模型写完一个带类型错误的文件，要到用户跑构建才知道错了。改动后同一步就能看到：

```
Wrote /tmp/lspverify/e2e.ts

<lsp-diagnostics file="/tmp/lspverify/e2e.ts">
1:7 error [typescript]: Type 'string' is not assignable to type 'number'.
</lsp-diagnostics>
```

## 安装

```sh
dsh plugin --profile web add ./packages/dsh-edit-verify
```

插件通过 `dsh.bundle.patch` 自挂载，不需要再往用户 patch 层写 insert 行。

## 设计约束

| 约束 | 原因 |
|---|---|
| 只读副作用 | 不格式化、不改文件、不跑构建，只问语言服务器它已经知道的事 |
| 失败必须静默 | 没有 `lsp_diagnostics`、扩展名未路由、服务器崩溃、超时 —— 一律当作“什么都不说”，绝不让校验失败污染真正的编辑结果 |
| 有界扇出 | 每次编辑最多一次诊断请求；结果按 `maxDiagnostics` 截断，坏文件不会淹没上下文 |
| 不覆盖 `value` | 只追加 `content`，保留工具自身的 canonical output 契约 |

## 额外发现（重要）

本机 `dsh` 是 **0.2.1-rc.5**，但 web profile 里的官方插件全部锁在 **0.2.1-rc.2**。
启动时这几行被判定不兼容并**禁用**：

- `@deepseek-ai/dsh-experimental-auto-review`
- `@deepseek-ai/dsh-experimental-tool-worktree`
- `@deepseek-ai/dsh-hooks-claude-code`
- `@deepseek-ai/dsh-settings`

也就是说你之前配的 Claude Code 风格 hook 拦截器**当前并未生效**。修复方式二选一：

```sh
# 方案 A：把这些插件升到 rc.5
dsh plugin --profile web update @deepseek-ai/dsh-experimental-auto-review \
  @deepseek-ai/dsh-experimental-tool-worktree \
  @deepseek-ai/dsh-hooks-claude-code @deepseek-ai/dsh-settings

# 方案 B：接受风险，给精确版本发豁免
dsh plugin --profile web allow-version @deepseek-ai/dsh-settings@0.2.1-rc.2
```

## 验证

```sh
cd packages/dsh-edit-verify && node --test test/index.test.js   # 7 项单元测试
```

端到端验证使用真实 `ToolRuntime` + 真实 `dsh-lsp-actions` + 真实语言服务器，覆盖：
TypeScript 类型错误、Python(pyright)、Go(gopls)、C(clangd)、干净文件不产生噪音、
`read` 不被校验、未路由扩展名静默、语法错误、服务器崩溃不影响编辑结果。

## 第二轮：符号索引检索

`packages/dsh-codebase-search` 提供 `codebase_search` 工具。它把工作区切成**符号粒度的块**
（每个函数/结构体/类/方法一块），用 SQLite FTS5 排序。`grep` 找字面量，它找**定义**。

```
### order book snapshot
  crates/lighting-adapter/src/exchange/mexc/perpetual/exchange.rs:301  get_order_book_snapshot
  crates/lighting-strategy/.../infrastructure/exchange_adapter.rs:63   get_order_book_snapshot
```

关键设计：

| 决策 | 原因 |
|---|---|
| 纯本地 `node:sqlite` | Node 自带，无服务、无 embedding API、零 token |
| 索引可弃 | 存在 `<workspace>/.dsh/codebase-index.sqlite`，删了重建即可 |
| 增量刷新 | 按 path+size+mtime 指纹，且有 TTL，连续查询只走一次目录 |
| 词项 OR 而非 AND | "order book snapshot" 要求三个词全中会返回空，因为函数名里没有 "book" |
| 测试码降权不删除 | Rust 单测与实现在同一文件，所以按 chunk + 显式测试模块区间判定；按文件判会把生产代码也降权 |

实测：3005 个文件 / 51744 个 chunk，冷索引 23 秒，热查询零开销。

## 下一步（尚未做）

按 ROI 排序：

1. **Turn 级 rewind** —— 持久化 turn 快照 + 回滚工具（补 A5）
2. **行内补全** —— Monaco 侧接编辑预测（补 A4）
3. **hooks 自动发现** —— 把 `hooks-claude-code` 从硬编码 `lighting-rust` 改为按仓库根发现
4. **模型分工** —— 默认走便宜模型，plan/review 走强模型
