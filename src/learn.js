// Phase8 Step2/3: 人格の自己進化（自動再学習 ＋ 効果測定 ＋ 自動ロールバック）
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { PERSONA_DIR, RECORDS_PATH, DRAFT_CWD, getCurrentPersona } from './live.js';

const execFileP = promisify(execFile);
const META_PATH = join(PERSONA_DIR, 'meta.json');

// ---- records / meta I/O ----
function readRecords() {
  try {
    return readFileSync(RECORDS_PATH, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function writeRecords(recs) {
  writeFileSync(RECORDS_PATH, recs.map((r) => JSON.stringify(r)).join('\n') + (recs.length ? '\n' : ''));
}
function readMeta() { try { return JSON.parse(readFileSync(META_PATH, 'utf8')); } catch { return {}; } }
function writeMeta(m) { try { mkdirSync(PERSONA_DIR, { recursive: true }); writeFileSync(META_PATH, JSON.stringify(m, null, 2)); } catch { /* noop */ } }
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

async function runClaude(prompt) {
  const args = ['-p', prompt, '--no-session-persistence'];
  if (config.draftModel) args.push('--model', config.draftModel);
  const { stdout } = await execFileP(config.claudeBin, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024, cwd: DRAFT_CWD });
  return stdout.trim();
}

// 現 persona ＋ 新ペアから、更新版 persona を生成するプロンプト
function buildLearnPrompt(current, pairs) {
  const edited = pairs.filter((p) => p.action !== 'rejected' && p.sent);
  const rejected = pairs.filter((p) => p.action === 'rejected');
  const exLines = edited.slice(0, 40).map((p, i) => `【例${i + 1}】\n[AI草案] ${p.draft}\n[最終送信] ${p.sent}`).join('\n\n');
  const rejLines = rejected.slice(0, 20).map((p, i) => `【却下${i + 1}】 ${p.draft}`).join('\n');
  return [
    'あなたはユーザーの「返答スタイル・編集傾向プロファイル」を更新する編集者です。',
    '',
    '# 現在のプロファイル（前版。無ければ空）',
    current || '(なし)',
    '',
    '# 新しい事例: AIの草案をユーザーがどう直したか',
    exLines || '(なし)',
    rejected.length ? `\n# 却下された草案（避けるべき方向）\n${rejLines}` : '',
    '',
    '# 指示',
    '- ユーザーがどう直すかの傾向（口調・長さ・省略/追加する情報・判断基準・語尾）を抽出する',
    '- 頻出かつ確信できる傾向だけを反映。少数例での断定や一過性のものは入れない',
    '- 現在のプロファイルを土台に更新（良い項目は残し、矛盾は解消）',
    '- 箇条書き・最大15項目。更新後のプロファイル全文のみ出力（前置き・説明なし）',
  ].join('\n');
}

// 設定画面用: 学習状況のサマリ
export function getLearnStatus() {
  const cur = getCurrentPersona();
  const meta = readMeta();
  const recs = readRecords();
  const unlearned = recs.filter((r) => !r.learned).length;
  // 実データから version 別の平均 diff_ratio を再集計（進化メーター）
  const byVer = {};
  for (const r of recs) {
    if (r.diff_ratio == null) continue;
    (byVer[r.persona_version] ||= []).push(r.diff_ratio);
  }
  const versionStats = Object.entries(byVer)
    .map(([v, arr]) => ({ version: Number(v), avgDiff: Number(avg(arr).toFixed(3)), samples: arr.length }))
    .sort((a, b) => a.version - b.version);
  return {
    currentVersion: cur.version,
    personaText: cur.text,
    meta,
    totalRecords: recs.length,
    unlearned,
    threshold: config.learnThreshold,
    versionStats,
  };
}

// 手動ロールバック（設定画面のボタン）
export function setCurrentVersion(v) {
  if (Number(v) === 0) { try { writeFileSync(join(PERSONA_DIR, 'current'), '0'); } catch { /* */ } return { ok: true, currentVersion: 0 }; }
  try { readFileSync(join(PERSONA_DIR, `v${v}.md`), 'utf8'); } catch { return { error: `v${v} が存在しません`, code: 404 }; }
  try { mkdirSync(PERSONA_DIR, { recursive: true }); writeFileSync(join(PERSONA_DIR, 'current'), String(v)); } catch { /* */ }
  return { ok: true, currentVersion: Number(v) };
}

let learning = false;

// 監視ジョブ: 未学習が閾値を超えたら再学習し、毎回 効果測定/ロールバックを判定
export async function tick() {
  try {
    if (!learning) {
      const recs = readRecords();
      const unlearned = recs.filter((r) => !r.learned);
      if (unlearned.length >= config.learnThreshold) {
        learning = true;
        try { await runRelearn(recs, unlearned); } finally { learning = false; }
      }
    }
    evaluateAndRollback();
  } catch { /* noop */ }
}

async function runRelearn(recs, unlearned) {
  const cur = getCurrentPersona();
  const text = await runClaude(buildLearnPrompt(cur.text, unlearned));
  if (!text) return;
  const newVer = cur.version + 1;
  mkdirSync(PERSONA_DIR, { recursive: true });
  writeFileSync(join(PERSONA_DIR, `v${newVer}.md`), text);
  writeFileSync(join(PERSONA_DIR, 'current'), String(newVer));
  const meta = readMeta();
  meta[newVer] = { createdAt: new Date().toISOString(), pairsUsed: unlearned.length, baseline: cur.version, evaluated: false };
  writeMeta(meta);
  writeRecords(recs.map((r) => (r.learned ? r : { ...r, learned: true })));
  console.log(`[learn] persona v${newVer} 生成（${unlearned.length}ペア / baseline v${cur.version}）`);
}

// 新版で生成・送信された diff_ratio を集計し、baseline より悪化していれば自動ロールバック
function evaluateAndRollback() {
  const cur = getCurrentPersona();
  const meta = readMeta();
  const m = meta[cur.version];
  if (!m || m.evaluated || m.baseline == null) return;
  const recs = readRecords();
  const scoreOf = (v) => recs.filter((r) => r.persona_version === v && r.diff_ratio != null).map((r) => r.diff_ratio);
  const curScores = scoreOf(cur.version);
  if (curScores.length < config.evalMin) return; // M件たまるまで判定保留
  const avgCur = avg(curScores);
  m.avgDiffRatio = Number(avgCur.toFixed(3));
  m.draftCount = curScores.length;
  m.evaluated = true;
  const baseScores = scoreOf(m.baseline);
  if (baseScores.length) {
    const avgBase = avg(baseScores);
    m.baselineAvg = Number(avgBase.toFixed(3));
    if (avgCur > avgBase + config.rollbackThreshold) {
      writeFileSync(join(PERSONA_DIR, 'current'), String(m.baseline));
      m.rolledBackTo = m.baseline;
      console.log(`[learn] v${cur.version} 劣化 (${m.avgDiffRatio} > ${m.baselineAvg}) → v${m.baseline} に自動ロールバック`);
    }
  }
  writeMeta(meta);
}
