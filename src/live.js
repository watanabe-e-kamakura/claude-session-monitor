// Live セッション: 稼働中の claude を一覧化し、WezTerm のペインと紐付け、
// 「飛ぶ」（該当ペインを activate + WezTerm 前面化）と新規起動を行う。
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { openSync, readSync, closeSync, fstatSync, statSync, readFileSync, readdirSync, mkdirSync, realpathSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { config } from './config.js';

const execFileP = promisify(execFile);

// ドラフト生成用 claude を起動する専用 cwd。一覧からはこの cwd のプロセスを除外する
// （生成中の使い捨て claude が一時的に claude agents に出るのを隠すため）。
export const DRAFT_CWD = (() => {
  const d = join(tmpdir(), 'orch-draft-sandbox');
  try { mkdirSync(d, { recursive: true }); return realpathSync(d); } catch { return d; }
})();

// ---- claude agents --json ----
async function listAgents() {
  try {
    const { stdout } = await execFileP(config.claudeBin, ['agents', '--json'], {
      timeout: 8000, maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout || '[]');
  } catch {
    return [];
  }
}

// ---- WezTerm ペイン一覧（未インストール/mux未起動なら []）----
async function listWeztermPanes() {
  try {
    const { stdout } = await execFileP(config.weztermBin, ['cli', 'list', '--format', 'json'], { timeout: 3000 });
    return JSON.parse(stdout || '[]'); // [{pane_id, tty_name, cwd, window_id, tab_id, title, is_active}]
  } catch {
    return [];
  }
}

// claude プロセスの tty を取得（例: macOS なら "ttys004" → "/dev/ttys004"）
function ttyOf(pid) {
  try {
    const t = execFileSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    if (!t || t === '??' || t === '?') return null;
    return t.startsWith('/dev/') ? t : `/dev/${t}`;
  } catch {
    return null;
  }
}

// claude pid の tty と一致する WezTerm ペインを返す
function matchPane(pid, panes) {
  const tty = ttyOf(pid);
  if (!tty) return null;
  const p = panes.find((pane) => pane.tty_name === tty);
  if (!p) return null;
  return {
    paneId: p.pane_id,
    windowId: p.window_id,
    tabId: p.tab_id,
    title: p.title,
    tty: p.tty_name,
    target: `pane ${p.pane_id}`,
  };
}

// ---- transcript jsonl の場所と直近活動 ----
function transcriptPath(cwd, sessionId) {
  const encoded = cwd.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

function recentActivity(cwd, sessionId) {
  const file = transcriptPath(cwd, sessionId);
  let fd;
  try {
    fd = openSync(file, 'r');
    const { size, mtimeMs } = fstatSync(fd);
    const readLen = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(readLen);
    readSync(fd, buf, 0, readLen, size - readLen);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    let text = null;
    for (let i = lines.length - 1; i >= 0 && !text; i--) {
      try { text = extractText(JSON.parse(lines[i])); } catch { /* 部分行は無視 */ }
    }
    return { text: text ? truncate(text, 140) : null, updatedAt: mtimeMs };
  } catch {
    return { text: null, updatedAt: null };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function extractText(obj) {
  const content = obj?.message?.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c.type === 'text' && c.text?.trim()) return c.text.trim();
      if (c.type === 'tool_use') return `🔧 ${c.name}`;
    }
  } else if (typeof content === 'string' && content.trim()) {
    return content.trim();
  }
  return null;
}

// ---- 行サマリ（Haiku で「今何をしている/何待ちか」を要約。本家 Agent View 風）----
const summaryCache = new Map(); // sid -> { summary, mtime, at }
export function getSummary(sessionId) { return summaryCache.get(sessionId)?.summary || null; }

async function generateSummary(sessionId, cwd, mtime) {
  const tail = transcriptTail(cwd, sessionId, 2000);
  if (!tail) return;
  const prompt = `次は進行中の Claude Code セッションの直近のやり取りです。このセッションが「今何をしているか／何を待っているか」を日本語20〜30字で1行だけ要約してください。要約文のみ出力（前置き・記号なし）。\n\n${tail}`;
  try {
    const { stdout } = await execFileP(config.claudeBin,
      ['-p', prompt, '--model', config.summaryModel, '--no-session-persistence'],
      { timeout: 30000, maxBuffer: 1024 * 1024, cwd: DRAFT_CWD });
    const summary = (stdout.trim().split('\n')[0] || '').slice(0, 70);
    if (summary) summaryCache.set(sessionId, { summary, mtime, at: Date.now() });
  } catch { /* noop */ }
}

// live セッションのうち、更新があったものだけ要約を更新（15秒スロットル）。fire-and-forget。
export function refreshSummaries(sessions) {
  for (const s of sessions) {
    const mtime = s.updatedAt || 0;
    const c = summaryCache.get(s.sessionId);
    if (c && c.mtime === mtime) continue;          // 更新なし
    if (c && Date.now() - c.at < 15000) continue;  // 15秒に1回まで
    generateSummary(s.sessionId, s.cwd, mtime);
  }
}

// ---- セッションのタイトル（~/.claude/history.jsonl の display 履歴から）----
let histCache = { mtime: 0, map: new Map() };
function loadHistory() {
  const file = join(homedir(), '.claude', 'history.jsonl');
  try {
    const { mtimeMs } = statSync(file);
    if (mtimeMs === histCache.mtime) return histCache.map;
    const map = new Map();
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.sessionId && o.display) {
          if (!map.has(o.sessionId)) map.set(o.sessionId, []);
          map.get(o.sessionId).push(o.display);
        }
      } catch { /* skip */ }
    }
    histCache = { mtime: mtimeMs, map };
    return map;
  } catch {
    return histCache.map;
  }
}

