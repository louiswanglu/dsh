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
# 1. 语言服务器（tsls + pyright 这两个不是系统包；rust/go/clangd 需已装）
cd .lsp-runtime && npm install

# 2. 插件本体（LSP 动作面 + 本仓库三个插件）
dsh plugin --profile web add dsh-lsp-actions@0.5.19
./scripts/install-plugins.sh

# 3. 语言服务器路由表（否则 servers 为空，工具齐了但什么都做不了）
#    把 config/web-lsp.patch.yml 的内容并入 ~/.dsh/profiles/web/cordis.patch.yml
```

插件通过 `dsh.bundle.patch` 自挂载，不需要再往用户 patch 层写 insert 行；
但 `servers` 表必须显式声明，默认是空的。

### 本机部署实况（2026-11-09 按上述步骤装完）

`dsh` 与 profile 里全部官方插件都是 **0.2.1-rc.2**（README 早前记的 rc.5 与
`autoInstallPeers` 那段已不适用于当前机器）。装完后：

| 项 | 状态 |
|---|---|
| `dsh-edit-verify` / `dsh-codebase-search` / `dsh-turn-rewind` | 0.1.1，已装为 bundle |
| `dsh-lsp-actions` | 0.5.19，八个 LSP 工具（`lsp_diagnostics` 等） |
| 语言服务器 | rust-analyzer 1.91.1、tsls 4.4.1（TS 5.9.3）、pyright 1.1.414、gopls 0.21.1、clangd 17.0.0 |
| 启动日志 | `warning: 0`、`did not activate` 0 条 |

原先那套 `dsh-plugin-edit-verify`（跑项目 `cargo check` 的版本，
来自另一个仓库）**已卸载**，避免与 `edit-verify` 行 id 冲突。

`dsh-edit-verify` 的 LSP 依赖是**软失败**：没有 `lsp_diagnostics` 工具时它静默什么都不做，
所以“装好了”不等于“真的有诊断”。本机用反证法验证过这条链路是真的——
把服务器路径改成不存在的文件后启动，日志立刻变成：

```
dsh: warning: 1 entry did not activate
lsp-actions (dsh-lsp-actions): SubprocessExecutableNotFoundError: command "/nonexistent/..." is not an executable file
```

真实配置下这条警告不出现，说明五个服务器都在 load 时成功解析。

## 设计约束

| 约束 | 原因 |
|---|---|
| 只读副作用 | 不格式化、不改文件、不跑构建，只问语言服务器它已经知道的事 |
| 失败必须静默 | 没有 `lsp_diagnostics`、扩展名未路由、服务器崩溃、超时 —— 一律当作“什么都不说”，绝不让校验失败污染真正的编辑结果 |
| 有界扇出 | 每次编辑最多一次诊断请求；结果按 `maxDiagnostics` 截断，坏文件不会淹没上下文 |
| 不覆盖 `value` | 只追加 `content`，保留工具自身的 canonical output 契约 |

## 额外发现（重要）

**本条已过期，2026-11-09 重新核实。** 原文说的是“本机 `dsh` 是 0.2.1-rc.5，但
profile 官方插件锁在 rc.2，导致四个插件被禁用”。当前机器上 `dsh` 也是
**0.2.1-rc.2**，profile 里 `dsh-hooks-claude-code` / `dsh-hook-protocol` 同为
rc.2，启动日志里 `did not activate` 是 **0 条**，所以“hooks 拦截器未生效”
这个结论现在不成立。下面保留原文仅作历史记录，不要再照着执行。

<details>
<summary>原文（已过期）</summary>

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

</details>

## 验证

```sh
cd packages/dsh-edit-verify   && node --test test/*.js   # 7 项
cd packages/dsh-codebase-search && node --test test/*.js # 19 项
cd packages/dsh-turn-rewind   && node --test test/*.js   # 12 项
```

**注意这些是纯函数单测**（`mutatedFile` / `chunkSource` / `TurnStore` 等），
它们不跑 `apply()`，也不碰语言服务器。早前 README 曾写“端到端验证使用真实
`ToolRuntime` + 真实 `dsh-lsp-actions` + 真实语言服务器，覆盖五种语言……”，
但那次的 e2e 脚本**从未提交**，仓库里也没有 `e2e` 文件——所以那段描述目前
无法复现。本条已按实际情况改写，避免下次误以为有回归保护。

2026-11-09 补做的验证（本机、真实进程，脚本在 `/tmp`，同样未提交）：

| 验证项 | 方法 | 结果 |
|---|---|---|
| 三个插件能挂载并注册工具 | 桩 context 调真实 `apply()` | `codebase_search`、`rewind_turn` 注册成功；`edit-verify` 挂上 `tools/post-execute` |
| `codebase_search` 真能索引与查询 | 建临时仓库，`node:sqlite` 建索引 | 2 文件 / 3 chunk，命中 `getOrderBookSnapshot` |
| camelCase 子词拆分修复有效 | 查 `reconnect websocket` | 命中 `MarketAdapter.reconnectWebsocket` |
| `lsp_diagnostics` 真能出诊断 | 真实 tsls + 故意类型错误 | `Argument of type 'string' is not assignable to parameter of type 'number'` |
| profile 能干净启动 | `dsh --profile web --port 3999` | 日志 3 行，`warning` / `did not activate` 均 0 |
| 上面这条不是假阳性 | 故意写坏服务器路径再启动 | 立刻报 `warning: 1 entry did not activate` + 具体异常 |

仍未验证：`lsp_format` / `lsp_rename` 等写文件类动作（会触发 sandbox 与
write-intent 通路，本机未跑），以及五语言中除 TypeScript 外的四种真实诊断往返。

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

> 2026-11-09 复核：当前机器已回到统一 **rc.2**（`dsh` 与所有 profile 插件同版本），
> 等价条件——“不兼容警告 0 条、被禁用插件 0 个”——仍然成立。
> 结论有效，但当时那个 rc.5 的具体版本号已不适用于现在的机器。

### 5.2 hooks 自动发现

`config/hooks-discover.patch.yml` 把 `configPath` 从硬编码
`lighting-rust` 改成按仓库根解析：

```
优先级：.dsh/hooks.json > .claude/hooks.json > .claude/settings.json
边界：  从启动目录向上最多 8 层，遇到用户 home 即停止
```

**为什么 `.dsh` 必须排第一**（第一版排反了，差点造成静默失效）：
`lighting-rust` 里两个配置文件都有，但职责完全不同——

| 文件 | matcher | 是否套适配器 | DSH 下能否命中 |
|---|---|---|---|
| `.dsh/hooks.json` | `edit\|write`、`bash\|terminal_send` | ✅ `cc-tool-name.sh` + `stop-adapter.sh` | ✅ |
| `.claude/settings.json` | `Edit\|Write`、`Bash` | ❌ 裸 CC 约定 | ❌ 全部不命中 |

DSH 发的是小写工具名，`.claude` 的 matcher 是 CC 大小写，**永远匹配不上**。
更危险的是 `terminal_send` 把命令放在 `tool_input.text`，裸 `bash-guard.sh`
读 `tool_input.command` 读不到。

实测对照（同一份危险命令 `rm -rf /`）：

```
$ echo '{"tool_name":"terminal_send","tool_input":{"text":"rm -rf /"}}' | .claude/hooks/bash-guard.sh
EXIT 0      ← 放行，漏洞

$ echo '{"tool_name":"terminal_send","tool_input":{"text":"rm -rf /"}}' | .dsh/hooks/cc-tool-name.sh .claude/hooks/bash-guard.sh
BLOCKED: 禁止删除根目录或用户目录
EXIT 2      ← 正确拦截
```

所以如果发现逻辑先命中 `.claude/settings.json`，所有 guard 会**看起来已加载、
实际全部失效**——这比没装 hooks 更糟，因为它给人虚假的安全感。

**为什么要停在家目录**：`~/.claude/settings.json` 是用户全局偏好，
不是某个仓库的策略。最初的实现会把全局 hooks 套用到所有仓库，这是错的。

**实现约束**：`!!js` 在 `new Function` 里求值，**没有 `require`**。
必须用 `process.getBuiltinModule('node:fs')` 同步取内置模块。
（第一版用了 `require`，真实启动直接 `ReferenceError`。）

实测：从 lighting-rust 启动 → 绑定它的 `.claude/settings.json`；
从其它仓库启动 → 无 hooks、零报错、优雅降级。

## 第六轮：收口三个真实缺陷

这轮不是加功能，是修前几轮留下的问题。三个都是实测出来的。

### 6.1 rewind 存储无限增长（存储泄漏）

`TurnStore.discard()` 写好了但**从未被调用**，是死代码。快照只进不出，
一台机器用久了会一直涨。

修复：加 `prune(retainDays, maxSessions)`，插件加载时跑一次
（窗口按天算，没必要每轮扫目录）。默认保留 14 天 / 最多 50 个会话。
`retainDays: 0` 或 `maxSessions: 0` 可分别关闭对应策略。

### 6.2 测试代码仍然压过实现（检索质量）

上一轮用了 `+3.0` 的**加性**惩罚，实测不够：

```
bm25  raw        +3.0 后      符号
-30.64  →  -27.64          test_freeze_balance_insufficient
-18.27  →  -18.27          freeze_balance_for_trading   ← 真实实现反而排后
```

bm25 是**负数、越负越好**，强匹配的测试可以领先实现十几分，固定加值永远追不上。

修复：改**乘性**降权（测试分 × 0.15），把测试整体压到实现之后。
现在 `freeze balance insufficient` 返回 `freeze_balance_for_trading`。

### 6.3 仓库没忽略派生索引

`.dsh/codebase-index.sqlite` 会被误提交。已加入 `.gitignore`。

## 下一步（尚未做）

1. **模型分工** —— 默认走便宜模型，plan/review 走强模型
2. **行内补全** —— Monaco 侧接编辑预测（补 A4），投入产出比最低
