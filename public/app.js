// Claude Session Monitor — 進捗管理特化。依存なしの素の JS。
const $ = (id) => document.getElementById(id);
let modalOpen = false; // モーダルを開いている間は再描画を止める
let lastLiveData = null; // 再描画を止めている間に届いた最新データ（閉じたら反映）
let staleMs = 30 * 60 * 1000; // idle 放置とみなす閾値（サーバ設定で上書き）
let activeTab = 'session'; // 'session' | 'pr'
let prData = null;
// グループ軸はタブごとに独立（セッションは状態で、PR はリポで見たい、が両立できる）
const groupBy = {
  session: localStorage.getItem('orch-group-session') || 'status',
  pr: localStorage.getItem('orch-group-pr') || 'status',
};
const collapsed = new Set(JSON.parse(localStorage.getItem('orch-collapsed') || '[]')); // 折りたたみ中のグループ key

// グループ見出し＋カード群を描画する共通ヘルパー（折りたたみ対応）
function appendGroup(cards, key, label, items, makeFn) {
  if (!items.length) return;
  const isCol = collapsed.has(key);
  const head = document.createElement('div');
  head.className = 'group-head' + (isCol ? ' collapsed' : '');
  head.textContent = `${isCol ? '▶' : '▼'} ${label} (${items.length})`;
  head.onclick = () => {
    if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
    localStorage.setItem('orch-collapsed', JSON.stringify([...collapsed]));
    rerender();
  };
  cards.appendChild(head);
  if (!isCol) for (const it of items) cards.appendChild(makeFn(it));
}

// 現在のタブを再描画（折りたたみトグル・グループ軸切替時）
function rerender() {
  if (activeTab === 'session') { if (lastLiveData) render(lastLiveData); }
  else renderPRs(prData);
}

// ---- プリセット（新規セッション起動ボタン）----
async function loadPresets() {
  const data = await fetch('/api/presets').then((r) => r.json());
  const presets = data.presets || [];
  const el = $('presets');
  el.innerHTML = '';
  presets.forEach((p) => {
    const btn = document.createElement('button');
    btn.className = 'preset';
    btn.textContent = p.label;
    btn.title = `クリックでパス入力欄にセット: ${p.cwd}`;
    btn.onclick = () => { $('custom-cwd').value = p.cwd; $('custom-cwd').focus(); }; // 起動でなく入力欄にセット
    el.appendChild(btn);
  });
  // 任意パス入力の初期値＝デフォルトディレクトリ
  if (data.defaultCwd && !$('custom-cwd').value) $('custom-cwd').value = data.defaultCwd;
}

// Finder でフォルダを選択して入力欄に
async function chooseDir() {
  const r = await fetch('/api/choose-dir', { method: 'POST' }).then((x) => x.json()).catch(() => ({ path: '' }));
  if (r.path) $('custom-cwd').value = r.path;
}

// 任意パスで新規セッションを起動
function launchCustom() {
  const cwd = $('custom-cwd').value.trim();
  if (!cwd) { $('custom-cwd').focus(); return; }
  const label = cwd.split('/').filter(Boolean).slice(-1)[0] || cwd;
  launch({ cwd, label }, $('custom-launch'));
}