// ユーザーが付けたカスタムタイトル（永続化。自動生成より優先）
const TITLES_PATH = join(homedir(), '.claude-orchestrator', 'titles.json');
let customTitles = (() => {
  try { return JSON.parse(readFileSync(TITLES_PATH, 'utf8')); } catch { return {}; }
})();
export function setCustomTitle(sessionId, title) {
  if (title && title.trim()) customTitles[sessionId] = title.trim();
  else delete customTitles[sessionId];
  try { mkdirSync(dirname(TITLES_PATH), { recursive: true }); writeFileSync(TITLES_PATH, JSON.stringify(customTitles)); } catch { /* noop */ }
}

function sessionTitle(sessionId) {
  if (customTitles[sessionId]) return customTitles[sessionId]; // カスタム優先
  const ds = loadHistory().get(sessionId);
  if (!ds || !ds.length) return null;
  const meaningful = ds.find((d) => !d.trim().startsWith('/') && d.trim().length > 4);
  return truncate((meaningful || ds[0]).replace(/\s+/g, ' ').trim(), 90);
}

// ---- 公開 API ----
export async function listLiveSessions() {
  const [agents, panes] = await Promise.all([listAgents(), listWeztermPanes()]);
  const live = agents.filter((a) => a.cwd !== DRAFT_CWD);
  // repo は cwd 単位でキャッシュ（初回のみ git・非同期・timeout 付き、以降は即時）。
  // branch は .git/HEAD を直読み（子プロセス不要）。PR ボードとの (repo, branch) 突合に使う。
  const repos = await Promise.all(live.map((a) => cwdRepo(a.cwd)));
  const mapped = live.map((a, i) => ({
    sessionId: a.sessionId,
    pid: a.pid,
    cwd: a.cwd,
    kind: a.kind,
    status: a.status,
    startedAt: a.startedAt,
    title: sessionTitle(a.sessionId),
    target: panes.length ? matchPane(a.pid, panes) : null,
    level: getLevel(a.sessionId),
    draftStatus: getDraftState(a.sessionId),
    summary: getSummary(a.sessionId), // Haiku 要約（あれば。無ければ UI は recent 生テキストにフォールバック）
    repoNameWithOwner: repos[i],      // PR 突合キー①: owner/repo
    branch: currentBranch(a.cwd),     // PR 突合キー②: 現在ブランチ（detached は null）
    ...recentActivity(a.cwd, a.sessionId),
  }));
  // 同一 sessionId（resume 等で別プロセスに重複）は target ありを優先して1つに集約
  const bySid = new Map();
  for (const s of mapped) {
    const ex = bySid.get(s.sessionId);
    if (!ex || (!ex.target && s.target)) bySid.set(s.sessionId, s);
  }
  const sessions = [...bySid.values()];
  sessions.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
  return { sessions, focusAvailable: panes.length > 0, staleMin: config.staleMin };
}

