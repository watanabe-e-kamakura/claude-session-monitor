// HTTP サーバ: Live セッション監視に特化。REST + SSE + 静的配信。依存は Node 標準のみ。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { config } from './config.js';
import { listLiveSessions, activatePane, launchSession, startDraft, getDraft, getContext, sendText, setLevel, closeSession, setCustomTitle, recordFeedback, clearDraft, chooseDir, chooseImage, refreshSummaries, killPid } from './live.js';
import { tick as learnTick, getLearnStatus, setCurrentVersion } from './learn.js';
import { refreshPRs, getPRsData } from './prs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = url;

    if (req.method === 'GET' && pathname === '/api/stream') return handleStream(req, res);
    if (req.method === 'GET' && pathname === '/api/live') return json(res, lastLive);
    if (req.method === 'GET' && pathname === '/api/presets') return json(res, { presets: config.presets, defaultCwd: config.defaultCwd });
    if (req.method === 'GET' && pathname === '/api/prs') return json(res, getPRsData());
    if (req.method === 'GET' && pathname === '/api/health') return json(res, health);
    if (req.method === 'GET' && pathname === '/api/learn/status') return json(res, getLearnStatus());
    if (req.method === 'POST' && pathname === '/api/learn/rollback') {
      const body = await readBody(req);
      const r = setCurrentVersion(body.version);
      if (r.error) return json(res, { error: r.error }, r.code || 400);
      return json(res, r);
    }

    const liveFocus = pathname.match(/^\/api\/live\/([\w-]+)\/focus$/);
    if (req.method === 'POST' && liveFocus) {
      const sid = liveFocus[1];
      const s = lastLive.sessions.find((x) => x.sessionId === sid);
      if (!s) return json(res, { error: 'session not found（一覧を更新してください）' }, 404);
      if (!s.target) return json(res, { error: 'WezTerm ペインが見つかりません（WezTerm 上で起動されていない可能性）' }, 409);
      const result = await activatePane(s.target.paneId);
      if (result.error) return json(res, { error: result.error }, result.code || 400);
      return json(res, result);
    }

    // Phase7: ドラフト生成を非同期で開始（即戻る。完成はキャッシュに入る）
    const liveDraft = pathname.match(/^\/api\/live\/([\w-]+)\/draft$/);
    if (req.method === 'POST' && liveDraft) {
      const s = lastLive.sessions.find((x) => x.sessionId === liveDraft[1]);
      if (!s) return json(res, { error: 'session not found' }, 404);
      startDraft(s.sessionId, s.cwd);
      return json(res, { ok: true, status: 'generating' });
    }

    // Phase7: ドラフトのキャッシュ取得（モーダル用。生成済みなら即返る）
    if (req.method === 'GET' && liveDraft) {
      return json(res, getDraft(liveDraft[1]));
    }

    // Phase7: 直近のやり取りだけ即取得（claude 不要・高速）
    const liveContext = pathname.match(/^\/api\/live\/([\w-]+)\/context$/);
    if (req.method === 'GET' && liveContext) {
      const s = lastLive.sessions.find((x) => x.sessionId === liveContext[1]);
      if (!s) return json(res, { error: 'session not found' }, 404);
      return json(res, { context: getContext(s.sessionId, s.cwd) });
    }

    // Phase7: 承認した返答をペインに送信
    const liveSend = pathname.match(/^\/api\/live\/([\w-]+)\/send$/);
    if (req.method === 'POST' && liveSend) {
      const body = await readBody(req);
      if (!body.text || !body.text.trim()) return json(res, { error: 'text is required' }, 400);
      const s = lastLive.sessions.find((x) => x.sessionId === liveSend[1]);
      if (!s) return json(res, { error: 'session not found' }, 404);
      if (!s.target) return json(res, { error: 'WezTerm ペインが見つかりません（送信不可）' }, 409);
      const result = await sendText(s.target.paneId, body.text);
      if (result.error) return json(res, { error: result.error }, result.code || 400);
      // Phase8: ドラフトと最終送信のペアを記録（学習データ）
      const cache = getDraft(s.sessionId);
      recordFeedback({
        sessionId: s.sessionId, cwd: s.cwd, context: cache.context, draft: cache.draft,
        sent: body.text, action: cache.draft === body.text ? 'as_is' : 'edited', personaVersion: cache.personaVersion,
      });
      clearDraft(s.sessionId); // 消費済み → カードのラベルを none に戻す
      await activatePane(s.target.paneId); // 送信後そのペインに飛ぶ（Enter は人間が押す）
      pollLive();
      return json(res, result);
    }

    // Phase8: ドラフト却下を負例として記録
    const liveReject = pathname.match(/^\/api\/live\/([\w-]+)\/draft-reject$/);
    if (req.method === 'POST' && liveReject) {
      const s = lastLive.sessions.find((x) => x.sessionId === liveReject[1]);
      const cache = getDraft(liveReject[1]);
      if (s && cache.draft) {
        recordFeedback({
          sessionId: s.sessionId, cwd: s.cwd, context: cache.context, draft: cache.draft,
          sent: null, action: 'rejected', personaVersion: cache.personaVersion,
        });
      }
      clearDraft(liveReject[1]); // 却下＝破棄 → ラベルを none に戻す
      pollLive();
      return json(res, { ok: true });
    }

    // Phase7: セッション（WezTerm ペイン）を閉じる
    const liveClose = pathname.match(/^\/api\/live\/([\w-]+)\/close$/);
    if (req.method === 'POST' && liveClose) {
      const s = lastLive.sessions.find((x) => x.sessionId === liveClose[1]);
      if (!s) return json(res, { error: 'session not found' }, 404);
      // WezTerm 起動分はペインごと、それ以外は claude プロセスを終了
      const r = s.target ? await closeSession(s.target.paneId) : killPid(s.pid);
      if (r.error) return json(res, { error: r.error }, r.code || 400);
      pollLive();
      return json(res, r);
    }

    // Phase7: セッションのカスタムタイトル設定
    const liveTitle = pathname.match(/^\/api\/live\/([\w-]+)\/title$/);
    if (req.method === 'POST' && liveTitle) {
      const body = await readBody(req);
      setCustomTitle(liveTitle[1], body.title || '');
      pollLive();
      return json(res, { ok: true });
    }

    // Phase7: セッションの自動化レベル設定
    const liveLevel = pathname.match(/^\/api\/live\/([\w-]+)\/level$/);
    if (req.method === 'POST' && liveLevel) {
      const body = await readBody(req);
      setLevel(liveLevel[1], body.level);
      return json(res, { ok: true, level: Number(body.level) || 1 });
    }

    if (req.method === 'POST' && pathname === '/api/choose-dir') {
      return json(res, await chooseDir());
    }

    // 画像選択（Finder・複数可）。返ってきた絶対パスを送信テキストに埋め込んで claude に渡す。
    if (req.method === 'POST' && pathname === '/api/choose-image') {
      return json(res, await chooseImage());
    }

    // PR レビュー起動: defaultCwd（窓口）で起動し、config.reviewPrompt テンプレートを初手に渡す。
    // ワークフロー（/engineer 等のプラグイン連携）はテンプレート側で差し替え可能。
    if (req.method === 'POST' && pathname === '/api/launch-review') {
      const body = await readBody(req);
      const prompt = config.reviewPrompt
        .replaceAll('{number}', String(body.number ?? ''))
        .replaceAll('{url}', String(body.url ?? ''))
        .replaceAll('{repo}', String(body.repo ?? ''))
        .replaceAll('{branch}', String(body.headRefName ?? ''));
      const result = await launchSession({ cwd: config.defaultCwd, label: `review-${body.number}`, prompt });
      if (result.error) return json(res, { error: result.error }, result.code || 400);
      return json(res, result);
    }

    if (req.method === 'POST' && pathname === '/api/launch') {
      const body = await readBody(req);
      const result = await launchSession({ cwd: body.cwd, label: body.label });
      if (result.error) return json(res, { error: result.error }, result.code || 400);
      pollLive(); // 起動直後に一覧を更新
      return json(res, result);
    }

    if (req.method === 'GET') return serveStatic(pathname, res);
    json(res, { error: 'not found' }, 404);
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
});