async function launch(preset, btn) {
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '起動中…';
  try {
    const res = await fetch('/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: preset.cwd, label: preset.label }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || '起動に失敗'); return; }
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

// ---- SSE ----
function connectStream() {
  const es = new EventSource('/api/stream');
  es.onopen = () => { $('conn').textContent = '● connected'; $('conn').style.color = '#4caf50'; };
  es.onerror = () => { $('conn').textContent = '● reconnecting…'; $('conn').style.color = '#e25c5c'; };
  es.addEventListener('live', (e) => render(JSON.parse(e.data)));
}

// ---- カード描画 ----
function render(data) {
  if (modalOpen) { lastLiveData = data; return; } // モーダル確認中は再描画しない
  if (data.staleMin) staleMs = data.staleMin * 60000;
  const cards = $('cards');
  // 要対応（waiting）を最優先、次に working、idle は最後。同順は最終活動が新しい順
  const rank = (s) => { const k = norm(s.status); return k === 'waiting' ? 0 : k === 'working' ? 1 : 2; };
  const sessions = (data.sessions || []).slice().sort((a, b) => rank(a) - rank(b) || (b.updatedAt || 0) - (a.updatedAt || 0));

  const counts = sessions.reduce((a, s) => { const k = norm(s.status); a[k] = (a[k] || 0) + 1; return a; }, {});
  $('stat').textContent = `${sessions.length} セッション · 稼働 ${counts.working || 0} / 待機 ${counts.idle || 0}` +
    (counts.waiting ? ` / 🔴許可待ち ${counts.waiting}` : '');
  $('tmux-hint').textContent = data.focusAvailable ? 'WezTerm: 検出（飛べます）' : 'WezTerm: 未検出（飛ぶ無効）';

  // 要対応をタブタイトルに出し、新規発生はデスクトップ通知
  const waiting = sessions.filter((s) => norm(s.status) === 'waiting');
  document.title = waiting.length ? `⚠️${waiting.length} 要対応 — Claude Monitor` : 'Claude Session Monitor';
  notifyNewWaiting(waiting);

  if (activeTab !== 'session') { lastLiveData = data; return; } // PR タブ表示中はセッションボードを描かない
  if (!sessions.length) { cards.innerHTML = '<div class="empty">稼働中の claude セッションはありません</div>'; return; }

  cards.innerHTML = '';
  if (groupBy.session === 'repo') {
    // リポ別グループ。各リポ内は 要対応→稼働→idle の順（rank ソート済みの sessions を維持）
    const byRepo = {};
    for (const s of sessions) (byRepo[repoName(s.cwd)] ||= []).push(s);
    for (const repo of Object.keys(byRepo).sort()) {
      appendGroup(cards, 'sess-repo:' + repo, `📁 ${repo}`, byRepo[repo], makeCard);
    }
  } else {
    // 状態別グループ: 要対応 → あなたの番 → 稼働中 → その他（各グループ内は最終活動順）
    const groups = [
      { label: '🔴 要対応（許可・入力待ち）', match: 'waiting' },
      { label: '⚪ あなたの番（応答完了・待機中）', match: 'idle' },
      { label: '🟢 稼働中（Claude 作業中）', match: 'working' },
      { label: 'その他', match: 'unknown' },
    ];
    for (const g of groups) {
      const items = sessions.filter((s) => norm(s.status) === g.match)
        .sort((a, b) => g.match === 'idle'
          ? (a.updatedAt || 0) - (b.updatedAt || 0)   // idle は古い順（放置を上に）
          : (b.updatedAt || 0) - (a.updatedAt || 0)); // 他は新しい順
      appendGroup(cards, 'sess-st:' + g.match, g.label, items, makeCard);
    }
  }
}

// 1セッションのカード要素を作る
function makeCard(s) {
  const st = norm(s.status);
  const stale = st === 'idle' && s.updatedAt && (Date.now() - s.updatedAt) > staleMs;
  const card = document.createElement('div');
  card.className = 'card' + (st === 'waiting' ? ' waiting' : '') + (stale ? ' stale' : '');
  card.innerHTML = `
      <div class="top">
        <span class="status-pill ${st}"><span class="dot"></span>${escapeHtml(s.status || '?')}</span>
        <span class="repo">${escapeHtml(repoName(s.cwd))}</span>
        <span class="kind">${escapeHtml(s.kind || '?')}</span>
        <button class="kill" title="セッションを終了"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>
      </div>
      <div class="title">${s.title ? escapeHtml(s.title) : '<span style="color:var(--muted);font-weight:400">(無題セッション)</span>'}</div>
      <div class="recent">${(s.summary || s.text) ? escapeHtml(s.summary || s.text) : '<span style="color:var(--muted)">（直近の出力なし）</span>'}</div>
      <div class="meta">
        <span>起動 <b>${ago(s.startedAt)}</b></span>
        <span>最終活動 <b>${ago(s.updatedAt)}</b></span>
        ${stale ? '<span class="stale-badge">⏰ 放置中</span>' : ''}
        ${s.target ? `<span class="tmux-tag">${escapeHtml(s.target.title || s.target.target)}</span>` : ''}
      </div>
      ${s.target ? `<div class="draftrow">${draftControl(s.draftStatus)}</div>` : ''}
      <div class="footer">
        <span class="sid" title="${escapeHtml(s.cwd)}">${s.sessionId.slice(0, 8)}… · pid ${s.pid}</span>
        ${s.target ? `<select class="level" title="自動化レベル">
          <option value="1"${s.level === 1 ? ' selected' : ''}>L1 承認制</option>
          <option value="2"${s.level === 2 ? ' selected' : ''}>L2 一部自動</option>
          <option value="3"${s.level === 3 ? ' selected' : ''}>L3 自動</option>
        </select>` : ''}
        <button class="jump" ${s.target ? '' : 'disabled title="WezTerm 上で起動されていません"'}>↗ 飛ぶ</button>
      </div>`;
    // カード本体クリックでモーダル（直近のやり取り＋ドラフトを確認して承認）
    card.onclick = () => openModal(s);
    // バケツ（終了）は全セッション共通
    const kbtn = card.querySelector('.kill');
    if (kbtn) kbtn.onclick = (e) => { e.stopPropagation(); killSession(s.sessionId); };
    const btn = card.querySelector('.jump');
    if (s.target) {
      btn.onclick = (e) => { e.stopPropagation(); jumpTo(s.sessionId, btn); };
      const lv = card.querySelector('.level');
      lv.onclick = (e) => e.stopPropagation();
      lv.onchange = (e) => { e.stopPropagation(); setLevel(s.sessionId, e.target.value); };
      const dbtn = card.querySelector('.dgen');
      if (dbtn) dbtn.onclick = (e) => { e.stopPropagation(); genDraft(s.sessionId); };
    } else {
      btn.onclick = (e) => e.stopPropagation();
    }
  return card;
}

// カード上のドラフト状態表示（生成ボタン / 生成中 / 準備完了）
function draftControl(status) {
  if (status === 'generating') return '<span class="dstate gen">⏳ 生成中</span>';
  if (status === 'ready') return '<span class="dstate ready">✓ ドラフト準備完了</span>';
  if (status === 'error') return '<button class="ghost dgen">⚠ 再生成</button>';
  return '<button class="ghost dgen">✍️ ドラフト生成</button>';
}

// ドラフト生成を非同期で開始（カードのボタン）
async function genDraft(sessionId) {
  await fetch(`/api/live/${sessionId}/draft`, { method: 'POST' });
  // 状態は次のポーリング(SSE live)で generating→ready に更新される
}

// セッション（WezTerm ペイン）を閉じる（カードのバケツ）
async function killSession(sessionId) {
  if (!confirm('このセッションを終了しますか？\n（WezTerm 起動分はペインごと、それ以外は claude プロセスを終了。ターミナル自体は残ります）')) return;
  const r = await fetch(`/api/live/${sessionId}/close`, { method: 'POST' });
  if (!r.ok) alert((await r.json()).error || '終了に失敗');
}

async function setLevel(sessionId, level) {
  await fetch(`/api/live/${sessionId}/level`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level: Number(level) }),
  });
}

