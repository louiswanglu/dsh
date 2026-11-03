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

## 第三轮：Turn 级 rewind

`packages/dsh-turn-rewind` 在每次文件写入/编辑**之前**快照旧内容，并提供 `rewind_turn` 工具还原。

为什么不能用 git：工作区里常有与本次无关的未提交改动，`git checkout` 会连它们一起丢掉。
这个插件只碰它自己记录过的路径。

```
rewind_turn()          → Turns with snapshots: 1, 2
rewind_turn({turn: 1}) → Restored 1 file(s) from turn 1.
                          ~ /tmp/rw/src/a.rs
                          Deleted 1 file(s) created by that turn:
                          - /tmp/rw/src/new.rs
```

关键设计：

| 决策 | 原因 |
|---|---|
| 在 intent 阶段快照 | `fs/write-intent` 在写入**之前**触发，第一次捕获才是真正的 turn 前内容 |
| 每个路径只留第一次 | 后续捕获会覆盖掉基线，把已改动内容当回滚点 |
| 快照落盘 | 存在 `$DSH_HOME/rewind/`，Host 重启后仍可回滚（`workspace-changes` 的 diff 卡片做不到） |
| 新建文件记为 absent | 回滚时删除它，而不只是还原内容 |
| 不自动回滚 | 快照是惰性的，只有显式调用 `rewind_turn` 才写回 |

实测：多轮隔离正确（turn1 还原到最初内容，turn2 还原到 turn1 结果），dry-run 不落盘，未知 turn 报明确错误。

## 第四轮：把三个插件串成工作流

`skills/code-change-workflow/SKILL.md` 把前三轮的能力固化成一条可复用路径：

**检索定位 → 最小编辑 → 读诊断 → 必要时回滚**

装到 `~/.dsh/skills/` 后，模型在处理「改多个文件 / 不熟悉的代码」时会自动加载它。

端到端验证（真实 backends 跑完整四步）：

```
[1] locate:   src/order.ts:1 placeOrder              ← codebase_search
[2+3] 编辑后自动附带诊断：
      <lsp-diagnostics>
      2:9 error: Type 'number' is not assignable to type 'string'.
      </lsp-diagnostics>
[4] rewind:   Restored 1 file(s) from turn 1.        ← rewind_turn
      复检：0 diagnostics
```

## 第四轮修掉的一个真实缺陷

**camelCase 标识符搜不到。** FTS5 的 unicode tokenizer 把 `placeOrder` 当作**一个**
token，所以 `place`、`order`、`getOrderBookSnapshot` 的任何组成部分都匹配不上。

修复：索引时额外写一列 `search_text`，把标识符拆成子词
（`placeOrder` → `place order`，`HTTPServer` → `http server`，`parse_snapshot` →
`parse snapshot`），同时保留原始 token 让精确搜索仍可用。索引 schema 加了
`user_version`，旧索引自动丢弃重建。

这个缺陷是**写 skill 时验证第 1 步才发现的**——单测和之前的真实仓库测试都没覆盖
camelCase 符号。

## 第五轮：修版本不兼容 + hooks 自动发现

### 5.1 版本不兼容（先修，因为它是阻塞项）

启动日志一直在报四个插件被禁用：

```
dsh: disabling profile plugin row "hooks-claude-code": ... incompatible with dsh 0.2.1-rc.5
```

**根因**不是插件版本旧，而是 profile 的 `pnpm-workspace.yaml` 里
`autoInstallPeers: false`：它让 peer 依赖停留在 lockfile 里的旧版本，
所以 `pnpm.overrides` 只改顶层 spec 根本推不动传递依赖。

修复：打开 `autoInstallPeers`，把 76 个官方包统一 pin 到 `0.2.1-rc.5`，
删掉 lockfile 重新解析。结果：**rc.2 引用归零，不兼容警告 0 条，被禁用插件 0 个**。

### 5.2 hooks 自动发现

`config/hooks-discover.patch.yml` 把 `configPath` 从硬编码
`lighting-rust` 改成按仓库根解析：

```
优先级：.claude/hooks.json > .claude/settings.json > .dsh/hooks.json
边界：  从启动目录向上最多 8 层，遇到用户 home 即停止
```

**为什么要停在家目录**：`~/.claude/settings.json` 是用户全局偏好，
不是某个仓库的策略。最初的实现会把全局 hooks 套用到所有仓库，这是错的。

**实现约束**：`!!js` 在 `new Function` 里求值，**没有 `require`**。
必须用 `process.getBuiltinModule('node:fs')` 同步取内置模块。
（第一版用了 `require`，真实启动直接 `ReferenceError`。）

实测：从 lighting-rust 启动 → 绑定它的 `.claude/settings.json`；
从其它仓库启动 → 无 hooks、零报错、优雅降级。

## 下一步（尚未做）

1. **模型分工** —— 默认走便宜模型，plan/review 走强模型
2. **行内补全** —— Monaco 侧接编辑预测（补 A4），投入产出比最低
