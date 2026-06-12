// Step1: 自分が関与する PR（レビュー依頼＋自分の PR）を取得し、状態と「ボール判定」を付ける
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

let myLogin = null;
async function getMyLogin() {
  if (myLogin) return myLogin;
  try {
    const { stdout } = await execFileP('gh', ['api', 'user', '--jq', '.login'], { timeout: 8000 });
    myLogin = stdout.trim();
  } catch { /* noop */ }
  return myLogin;
}

let cache = { at: 0, prs: [], loading: false };
export function getPRsData() { return { prs: cache.prs, fetchedAt: cache.at }; }

// statusCheckRollup（配列）を pass/fail/pending/none に集約
function ciState(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return 'none';
  const states = rollup.map((c) => c.state || c.conclusion || c.status || '');
  if (states.some((s) => /FAIL|ERROR/i.test(s))) return 'fail';
  if (states.some((s) => /PENDING|IN_PROGRESS|QUEUED|EXPECTED/i.test(s))) return 'pending';
  return 'pass';
}

async function enrich(item, kind, me) {
  const repo = item.repository?.nameWithOwner;
  if (!repo) return null;
  try {
    const { stdout } = await execFileP('gh', ['pr', 'view', String(item.number), '-R', repo,
      '--json', 'number,title,url,reviewDecision,statusCheckRollup,mergeable,isDraft,author,headRefName,updatedAt,reviews,comments,commits'],
      { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    const d = JSON.parse(stdout);

    // ボール判定（近似）: 自分の最終アクション vs 「相手」の最終アクション（push/他者コメント/他者レビュー）
    // CI完了やラベル変更（updatedAt）では🔵にしない＝「対応済みなのに永遠に🔵」を防ぐ
    const myTimes = [];
    const otherTimes = [];
    for (const r of d.reviews || []) (r.author?.login === me ? myTimes : otherTimes).push(r.submittedAt);
    for (const c of d.comments || []) (c.author?.login === me ? myTimes : otherTimes).push(c.createdAt);
    for (const c of d.commits || []) { const t = c.committedDate; if (t) otherTimes.push(t); } // push は相手(author)側
    const selfT = myTimes.filter(Boolean).sort().pop() || null;
    const otherT = otherTimes.filter(Boolean).sort().pop() || null;
    const ballMine = kind === 'own'
      ? d.reviewDecision === 'CHANGES_REQUESTED'           // 自分PR: 変更要求＝対応待ち
      : (!selfT || (otherT && otherT > selfT));            // レビュー: 未レビュー or 自分の後に相手が動いた

    return {
      kind, repo, number: d.number, title: d.title, url: d.url,
      reviewDecision: d.reviewDecision || null, mergeable: d.mergeable, isDraft: d.isDraft,
      ci: ciState(d.statusCheckRollup), updatedAt: d.updatedAt,
      author: d.author?.login || '', headRefName: d.headRefName || '', ballMine,
      reviewed: !!selfT, // 自分が一度でもレビュー/コメントしたか（未レビュー と 要再レビュー の切り分け用）
    };
  } catch { return null; }
}

export async function refreshPRs() {
  if (cache.loading) return;
  if (cache.at && Date.now() - cache.at < 60000) return; // 1分キャッシュ（PR状態は頻繁に変わらない）
  cache.loading = true;
  try {
    const me = await getMyLogin();
    const search = async (flag) => {
      try {
        const { stdout } = await execFileP('gh', ['search', 'prs', flag, '--state', 'open', '--json', 'number,title,url,repository', '--limit', '40'], { timeout: 15000 });
        return JSON.parse(stdout || '[]');
      } catch { return []; }
    };
    const [review, own] = await Promise.all([search('--review-requested=@me'), search('--author=@me')]);
    // 重複排除（review 優先）してから enrich を並行実行
    const seen = new Set();
    const tagged = [];
    for (const it of review) { const k = it.repository?.nameWithOwner + '#' + it.number; if (!seen.has(k)) { seen.add(k); tagged.push(['review', it]); } }
    for (const it of own) { const k = it.repository?.nameWithOwner + '#' + it.number; if (!seen.has(k)) { seen.add(k); tagged.push(['own', it]); } }
    const out = (await Promise.all(tagged.map(([kind, it]) => enrich(it, kind, me)))).filter(Boolean);
    cache = { at: Date.now(), prs: out, loading: false };
  } catch {
    cache.loading = false;
  }
}
