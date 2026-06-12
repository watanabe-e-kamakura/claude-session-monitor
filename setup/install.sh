#!/bin/bash
# Claude Session Monitor インストーラ（macOS）
# - 依存コマンドを検出して launchd plist を生成・ロードし、常駐させる
# - 設定ファイルの雛形 ~/.claude-orchestrator/config.json を作成（無い場合のみ）
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.claude-session-monitor"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
CONF_DIR="$HOME/.claude-orchestrator"
CONF="$CONF_DIR/config.json"

echo "Claude Session Monitor installer"
echo "  app dir: $APP_DIR"

# ---- 依存チェック ----
fail=0
find_bin() { command -v "$1" 2>/dev/null || true; }

NODE_BIN="$(find_bin node)"
if [ -z "$NODE_BIN" ]; then echo "✗ node が見つかりません（Node.js 22.5+ が必要）"; fail=1; else
  ver="$($NODE_BIN -v | sed 's/^v//')"
  echo "✓ node $ver ($NODE_BIN)"
fi

CLAUDE_BIN="$(find_bin claude)"
if [ -z "$CLAUDE_BIN" ]; then echo "✗ claude CLI が見つかりません（必須: セッション一覧取得に使用）"; fail=1; else
  echo "✓ claude ($CLAUDE_BIN)"
fi

WEZTERM_BIN="$(find_bin wezterm)"
if [ -z "$WEZTERM_BIN" ]; then echo "△ wezterm なし（任意: 「飛ぶ」「新規起動」「送信」が無効になる。brew install --cask wezterm）"; else
  echo "✓ wezterm ($WEZTERM_BIN)"
fi

GH_BIN="$(find_bin gh)"
if [ -z "$GH_BIN" ]; then echo "△ gh なし（任意: PR レビューボードが無効になる。brew install gh && gh auth login）"; else
  echo "✓ gh ($GH_BIN)"
fi

[ "$fail" = 1 ] && { echo "必須依存が不足しています。導入後に再実行してください。"; exit 1; }

# ---- 設定ファイル雛形（無い場合のみ作成。既存は触らない）----
if [ ! -f "$CONF" ]; then
  mkdir -p "$CONF_DIR"
  cat > "$CONF" <<'JSON'
{
  "_comment": "Claude Session Monitor 設定。キーは src/config.js 参照。環境変数 ORCH_* が優先されます。",
  "defaultCwd": "",
  "workspaceRoot": "",
  "permissionMode": "default"
}
JSON
  echo "✓ 設定雛形を作成: $CONF（defaultCwd / workspaceRoot を自分の環境に合わせて編集してください）"
else
  echo "✓ 既存の設定を使用: $CONF"
fi

# ---- plist 生成（claude/wezterm/gh の親ディレクトリを PATH に集約）----
PATH_ENTRIES="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
for b in "$CLAUDE_BIN" "$WEZTERM_BIN" "$GH_BIN" "$NODE_BIN"; do
  [ -z "$b" ] && continue
  d="$(dirname "$b")"
  case ":$PATH_ENTRIES:" in *":$d:"*) ;; *) PATH_ENTRIES="$d:$PATH_ENTRIES";; esac
done

sed -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__APP_DIR__|$APP_DIR|g" \
    -e "s|__PATH__|$PATH_ENTRIES|g" \
    "$APP_DIR/setup/$LABEL.plist.template" > "$PLIST_DST"
echo "✓ plist 生成: $PLIST_DST"

# ---- ロード（再実行時は入れ替え）----
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load -w "$PLIST_DST"
sleep 2

if curl -sf -o /dev/null "http://127.0.0.1:4317/api/live"; then
  echo
  echo "🎉 起動しました → http://127.0.0.1:4317"
  echo "   設定: $CONF / ログ: /tmp/claude-session-monitor.log"
else
  echo
  echo "⚠ 起動確認に失敗。/tmp/claude-session-monitor.err を確認してください。"
  exit 1
fi
