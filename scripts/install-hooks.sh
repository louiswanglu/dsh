#!/bin/bash
# 安装本仓库的 git 钩子 / Install this repository's git hooks
#
# 钩子本身放在 scripts/ 里受版本控制，.git/hooks 只是软链接指向它。
# 这样别人 clone 之后跑一次就能用上，而不是把脚本散落在 .git 里。
# The hook lives in scripts/ under version control; .git/hooks only symlinks to
# it, so a fresh clone gets it by running this once.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

HOOKS_DIR="$(git rev-parse --git-path hooks)"
mkdir -p "$HOOKS_DIR"

for hook in pre-commit; do
  src="scripts/${hook}-secret-scan.sh"
  [[ -f "$src" ]] || { echo "✗ 缺少 $src" >&2; exit 1; }
  chmod +x "$src"
  ln -sf "../../$src" "$HOOKS_DIR/$hook"
  echo "✓ 已安装 $hook → $src"
done

echo ""
echo "验证 / Verify:"
echo "  bash scripts/pre-commit-secret-scan.sh   # 手动跑一次（无暂存内容时直接通过）"
echo "  绕过单次提交 / bypass once: git commit --no-verify"