// モーダルのタイトル（リポ名 — タイトル）。タイトル部分はクリックで編集
function setupTitle(s) {
  const el = $('m-title');
  const title = s.title || '(無題セッション)';
  el.innerHTML = `<span class="m-repo">${escapeHtml(repoName(s.cwd))} — </span><span class="m-name" title="クリックで編集">${escapeHtml(title)}</span>`;
  el.querySelector('.m-name').onclick = () => editTitle(s, el);
}

function editTitle(s, el) {
  const nameEl = el.querySelector('.m-name');
  if (!nameEl) return;
  const cur = (s.title && s.title !== '(無題セッション)') ? s.title : '';
  const input = document.createElement('input');
  input.className = 'title-edit';
  input.value = cur;
  input.placeholder = 'セッション名を入力';
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    if (save) {
      const v = input.value.trim();
      await fetch(`/api/live/${s.sessionId}/title`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: v }),
      });
      s.title = v || '(無題セッション)';
    }
    setupTitle(s); // span 表示に戻す
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { finish(false); }
  };
  input.onblur = () => finish(true);
}

// カードクリック → モーダルを開き、直近のやり取り＋人格ドラフトを表示して承認する
function closeModal() {
  modalOpen = false;
  $('modal').style.display = 'none';
  $('m-draft').innerHTML = '';   // 入力欄・値を完全リセット（次回開いたとき残らない）
  $('m-context').innerHTML = '';
  if (lastLiveData) render(lastLiveData); // 止めている間の更新を反映
}

