# Claude Session Monitor

ローカルで動かしている複数の Claude Code セッションを **Web ダッシュボードで俯瞰・進捗管理**するツール。

- 稼働中の全セッションを**カード表示**（status / リポ / タイトル / 直近活動の Haiku 要約 / 経過）
- どれが **🔴許可待ち / ⚪あなたの番 / 🟢稼働中** かを一目で把握（リポ別グルーピング・折りたたみも可）
- カードの **「↗ 飛ぶ」** で、そのセッションが動く WezTerm ペインへ切替＋前面化
- モーダルから**返答を直接送信**（画像パス添付可）。人格学習されたドラフト自動生成＋自己改善ループ
- **PR レビューボード**: 自分が関与する open PR を一覧、「🔵あなたの番」判定、レビューセッションのワンクリック起動、作業中セッションへのジャンプ
- 新規セッション起動のトリガー（起動・対話自体は CLI の役割。本ツールは進捗管理特化）

## 必要環境

| 依存 | 必須/任意 | 用途 |
|---|---|---|
| macOS | 必須 | `osascript`（前面化・ファイル選択）、`ps` を使用 |
| Node.js 22.5+ | 必須 | 標準モジュールのみ。`npm install`・ビルド不要 |
| `claude` CLI | 必須 | `claude agents --json` でセッション一覧取得 |
| WezTerm | 任意 | 「飛ぶ」「新規起動」「送信」（`brew install --cask wezterm`） |
| `gh` CLI | 任意 | PR レビューボード（`brew install gh && gh auth login`） |

欠けている任意依存は起動時 doctor が検出し、ダッシュボード上部に警告を出します（該当機能だけ無効になり他は動きます）。

## インストール（常駐）

```bash
git clone <このリポジトリ>
cd session-orchestrator
bash setup/install.sh
# → http://127.0.0.1:4317
```

`install.sh` は依存検出 → launchd plist 生成（PATH 込み）→ 常駐起動 → 設定雛形作成まで行います。
常駐せず手動で動かす場合は `node src/server.js`。

アンインストール: `launchctl unload ~/Library/LaunchAgents/com.claude-session-monitor.plist && rm ~/Library/LaunchAgents/com.claude-session-monitor.plist`

## 設定

優先順位: **環境変数 `ORCH_*` > `~/.claude-orchestrator/config.json` > デフォルト**。
設定ファイルの場所は `ORCH_CONFIG` で変更可能。

| config.json キー | env | デフォルト | 説明 |
|---|---|---|---|
| `defaultCwd` | `ORCH_DEFAULT_CWD` | サーバ起動 dir | 新規セッション・レビュー起動の作業ディレクトリ（窓口） |
| `workspaceRoot` | `ORCH_WORKSPACE` | （なし） | リポ逆引きの探索ルート。**未設定だと PR↔セッション紐付けが無効** |
| `presets` | `ORCH_PRESETS` | defaultCwd 1件 | 新規起動ボタン `[{"label":"x","cwd":"/path"}]` |
| `permissionMode` | `ORCH_PERMISSION_MODE` | `default` | 起動セッションの `--permission-mode`。`default`=確認制。自動承認したい場合のみ `bypassPermissions`（リスク理解の上で） |
| `reviewPrompt` | `ORCH_REVIEW_PROMPT` | 汎用レビュー文 | レビュー起動の初手プロンプト。`{number} {url} {repo} {branch}` を置換。独自ワークフロー（プラグイン等）はここで差し替え |
| `personaDailyDir` | `ORCH_DAILY_DIR` | （なし） | 人格学習の補助ソース（`daily/*.md` を持つ dir）。未設定ならスキップ |
| `summaryModel` | `ORCH_SUMMARY_MODEL` | `claude-haiku-4-5` | カード要約用モデル |
| `draftModel` | `ORCH_DRAFT_MODEL` | claude 既定 | ドラフト生成用モデル |
| `host` / `port` | `ORCH_HOST/PORT` | `127.0.0.1` / `4317` | バインド先 |
| `staleMin` | `ORCH_STALE_MIN` | 30 | idle 放置マークの閾値（分） |
| `sentExcludeMode` | `ORCH_SENT_EXCLUDE` | `all` | 人格サンプルの自己汚染対策（`all`=送信全除外） |
| `learnThreshold` / `evalMin` / `rollbackThreshold` | `ORCH_LEARN_*` 等 | 10 / 5 / 0.05 | 人格自己進化の閾値 |

設定例（`~/.claude-orchestrator/config.json`）:

```json
{
  "defaultCwd": "/Users/you/workspace/main-repo",
  "workspaceRoot": "/Users/you/workspace",
  "presets": [
    { "label": "main-repo", "cwd": "/Users/you/workspace/main-repo" }
  ],
  "permissionMode": "default"
}
```

## セキュリティ上の注意

- **外部公開しないこと。** このサーバは「任意 cwd で claude を起動・テキスト送信」できる＝実質任意コマンド実行に近い権限を持つ。`127.0.0.1` バインド（デフォルト）を変更しない
- `~/.claude-orchestrator/records.jsonl`（送信履歴・人格学習データ）には**業務情報が含まれる**。外部に送信・共有しない
- `permissionMode: "bypassPermissions"` は起動セッションの全コマンドを自動承認する。worktree 等で作業が隔離されている運用でのみ検討すること

## 使い方の流れ

1. **セッションタブ**: WezTerm 上で `claude` を起動すると自動でカード化。🔴（許可・入力待ち）が最優先表示
2. カードクリック → 直近のやり取り確認 → 返答を手入力 or **ドラフト生成** → 承認して送信（Enter は飛んだ先で人間が押す）
3. **📷 画像添付**: スクショ等のパスを返答に埋め込み、claude に画像を見せて指示できる
4. **PR タブ**: 自分のレビュー待ち（🔵=ボールが自分）と自分の PR の状態を一覧。**レビュー起動**で `reviewPrompt` に沿ったレビューセッションを起動。該当ブランチで作業中のセッションがあれば**↗ セッションへ飛ぶ**
5. **⚙ 設定ページ**: 人格学習の進捗・バージョン履歴・ロールバック

## アーキテクチャ

```
src/config.js   設定（env > config.json > デフォルト）
src/server.js   HTTP + SSE（node:http のみ・外部依存ゼロ）
src/live.js     claude agents ↔ WezTerm pane 突合、ドラフト生成、人格
src/prs.js      gh による PR 取得・ボール判定
src/learn.js    人格の自動再学習・効果測定・ロールバック
public/         素の JS/HTML（ビルドなし）
```

データ保存先: `~/.claude-orchestrator/`（persona/ と records.jsonl）。