// 指定ペインを activate し、ターミナルを前面化する
export async function activatePane(paneId) {
  try {
    await execFileP(config.weztermBin, ['cli', 'activate-pane', '--pane-id', String(paneId)]);
    await execFileP('osascript', ['-e', `tell application "${config.terminalApp}" to activate`]).catch(() => {});
    return { ok: true, paneId };
  } catch (e) {
    return { error: `WezTerm 操作に失敗: ${e.message}`, code: 500 };
  }
}

// workspace 配下の git リポを remote から逆引き { owner/repo: ローカルパス }
// workspaceRoot 未設定なら空＝逆引き無効（PR↔セッション紐付けが効かないだけで他は動く）
let repoMap = null;
function buildRepoMap() {
  const map = {};
  if (!config.workspaceRoot) return map;
  try {
    for (const name of readdirSync(config.workspaceRoot)) {
      const dir = join(config.workspaceRoot, name);
      try {
        const url = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 3000 }).trim();
        const m = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
        if (m) map[m[1]] = dir;
      } catch { /* git でない or remote なし */ }
    }
  } catch { /* workspace なし */ }
  return map;
}
export function repoToPath(nameWithOwner) {
  if (!repoMap) repoMap = buildRepoMap();
  return repoMap[nameWithOwner] || null;
}