async function openModal(s) {
  modalOpen = true;
  $('modal').style.display = 'flex';
  setupTitle(s);
  $('m-context').innerHTML = '<span class="m-muted">直近のやり取りを読み込み中…</span>';
  $('m-draft').innerHTML = '';

  // ドラフトのキャッシュを取得（生成済みなら context もここに入っている）
  let cache = { status: 'none' };
  try { cache = await fetch(`/api/live/${s.sessionId}/draft`).then((r) => r.json()); } catch { /* noop */ }

  // context: キャッシュにあれば即、無ければ軽量エンドポイントから
  if (cache.context) {
    $('m-context').textContent = cache.context;
  } else {
    try {
      const c = await fetch(`/api/live/${s.sessionId}/context`).then((r) => r.json());
      $('m-context').textContent = c.context || '(直近のやり取りなし)';
    } catch { $('m-context').innerHTML = '<span class="err">読み込み失敗</span>'; }
  }

  renderDraftArea(s, cache);
}

// モーダル下部のドラフト領域。常に入力欄を表示し、手動入力 or ドラフト生成で埋める
function renderDraftArea(s, cache) {
  const el = $('m-draft');
  if (!s.target) {
    el.innerHTML = '<span class="m-muted">このセッションは WezTerm 外のため送信できません（内容の確認のみ）</span>';
    return;
  }
  el.innerHTML = `
    <textarea class="draft-text" id="m-text" placeholder="返答を入力、または「ドラフト生成」で下書きを作成…"></textarea>
    <div class="draft-actions">
      <button class="send" id="m-send">↵ 承認して送信</button>
      <button class="ghost" id="m-gen">✍️ ドラフト生成</button>
      <button class="ghost" id="m-img">📷 画像添付</button>
      <button class="ghost" id="m-clear">クリア</button>
    </div>
    <div id="m-genstate" class="m-muted" style="margin-top:6px;"></div>`;
  const ta = $('m-text');
  if (cache.status === 'ready') ta.value = cache.draft || '';
  else if (cache.status === 'generating') pollGen(s);

  $('m-gen').onclick = () => genIntoModal(s);
  $('m-img').onclick = () => attachImage(ta);
  $('m-clear').onclick = () => { ta.value = ''; ta.focus(); };
  $('m-send').onclick = async () => {
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    const b = $('m-send'); b.disabled = true; b.textContent = '送信中…';
    const r = await fetch(`/api/live/${s.sessionId}/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) { alert((await r.json()).error || '送信に失敗'); b.disabled = false; b.textContent = '↵ 承認して送信'; return; }
    closeModal(); // 送信後は完全リセットして閉じる
  };
}

// 「📷 画像添付」ボタン: Finder で画像を選び、絶対パスを返答テキストに埋め込む。
// claude は Read で画像を開けるので、パスを文中に入れておけば内容を参照して作業できる。
async function attachImage(ta) {
  const btn = $('m-img'); if (btn) { btn.disabled = true; btn.textContent = '選択中…'; }
  try {
    const r = await fetch('/api/choose-image', { method: 'POST' }).then((x) => x.json()).catch(() => ({ paths: [] }));
    if (r.paths && r.paths.length) {
      // 「次の画像を確認してください: <パス>」の形で、初回だけ案内文を付ける
      const intro = ta.value.includes('次の画像を確認') ? '' : '次の画像を確認してください:\n';
      const lines = r.paths.join('\n');
      ta.value = (ta.value ? ta.value.replace(/\s*$/, '') + '\n' : '') + intro + lines + '\n';
      ta.focus();
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📷 画像添付'; }
  }
}

// 「ドラフト生成」ボタン: 生成を開始し、完成したら textarea に埋め込む
async function genIntoModal(s) {
  const gs = $('m-genstate'); if (gs) gs.textContent = 'ドラフト生成中…（10秒前後）';
  await fetch(`/api/live/${s.sessionId}/draft`, { method: 'POST' }).catch(() => {});
  pollGen(s);
}
async function pollGen(s) {
  if (!modalOpen) return;
  const cache = await fetch(`/api/live/${s.sessionId}/draft`).then((r) => r.json()).catch(() => ({ status: 'error' }));
  const ta = $('m-text'); const gs = $('m-genstate');
  if (!ta || !gs) return;
  if (cache.status === 'ready') { ta.value = cache.draft || ''; gs.textContent = ''; }
  else if (cache.status === 'generating') { gs.textContent = 'ドラフト生成中…（10秒前後）'; setTimeout(() => pollGen(s), 1500); }
  else if (cache.status === 'error') { gs.innerHTML = '<span style="color:var(--waiting)">生成エラー</span>'; }
  else { gs.textContent = ''; }
}

async function jumpTo(sessionId, btn) {
  btn.disabled = true;
  try {
    const res = await fetch(`/api/live/${sessionId}/focus`, { method: 'POST' });
    if (!res.ok) alert((await res.json()).error || '飛べませんでした');
  } finally {
    btn.disabled = false;
  }
}

// ---- utils ----
function norm(status) {
  if (status === 'busy' || status === 'working') return 'working';
  if (status === 'idle') return 'idle';
  if (status === 'waiting') return 'waiting';
  return 'unknown';
}
function repoName(cwd) {
  if (!cwd) return '(unknown)';
  return cwd.split('/').filter(Boolean).slice(-1)[0] || cwd;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function ago(ms) {
  if (!ms) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分前`;
  return `${Math.floor(sec / 3600)}時間前`;
}

// 新たに waiting になったセッションだけデスクトップ通知する
let prevWaiting = new Set();
function notifyNewWaiting(waiting) {
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    for (const s of waiting) {
      if (!prevWaiting.has(s.sessionId)) {
        new Notification(`⚠️ 対応待ち: ${repoName(s.cwd)}`, {
          body: (s.title || '') + (s.text ? `\n${s.text}` : ''),
          tag: s.sessionId,
        });
      }
    }
  }
  prevWaiting = new Set(waiting.map((s) => s.sessionId));
}

// モーダルを閉じる: ✕ ボタン / 背景クリック / Esc
$('m-close').onclick = closeModal;
$('modal').onclick = closeModal; // 背景（オーバーレイ）クリック。中身は stopPropagation 済み
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalOpen) closeModal(); });

