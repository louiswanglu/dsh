#!/bin/bash
# 提交前敏感信息扫描 / Pre-commit secret scan
#
# 为什么需要 / Why:
#   这个仓库是公开的。曾经有一次把包含公司内网网关地址的 profile 快照
#   提交上来，事后只能靠改写历史补救。把关口放在提交之前，代价最小。
#   This repository is public. A profile snapshot carrying an internal gateway
#   hostname was committed once and had to be scrubbed from history afterwards.
#   Catching it before the commit is far cheaper.
#
# 设计取舍 / Trade-offs:
#   - 只看**新增/修改的行**，不看整个历史：否则首次运行会被旧内容淹没。
#   - 密钥类一律硬性拦截（几乎不可能误报）。
#   - 内网地址类同样拦截，但允许通过 allowlist 放行（例如文档里举例）。
#   - 二进制文件跳过。误报代价远高于漏报，但这里两类都足够精确。
#   - Only added lines are scanned, so the first run is not drowned by history.
#   - Credentials block unconditionally. Internal hosts block too, with an
#     allowlist escape hatch for documentation examples.
#   - Binary files are skipped.
#
# 绕过 / Bypass:
#   git commit --no-verify        （慎用 / use sparingly）
#   或把该行加入下面的 ALLOW 列表。

set -uo pipefail

ALLOW_FILE=".git/pre-commit-allowlist"
RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'

# ── 严格规则：无条件拦截 / Hard rules: block unconditionally ──────────────
# 形如 sk-xxxx、AKIA...、ghp_...、-----BEGIN PRIVATE KEY-----
HARD_PATTERNS=(
  'sk-[A-Za-z0-9_-]{16,}'
  'AKIA[0-9A-Z]{16}'
  'gh[pousr]_[A-Za-z0-9]{20,}'
  'xox[baprs]-[A-Za-z0-9-]{10,}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.' # JWT
)

# ── 可疑规则：拦截但可放行 / Suspicious rules: block with an allowlist ────
SOFT_PATTERNS=(
  '(api[_-]?key|secret|password|passwd|token)[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"']{12,}["'"'"']'
  '(https?|wss?)://[A-Za-z0-9.-]*(internal|corp|intranet|advai)[A-Za-z0-9.-]*'
  '(https?|wss?)://(10|127|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9]'
)

# 这些文件按设计就包含示例值 / Files that are expected to contain examples
SKIP_PATHS=(
  '^\.git/'
  '^node_modules/'
  '^.*/node_modules/'
  '^\.dsh/'
)

is_skipped() {
  local f="$1"
  for p in "${SKIP_PATHS[@]}"; do
    [[ "$f" =~ $p ]] && return 0
  done
  return 1
}

is_allowed() {
  [[ -f "$ALLOW_FILE" ]] || return 1
  local line="$1"
  while IFS= read -r rule; do
    [[ -z "$rule" || "$rule" == \#* ]] && continue
    [[ "$line" == *"$rule"* ]] && return 0
  done < "$ALLOW_FILE"
  return 1
}

is_binary() {
  local f="$1"
  [[ -f "$f" ]] || return 1
  # NUL 字节判定 / NUL-byte heuristic
  LC_ALL=C grep -qP '\x00' "$f" 2>/dev/null
}

blocked_hard=0
blocked_soft=0
declare -a findings=()

# 取本次提交新增的行 / Added lines in this commit
while IFS= read -r file; do
  is_skipped "$file" && continue
  is_binary "$file" && continue
  [[ -f "$file" ]] || continue

  # 新增行及其行号 / Added lines with numbers
  added=$(git diff --cached --unified=0 -- "$file" 2>/dev/null \
    | grep -E '^\+' | grep -vE '^\+\+\+' | sed 's/^+//')

  [[ -z "$added" ]] && continue

  lineno=0
  while IFS= read -r line; do
    lineno=$((lineno + 1))
    for p in "${HARD_PATTERNS[@]}"; do
      if printf '%s' "$line" | grep -qE "$p" 2>/dev/null; then
        findings+=("HARD|$file|$line")
        blocked_hard=$((blocked_hard + 1))
        break
      fi
    done
    for p in "${SOFT_PATTERNS[@]}"; do
      if printf '%s' "$line" | grep -qE "$p" 2>/dev/null; then
        if ! is_allowed "$line"; then
          findings+=("SOFT|$file|$line")
          blocked_soft=$((blocked_soft + 1))
        fi
        break
      fi
    done
  done <<< "$added"
done < <(git diff --cached --name-only --diff-filter=ACM)

total=$((blocked_hard + blocked_soft))
if [[ $total -gt 0 ]]; then
  echo ""
  echo "${RED}✗ 提交被拦截：检测到 $total 处敏感信息${RESET}"
  echo "${RED}  Commit blocked: $total potential secret(s) detected${RESET}"
  echo ""
  for f in "${findings[@]}"; do
    IFS='|' read -r kind file line <<< "$f"
    if [[ "$kind" == "HARD" ]]; then
      echo "  ${RED}[密钥] $file${RESET}"
    else
      echo "  ${YELLOW}[可疑] $file${RESET}"
    fi
    # 打码显示，避免把密钥本身打印到终端或日志
    masked=$(printf '%s' "$line" | sed -E 's/([A-Za-z0-9_\-]{6})[A-Za-z0-9_\-]{6,}/\1***/g' | cut -c1-110)
    echo "    ${DIM}$masked${RESET}"
    echo ""
  done
  echo "  处理方式 / How to fix:"
  echo "    1) 从提交中移除该内容，改用环境变量或凭据服务"
  echo "    2) 若是文档示例，把该行加入 $ALLOW_FILE 后重试"
  echo "    3) 确认无误可跳过：git commit --no-verify"
  echo ""
  exit 1
fi

echo "✓ 敏感信息扫描通过 / secret scan passed"
exit 0
