// 設定値の単一ソース。
// 優先順位: 環境変数 > 設定ファイル (~/.claude-orchestrator/config.json) > デフォルト。
// 設定ファイルの場所は ORCH_CONFIG で変更可能。キーは ORCH_ を除いた camelCase（例: ORCH_PORT → port）。
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';

// ---- 設定ファイル読み込み ----
const CONFIG_PATH = process.env.ORCH_CONFIG || join(homedir(), '.claude-orchestrator', 'config.json');
let fileConf = {};
try {
  fileConf = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
} catch { /* 無ければデフォルトで動く */ }

// env > config.json > デフォルト の解決ヘルパー。
// 空文字は「未設定」扱い（install.sh の雛形が "" を書くため。"" がデフォルトを潰すのを防ぐ）
const pick = (envName, fileKey, dflt) => {
  if (process.env[envName] !== undefined && process.env[envName] !== '') return process.env[envName];
  if (fileConf[fileKey] !== undefined && fileConf[fileKey] !== '') return fileConf[fileKey];
  return dflt;
};
const pickNum = (envName, fileKey, dflt) => Number(pick(envName, fileKey, dflt));

const defaultCwd = pick('ORCH_DEFAULT_CWD', 'defaultCwd', process.cwd());

// プリセット: 新規セッションを起動するリポ一覧。
// env: ORCH_PRESETS='[{"label":"e-sogi","cwd":"/path/to/repo"}]' / config.json: "presets": [...]
function parsePresets() {
  if (process.env.ORCH_PRESETS) {
    try { return JSON.parse(process.env.ORCH_PRESETS); } catch { /* fallthrough */ }
  }
  if (Array.isArray(fileConf.presets) && fileConf.presets.length) return fileConf.presets;
  return [{ label: basename(defaultCwd), cwd: defaultCwd }];
}

// PR レビュー起動の初手プロンプト。{number} {url} {repo} {branch} を置換する。
// デフォルトは汎用（gh pr checkout → レビュー）。/engineer 等のワークフローを使う場合は config.json で差し替える。
const DEFAULT_REVIEW_PROMPT = 'PR #{number}（{url}）をレビューしてください。'
  + 'まず `gh pr checkout {number}` でブランチを取得し、変更内容（git diff / gh pr diff）を確認して、'
  + '仕様整合性・コード品質・テストの観点でレビュー結果をまとめてください。\n'
  + '- リポジトリ: {repo}\n- ブランチ: {branch}';

export const config = {
  // サーバはローカル限定でバインドする（claude を起動できる＝強い権限のため外部公開しない）
  host: pick('ORCH_HOST', 'host', '127.0.0.1'),
  port: pickNum('ORCH_PORT', 'port', 4317),

  // claude 実行ファイル
  claudeBin: pick('ORCH_CLAUDE_BIN', 'claudeBin', 'claude'),

  // Live セッション（claude agents）のポーリング間隔 ms
  livePollMs: pickNum('ORCH_LIVE_POLL_MS', 'livePollMs', 4000),
  // idle セッションが何分放置されたら「放置中」マークを付けるか
  staleMin: pickNum('ORCH_STALE_MIN', 'staleMin', 30),

  // 「飛ぶ」で前面化するターミナルアプリ（macOS app 名）
  terminalApp: pick('ORCH_TERMINAL_APP', 'terminalApp', 'WezTerm'),

  // wezterm 実行ファイル
  weztermBin: pick('ORCH_WEZTERM_BIN', 'weztermBin', 'wezterm'),

  // 新規起動のプリセット
  presets: parsePresets(),

  // 人格ドラフト返答（Phase7）
  draftModel: pick('ORCH_DRAFT_MODEL', 'draftModel', ''), // 空なら claude のデフォルトモデル
  // 行サマリ要約用モデル（軽量・安価な Haiku を既定に）
  summaryModel: pick('ORCH_SUMMARY_MODEL', 'summaryModel', 'claude-haiku-4-5'),
  // 人格サンプルから除外する送信テキスト: 'all'=送信全部 / 'as_is'=無編集承認のみ（自己汚染対策）
  sentExcludeMode: pick('ORCH_SENT_EXCLUDE', 'sentExcludeMode', 'all'),

  // 人格自己進化（Phase8）
  learnThreshold: pickNum('ORCH_LEARN_THRESHOLD', 'learnThreshold', 10),   // 未学習が何件で再学習するか
  evalMin: pickNum('ORCH_EVAL_MIN', 'evalMin', 5),                         // 効果測定に必要な新版での送信件数
  rollbackThreshold: pickNum('ORCH_ROLLBACK_THRESHOLD', 'rollbackThreshold', 0.05), // diff_ratio がこれ以上悪化で巻き戻し
  learnTickMs: pickNum('ORCH_LEARN_TICK_MS', 'learnTickMs', 30000),        // 学習ジョブの監視間隔
  // 人格の補助ソース: daily/決定ログのディレクトリ。未設定ならスキップ（任意機能）
  personaDailyDir: pick('ORCH_DAILY_DIR', 'personaDailyDir', ''),

  // リポ→ローカルパス逆引きの探索ルート（git remote をスキャン）。
  // 未設定なら逆引き無効＝PR↔セッション紐付けが効かないだけで他は動く（任意機能）
  workspaceRoot: pick('ORCH_WORKSPACE', 'workspaceRoot', ''),

  // 起動セッションの権限モード（--permission-mode で settings の defaultMode を上書き）。
  // 配布デフォルトは安全側の 'default'（確認制）。自動承認したい人は config.json で緩める。
  permissionMode: pick('ORCH_PERMISSION_MODE', 'permissionMode', 'default'),

  // PR レビュー起動の初手プロンプトテンプレート
  reviewPrompt: pick('ORCH_REVIEW_PROMPT', 'reviewPrompt', DEFAULT_REVIEW_PROMPT),

  defaultCwd,
  configPath: CONFIG_PATH, // doctor 表示用
};