// 初回にデスクトップ通知の許可を求める
if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
  Notification.requestPermission();
}

$('custom-launch').onclick = launchCustom;
$('choose-dir').onclick = chooseDir;
$('custom-cwd').onkeydown = (e) => { if (e.key === 'Enter') launchCustom(); };
// ───────── PR レビューボード（Step1〜3）─────────
async function loadPRs() {
  prData = await fetch('/api/prs').then((r) => r.json()).catch(() => ({ prs: [] }));
  if (activeTab === 'pr') renderPRs(prData);
}

function switchTab(tab) {
  activeTab = tab;
  $('tab-session').classList.toggle('active', tab === 'session');
  $('tab-pr').classList.toggle('active', tab === 'pr');
  document.querySelector('.launch-bar').style.display = tab === 'session' ? '' : 'none';
  syncGroupButtons(); // トグル表示を切替先タブの軸に合わせる
  if (tab === 'session') { if (lastLiveData) render(lastLiveData); }
  else { renderPRs(prData); loadPRs(); }
}

function renderPRs(data) {
  const cards = $('cards');
  const prs = (data && data.prs) || [];
  $('stat').textContent = `${prs.length} 件の関与 PR`;
  $('tmux-hint').textContent = data && data.fetchedAt ? `更新 ${ago(data.fetchedAt)}` : 'PR 取得中…';
  if (!prs.length) { cards.innerHTML = '<div class="empty">関与している open PR はありません</div>'; return; }
  cards.innerHTML = '';
  const byBall = (a, b) => (b.ballMine ? 1 : 0) - (a.ballMine ? 1 : 0) || (b.updatedAt || '').localeCompare(a.updatedAt || '');
  if (groupBy.pr === 'repo') {
    // リポ別グループ。各リポ内はボール（自分の番）を上に
    const byRepo = {};
    for (const p of prs) (byRepo[p.repo.split('/').pop()] ||= []).push(p);
    for (const repo of Object.keys(byRepo).sort()) {
      appendGroup(cards, 'pr-repo:' + repo, `📁 ${repo}`, byRepo[repo].sort(byBall), makePRCard);
    }
  } else {
    // 状態別グループ
    const groups = [
      { label: '🔴 あなたのレビュー待ち', match: (p) => p.kind === 'review' },
      { label: '🔧 自分のPR・変更要求あり', match: (p) => p.kind === 'own' && p.reviewDecision === 'CHANGES_REQUESTED' },
      { label: '✅ マージ可', match: (p) => p.kind === 'own' && p.reviewDecision === 'APPROVED' && p.ci === 'pass' && p.mergeable === 'MERGEABLE' },
      { label: '⏳ 自分のPR・レビュー待ち', match: (p) => p.kind === 'own' },
    ];
    const used = new Set();
    for (const g of groups) {
      const items = prs.filter((p) => { const k = p.repo + '#' + p.number; return !used.has(k) && g.match(p); });
      items.forEach((p) => used.add(p.repo + '#' + p.number));
      items.sort(byBall);
      appendGroup(cards, 'pr-st:' + g.label, g.label, items, makePRCard);
    }
  }
}

