# 全局工作规则 / Global working rules

适用于**所有仓库、所有会话**。项目级 `AGENTS.md` 可以补充，但不能推翻这里的规则。

---

## 一、工作目录：用 `working_directory`，不要拼 `cd`

**这是一条硬规则。**

需要换目录时：

```
working_directory({ cd: "/path/to/project" })
bash({ command: "git status" })
```

**禁止**：

```
bash({ command: "cd /path/to/project && git status" })
```

### 为什么

实测本机全部历史会话（32407 次工具调用）：

| 指标 | 数值 |
|---|---|
| bash 调用占全部工具调用 | **84%** |
| 其中以 `cd &&` 开头 | **37672 次** |
| 使用 `working_directory` | **105 次** |
| 比例 | **359 : 1** |

后果：

1. **步数膨胀**：本可一步完成的操作用两步，平均每轮 19 步里大部分浪费在这
2. **缓存失效**：命令字符串不同，前缀无法复用
3. **错误叠加**：路径写错 → 重试 → 步数继续涨

`working_directory` 由 DSH 按会话维护、持久化，比每条命令带前缀更可靠。

### 例外

- 一次性进入**子目录**执行单条命令、且之后不再需要，可以用 `cd sub/dir && cmd`
- 用 `bash` 工具的 `workdir` 参数也可以（等价效果）
- 需要在一条命令里**临时**切目录做多件事（极少见）

---

## 二、先规划，再动手

复杂任务（预计超过 3 步）先 `todo_write` 列计划，再逐项执行。

**避免**：一步一试、边试边想，这是步数失控的第二大来源。

---

## 三、重活派给 subagent，不要切主模型

主会话**整个会话固定一个模型**。中途换模型会让 KV 缓存 100% 失效。

需要更强模型时，派 subagent：

```
subagent({
  description: "审查交易逻辑",
  provider: "anexto",
  model: "claude-opus-5-5",
  prompt: "……自包含的任务描述……"
})
```

详见 `model-routing` skill。

---

## 四、重要信息落盘，不要指望上下文

上下文压缩是有损的。关键决策、踩过的坑、架构约定，**立刻写进文件**
（`docs/decisions.md`、项目规则文件等），之后用 `codebase_search` / `grep` 查回来。

记忆的保障不是"上下文不丢"，而是"信息在上下文之外有副本"。

---

## 五、改动前先检索

- 知道**字面量**（函数名、错误信息）→ `grep`
- 知道**行为**、不知道命名 → `codebase_search`
- 拿到 `file:line` 后**必须** `read` 原文再动手，索引片段是截断的

详见 `code-change-workflow` skill。

---

## 六、常用路径

| 用途 | 路径 |
|---|---|
| DSH 宿主包 | `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` |
| profile 配置 | `~/.dsh/profiles/web/cordis.patch.yml` |
| 全局 skills | `~/.dsh/skills/` |
| 会话日志 | `~/.dsh/sessions/<仓库路径编码>/<session-id>/session.v4.jsonl.zstd` |