// セッションの現在ブランチを .git/HEAD から直読み（子プロセス不要・worktree 対応）。detached HEAD は null。
function currentBranch(cwd) {
  try {
    let gitDir = join(cwd, '.git');
    const st = statSync(gitDir);
    if (st.isFile()) { // worktree の ".git" は "gitdir: <path>" のテキストファイル
      const m = readFileSync(gitDir, 'utf8').match(/gitdir:\s*(.+)/);
      if (m) gitDir = m[1].trim();
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    const r = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return r ? r[1] : null;
  } catch { return null; }
}

// cwd → owner/repo。一度引いたらキャッシュ＝ポーリング毎に git を走らせない。
// 初回ミス時のみ git を非同期で呼び、1.5秒で打ち切る（1つ詰まっても他を巻き込まない）。
const repoOfCwd = new Map();
async function cwdRepo(cwd) {
  if (repoOfCwd.has(cwd)) return repoOfCwd.get(cwd);
  let repo = null;
  try {
    const { stdout } = await execFileP('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], { timeout: 1500 });
    const m = stdout.trim().match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    repo = m ? m[1] : null;
  } catch { repo = null; }
  repoOfCwd.set(cwd, repo);
  return repo;
}

// WezTerm に新しいタブで claude を起動する（prompt 指定で初手コマンドを実行）
export async function launchSession({ cwd, label, prompt }) {
  if (!cwd) return { error: 'cwd is required', code: 400 };
  try {
    // 既存ウィンドウに新規タブを spawn（GUI mux が必要）。prompt があれば claude の初手プロンプトに渡す。
    // --permission-mode で settings の auto（sandbox）を上書きし、Bash/git/gh が通る状態で起動する。
    const spawnArgs = ['cli', 'spawn', '--cwd', cwd, '--', config.claudeBin, '--permission-mode', config.permissionMode];
    if (prompt) spawnArgs.push(prompt);
    const { stdout } = await execFileP(config.weztermBin, spawnArgs, { timeout: 8000 });
    const paneId = stdout.trim();
    // タブ名をラベルに
    if (label) {
      await execFileP(config.weztermBin, ['cli', 'set-tab-title', '--pane-id', paneId, label]).catch(() => {});
    }
    await execFileP(config.weztermBin, ['cli', 'activate-pane', '--pane-id', paneId]).catch(() => {});
    await execFileP('osascript', ['-e', `tell application "${config.terminalApp}" to activate`]).catch(() => {});
    return { ok: true, paneId };
  } catch (e) {
    if (/command not found|ENOENT/.test(e.message)) {
      return { error: 'wezterm が見つかりません（brew install --cask wezterm）', code: 500 };
    }
    // mux 未起動などで spawn 失敗
    return { error: `起動に失敗しました（WezTerm を起動しておいてください）: ${e.message}`, code: 500 };
  }
}

// ───────────────────────────── Phase7: 人格ドラフト返答 ─────────────────────────────

// セッションごとの自動化レベル（1=承認制 / 2=一部自動 / 3=自動）。in-memory。
const levels = new Map();
export function getLevel(sessionId) { return levels.get(sessionId) || 1; }
export function setLevel(sessionId, level) { levels.set(sessionId, Number(level) || 1); }

// history.jsonl から全セッション横断でユーザーの発言を時系列に集め、直近 N 件返す（口調・判断傾向のサンプル）
// Session Monitor 経由で送信したテキスト（records.jsonl の sent）を集める。
// 人格サンプルから除外し、AI 由来の文が自分の文体として再学習されるのを防ぐ（自己汚染対策）。
function getSentTexts() {
  const set = new Set();
  try {
    for (const line of readFileSync(RECORDS_PATH, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (!o.sent) continue;
        // 'as_is' モードなら無編集承認のみ除外、'all' なら送信全部除外
        if (config.sentExcludeMode === 'as_is' && o.action !== 'as_is') continue;
        set.add(o.sent.trim());
      } catch { /* skip */ }
    }
  } catch { /* records なし */ }
  return set;
}

function recentUserPrompts(n = 60) {
  const sent = getSentTexts();
  const map = loadHistory();
  const all = [];
  for (const ds of map.values()) for (const d of ds) all.push(d);
  // /コマンド・極短の相槌・Monitor 経由の送信テキストを除外し、末尾 N 件
  return all.filter((d) => {
    const t = d.trim();
    return !t.startsWith('/') && t.length > 2 && !sent.has(t);
  }).slice(-n);
}

// daily/決定ログの直近抜粋（任意・personaDailyDir 未設定ならスキップ）
function dailyExcerpt(maxChars = 3000) {
  if (!config.personaDailyDir) return '';
  try {
    const dir = join(config.personaDailyDir, 'daily');
    const list = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    if (!list.length) return '';
    let out = '';
    for (const f of list.slice(-2)) { // 直近2日分
      try { out += `\n# ${f}\n${readFileSync(join(dir, f), 'utf8')}`; } catch { /* skip */ }
    }
    return out.slice(-maxChars);
  } catch {
    return '';
  }
}

// 対象セッションの transcript 末尾から直近のやり取りを整形（何を聞かれている/どこで止まっているか）
function transcriptTail(cwd, sessionId, maxChars = 4000) {
  const file = transcriptPath(cwd, sessionId);
  let fd;
  try {
    fd = openSync(file, 'r');
    const { size } = fstatSync(fd);
    const readLen = Math.min(size, 96 * 1024);
    const buf = Buffer.alloc(readLen);
    readSync(fd, buf, 0, readLen, size - readLen);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    const turns = [];
    for (const line of lines) {
      try {
        const o = JSON.parse(line);
        const t = extractText(o);
        if (t && (o.type === 'user' || o.type === 'assistant')) {
          turns.push(`${o.type === 'user' ? 'User' : 'Claude'}: ${t}`);
        }
      } catch { /* skip */ }
    }
    return turns.slice(-12).join('\n').slice(-maxChars);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ユーザー人格で「次の返答」のドラフトを生成する（内部関数。startDraft から呼ぶ）
async function generateDraftInternal(sessionId, cwd) {
  const sample = recentUserPrompts(60).map((d) => `- ${d}`).join('\n');
  const daily = dailyExcerpt();
  const context = transcriptTail(cwd, sessionId);
  if (!context) return { error: 'セッションの文脈を読めませんでした', code: 404 };
  const persona = getCurrentPersona();

  const prompt = [
    'あなたは下記ユーザー本人になりきり、進行中の Claude Code セッションに返す「次の返答」を1つだけ書きます。',
    '',
    '# ユーザーの過去の指示サンプル（口調・判断傾向。これを強く踏襲）',
    sample || '(なし)',
    daily ? '\n# ユーザーの業務メモ（判断の背景。参考程度）\n' + daily : '',
    persona.text ? '\n# 学習した編集傾向（過去の修正から。最優先で従う）\n' + persona.text : '',
    '',
    '# 進行中セッションの直近のやり取り',
    context,
    '',
    '# 指示',
    '- 上のやり取りを踏まえ、このユーザーが次に打つであろう返答を1つ書く',
    '- ユーザーの口調・判断基準を踏襲し、普段の指示と同程度の簡潔さで',
    '- 返答テキストのみを出力（前置き・説明・引用符は不要）',
  ].join('\n');

  // --no-session-persistence: 生成用の使い捨て実行をディスクに残さない
  //   → ダッシュボードに別カードとして出ない・history を汚さない
  const args = ['-p', prompt, '--no-session-persistence'];
  if (config.draftModel) args.push('--model', config.draftModel);
  try {
    const { stdout } = await execFileP(config.claudeBin, args, { timeout: 90000, maxBuffer: 4 * 1024 * 1024, cwd: DRAFT_CWD });
    const text = stdout.trim();
    if (!text) return { error: 'ドラフトが空でした', code: 500 };
    return { ok: true, draft: text, context, personaVersion: persona.version };
  } catch (e) {
    return { error: `ドラフト生成に失敗: ${e.message}`, code: 500 };
  }
}

// WezTerm ペインに返答を投入する（末尾に改行を付けて送信＝Enter 相当）
export async function sendText(paneId, text) {
  try {
    // テキストを入力欄に投入するだけ（Enter は付けない）。最終確認＝Enter は人間が飛んだ先で押す。
    await execFileP(config.weztermBin, ['cli', 'send-text', '--pane-id', String(paneId), '--no-paste', text]);
    return { ok: true };
  } catch (e) {
    return { error: `送信に失敗: ${e.message}`, code: 500 };
  }
}

// Finder のフォルダ選択ダイアログを開いてパスを返す（macOS）
export async function chooseDir() {
  try {
    const { stdout } = await execFileP('osascript', ['-e', 'POSIX path of (choose folder with prompt "セッションを起動するフォルダを選択")'], { timeout: 120000 });
    return { path: stdout.trim() };
  } catch {
    return { path: '' }; // キャンセル等
  }
}

// Finder の画像選択ダイアログ（複数可）を開いて絶対パスの配列を返す（macOS）。
// claude は Read で画像を開けるため、選んだパスを送信テキストに埋め込めば内容を参照できる。
export async function chooseImage() {
  const script = [
    'set theFiles to choose file with prompt "claude に渡す画像を選択" of type {"public.image"} with multiple selections allowed',
    'set out to ""',
    'repeat with f in theFiles',
    'set out to out & POSIX path of f & linefeed',
    'end repeat',
    'return out',
  ].join('\n');
  try {
    const { stdout } = await execFileP('osascript', ['-e', script], { timeout: 120000 });
    return { paths: stdout.split('\n').map((s) => s.trim()).filter(Boolean) };
  } catch {
    return { paths: [] }; // キャンセル等
  }
}

// WezTerm 以外で起動したセッションは claude プロセスを直接終了（ターミナルは残る）
export function killPid(pid) {
  try { process.kill(Number(pid), 'SIGTERM'); return { ok: true }; }
  catch (e) { return { error: `プロセス終了に失敗: ${e.message}`, code: 500 }; }
}

// セッション（WezTerm ペイン）を閉じる
export async function closeSession(paneId) {
  try {
    await execFileP(config.weztermBin, ['cli', 'kill-pane', '--pane-id', String(paneId)]);
    return { ok: true };
  } catch (e) {
    return { error: `閉じるのに失敗: ${e.message}`, code: 500 };
  }
}

// ───────── フィードバック収集 & persona（Phase8 Step1）─────────
export const PERSONA_DIR = join(homedir(), '.claude-orchestrator', 'persona');
export const RECORDS_PATH = join(homedir(), '.claude-orchestrator', 'records.jsonl');

// 現在適用中の persona（無ければ空・version 0）
export function getCurrentPersona() {
  try {
    const ver = readFileSync(join(PERSONA_DIR, 'current'), 'utf8').trim();
    return { version: Number(ver) || 0, text: readFileSync(join(PERSONA_DIR, `v${ver}.md`), 'utf8').trim() };
  } catch {
    return { version: 0, text: '' };
  }
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}
function diffRatio(a, b) {
  a = a || ''; b = b || '';
  const max = Math.max(a.length, b.length);
  return max ? Number((levenshtein(a, b) / max).toFixed(3)) : 0;
}

// 送信/却下のたびにペアを記録（learned=false で蓄積。Step2 の再学習で使う）
export function recordFeedback({ sessionId, cwd, context, draft, sent, action, personaVersion }) {
  const rec = {
    ts: new Date().toISOString(),
    sessionId, cwd: cwd || '',
    context: context || '',
    draft: draft || '',
    sent: action === 'rejected' ? null : (sent || ''),
    action,
    diff_ratio: action === 'rejected' ? null : diffRatio(draft, sent),
    persona_version: personaVersion ?? 0,
    learned: false,
  };
  try {
    mkdirSync(dirname(RECORDS_PATH), { recursive: true });
    appendFileSync(RECORDS_PATH, JSON.stringify(rec) + '\n');
  } catch { /* noop */ }
}

// ───────── ドラフトのキャッシュと非同期生成 ─────────
// status: none / generating / ready / error
const draftCache = new Map(); // sessionId -> { status, draft, context, error, ts }

export function getDraftState(sessionId) {
  return (draftCache.get(sessionId) || {}).status || 'none';
}
export function getDraft(sessionId) {
  return draftCache.get(sessionId) || { status: 'none' };
}
// 送信/却下でそのドラフトは消費済み → キャッシュを消して状態を none に戻す
export function clearDraft(sessionId) {
  draftCache.delete(sessionId);
}
// 直近のやり取りだけ即取得（claude 不要・高速。モーダルで未生成時に使う）
export function getContext(sessionId, cwd) {
  return transcriptTail(cwd, sessionId);
}
// 非同期でドラフト生成を開始し、即戻る。完成したらキャッシュに入る。
export function startDraft(sessionId, cwd) {
  const cur = draftCache.get(sessionId);
  if (cur && cur.status === 'generating') return; // 二重起動防止
  draftCache.set(sessionId, { status: 'generating', ts: Date.now() });
  generateDraftInternal(sessionId, cwd)
    .then((r) => {
      if (r.error) draftCache.set(sessionId, { status: 'error', error: r.error, ts: Date.now() });
      else draftCache.set(sessionId, { status: 'ready', draft: r.draft, context: r.context, personaVersion: r.personaVersion, ts: Date.now() });
    })
    .catch((e) => draftCache.set(sessionId, { status: 'error', error: String(e), ts: Date.now() }));
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}