function ciLabel(c) { return c === 'pass' ? '✓' : c === 'fail' ? '✗' : c === 'pending' ? '…' : '—'; }
function mergeLabel(m) { return m === 'MERGEABLE' ? 'マージ可' : m === 'CONFLICTING' ? 'コンフリクト' : ''; }

// PR の (repo, branch) に一致する作業中セッションを探す（headRefName ↔ セッションの現在ブランチ）
function findSessionForPR(p) {
  const sess = (lastLiveData && lastLiveData.sessions) || [];
  return sess.find((s) => s.repoNameWithOwner === p.repo && s.branch && s.branch === p.headRefName) || null;
}

function makePRCard(p) {
  const linked = findSessionForPR(p); // 紐付く作業中セッション（あれば「飛ぶ」を併設、無ければレビュー起動のみ）
  const card = document.createElement('div');
  card.className = 'card pr-card' + (p.ballMine && p.kind === 'review' ? ' waiting' : '');
  const rdClass = p.isDraft ? 'draft' : (p.reviewDecision || 'review_required').toLowerCase();
  const rdLabel = p.isDraft ? 'Draft' : (p.reviewDecision || 'REVIEW_REQUIRED');
  card.innerHTML = `
    <div class="top">
      <span class="pr-pill ${rdClass}">${escapeHtml(rdLabel)}</span>
      <span class="repo">${escapeHtml(p.repo.split('/').pop())}</span>
      ${linked ? '<span class="sess-badge" title="このPRのブランチで作業中のセッションがあります">🖥 作業中</span>' : ''}
      ${p.ballMine ? '<span class="ball-badge">🔵 あなたの番</span>' : ''}
    </div>
    <div class="title">#${p.number} ${escapeHtml(p.title)}</div>
    <div class="meta">
      <span class="ci ${p.ci}">CI ${ciLabel(p.ci)}</span>
      <span>${mergeLabel(p.mergeable)}</span>
      <span>更新 ${ago(Date.parse(p.updatedAt))}</span>
    </div>
    <div class="footer">
      <span class="sid">${escapeHtml(p.repo)} · @${escapeHtml(p.author)}</span>
      <button class="ghost open-pr">PR を開く</button>
      ${linked ? '<button class="jump jump-sess">↗ セッションへ飛ぶ</button>' : ''}
      <button class="${linked ? 'ghost' : 'jump'} launch-rev">レビュー起動</button>
    </div>`;
  card.querySelector('.open-pr').onclick = (e) => { e.stopPropagation(); window.open(p.url, '_blank'); };
  card.querySelector('.launch-rev').onclick = (e) => { e.stopPropagation(); launchReview(p); };
  const js = card.querySelector('.jump-sess');
  if (js) js.onclick = (e) => { e.stopPropagation(); jumpTo(linked.sessionId, js); };
  return card;
}

