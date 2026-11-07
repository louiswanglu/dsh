#!/bin/bash
# 重新打包并安装本仓库的 DSH 插件 / Repack and reinstall this repo's DSH plugins
#
# 为什么需要这个脚本 / Why this exists:
#   插件是通过 tgz 装进 profile 的（不是 link:），好处是 profile 不依赖这个
#   源码目录。代价是：改了 packages/*/lib 之后，不重新打包安装，改动不会生效。
#   手工记住这件事很容易忘，所以把它变成一条命令。
#
#   The plugins are installed from tarballs rather than link:, so the profile does
#   not depend on this checkout. The trade-off is that editing packages/*/lib has
#   no effect until you repack and reinstall. This script makes that one command.
#
# 用法 / Usage:
#   ./scripts/install-plugins.sh              # 重新打包 + 安装到 web profile
#   ./scripts/install-plugins.sh --check      # 只比对，不安装
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="$HOME/.dsh/packages"
PROFILE="${DSH_PROFILE:-web}"
PLUGINS=(dsh-edit-verify dsh-codebase-search dsh-turn-rewind)
CHECK_ONLY=false
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=true

mkdir -p "$PKG_DIR"

drift=0
for p in "${PLUGINS[@]}"; do
  src="$REPO_ROOT/packages/$p/lib/index.js"
  installed="$HOME/.dsh/profiles/$PROFILE/node_modules/$p/lib/index.js"
  if [[ ! -f "$src" ]]; then
    echo "✗ $p: 源码缺失 $src" >&2
    exit 1
  fi
  if [[ -f "$installed" ]] && cmp -s "$src" "$installed"; then
    echo "  $p: 已同步"
  else
    echo "  $p: 有差异"
    drift=1
  fi
done

if $CHECK_ONLY; then
  if [[ $drift -eq 1 ]]; then
    echo ""
    echo "有插件未同步。运行 ./scripts/install-plugins.sh 安装。"
    exit 1
  fi
  echo ""
  echo "全部已同步。"
  exit 0
fi

# 同步 src → lib，保证打包的是最新构建产物
for p in "${PLUGINS[@]}"; do
  if [[ -f "$REPO_ROOT/packages/$p/src/index.js" ]]; then
    cp "$REPO_ROOT/packages/$p/src/index.js" "$REPO_ROOT/packages/$p/lib/index.js"
  fi
done

echo ""
echo "打包中…"
tarballs=()
for p in "${PLUGINS[@]}"; do
  # 版本号补丁位 +1，让 pnpm 认出这是新包
  cur=$(node -p "require('$REPO_ROOT/packages/$p/package.json').version")
  next=$(node -e "
    const [maj,min,pat] = '$cur'.split('.').map(Number);
    console.log(\`\${maj}.\${min}.\${pat + 1}\`);
  ")
  node -e "
    const fs = require('fs');
    const f = '$REPO_ROOT/packages/$p/package.json';
    const j = JSON.parse(fs.readFileSync(f));
    j.version = '$next';
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  "
  ( cd "$REPO_ROOT/packages/$p" && pnpm pack --pack-destination "$PKG_DIR" >/dev/null 2>&1 )
  tarballs+=("$PKG_DIR/$p-$next.tgz")
  echo "  $p → $next"
done

echo ""
echo "安装到 profile: $PROFILE"
dsh plugin --profile "$PROFILE" add "${tarballs[@]}" 2>&1 | grep -vE "Progress|WARN|deprecated" | tail -8

echo ""
echo "完成。重启 DSH 生效。"