// ---- SSE ----
const sseClients = new Set();
function handleStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  send(res, 'live', lastLive); // 接続直後に現在値
  sseClients.add(res);

  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
}

function send(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ---- Live ポーリング ----
let lastLive = { sessions: [], tmuxAvailable: false };
let polling = false;
async function pollLive() {
  if (polling) return;
  polling = true;
  try {
    lastLive = await listLiveSessions();
    refreshSummaries(lastLive.sessions); // 更新があったセッションの要約を非同期更新（待たない）
    for (const res of sseClients) send(res, 'live', lastLive);
  } catch { /* 一時的失敗は無視 */ } finally {
    polling = false;
  }
}

// ---- helpers ----
function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1_000_000) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return json(res, { error: 'forbidden' }, 403);
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate', // 古い UI のキャッシュ事故を防ぐ
    });
    res.end(data);
  } catch {
    json(res, { error: 'not found' }, 404);
  }
}

// ---- doctor: 依存コマンドの存在チェック（欠けると無言で機能が死ぬのを防ぐ）----
import { execFile as execFileCb } from 'node:child_process';
import { promisify as promisifyUtil } from 'node:util';
const execFileD = promisifyUtil(execFileCb);
let health = { ok: true, checks: {}, configPath: config.configPath };
async function runDoctor() {
  const find = async (bin) => { try { await execFileD('/usr/bin/which', [bin]); return true; } catch { return false; } };
  health.checks = {
    claude: await find(config.claudeBin),    // 必須: セッション一覧・ドラフト生成
    wezterm: await find(config.weztermBin),  // 任意: 飛ぶ・新規起動・送信
    gh: await find('gh'),                    // 任意: PR ボード
  };
  health.ok = health.checks.claude; // claude が無ければ本体が成立しない
  for (const [k, v] of Object.entries(health.checks)) {
    if (!v) console.warn(`  [doctor] ${k} が見つかりません（PATH を確認。launchd の場合 plist の PATH に追加）`);
  }
}

server.listen(config.port, config.host, () => {
  console.log(`Claude Session Monitor`);
  console.log(`  dashboard  : http://${config.host}:${config.port}`);
  console.log(`  poll       : ${config.livePollMs}ms`);
  console.log(`  terminal   : ${config.terminalApp}`);
  console.log(`  config     : ${config.configPath}`);
  runDoctor();
  pollLive();
  setInterval(pollLive, config.livePollMs).unref();
  setInterval(() => { learnTick(); }, config.learnTickMs).unref(); // Phase8: 自己進化ジョブ
  refreshPRs(); // PR ボード初回取得
  setInterval(() => { refreshPRs(); }, 60000).unref(); // PR は1分間隔
});