async function launchReview(p) {
  // claude-engineer-test の窓口で起動 → 初手で /engineer 実行 → リードが worktree 分離してレビュー
  const r = await fetch('/api/launch-review', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: p.repo, number: p.number, url: p.url, headRefName: p.headRefName }),
  });
  if (!r.ok) alert((await r.json()).error || 'レビュー起動に失敗');
}

$('tab-session').onclick = () => switchTab('session');
$('tab-pr').onclick = () => switchTab('pr');

// グループ軸トグル（状態 / リポ）。現在のタブの軸だけを切り替える
function setGroupMode(mode) {
  groupBy[activeTab] = mode;
  localStorage.setItem('orch-group-' + activeTab, mode);
  syncGroupButtons();
  rerender();
}
// トグルの active 表示を現タブの軸に合わせる（タブ切替時にも呼ぶ）
function syncGroupButtons() {
  const mode = groupBy[activeTab];
  $('grp-status').classList.toggle('active', mode === 'status');
  $('grp-repo').classList.toggle('active', mode === 'repo');
}
$('grp-status').onclick = () => setGroupMode('status');
$('grp-repo').onclick = () => setGroupMode('repo');
syncGroupButtons(); // 初期表示（session タブの軸）

// 依存コマンド欠落の警告バナー（doctor）。全部そろっていれば何も出さない
async function checkHealth() {
  try {
    const h = await fetch('/api/health').then((r) => r.json());
    const missing = Object.entries(h.checks || {}).filter(([, ok]) => !ok).map(([k]) => k);
    if (!missing.length) return;
    const div = document.createElement('div');
    div.style.cssText = 'background:#fff3cd;color:#7a5c00;border-bottom:1px solid #e8d48b;padding:8px 22px;font-size:12.5px;';
    div.textContent = `⚠ 次のコマンドが見つかりません: ${missing.join(', ')} — PATH を確認してください（launchd 常駐の場合は plist の PATH に追加）。該当機能は無効になります。`;
    document.body.prepend(div);
  } catch { /* noop */ }
}

loadPresets();
connectStream();
loadPRs();
checkHealth();
setInterval(loadPRs, 30000);
