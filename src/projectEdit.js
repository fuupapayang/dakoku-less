'use strict';
/**
 * 案件の担当(担当営業 sales / 制作 makers)の正規化・検証と、編集パッチの整形。
 * main.js の projects:add / projects:update / projects:importFolder から使う純粋関数。
 * (renderer/app.js と demo/mock-api.js に同じ規則の簡易版があります。規則を変えたらそちらも合わせること)
 */

/** 名前の比較キー(空白除去)。「井上」と「井上 さくら」を同一視するため */
const nameKey = (n) => String(n || '').replace(/\s/g, '');

/** 表示名同士のゆるい一致(空白除去後、どちらかがもう一方を含む。src/collisions.js isMaker と同じ規則) */
function looseMatch(a, b) {
  const x = nameKey(a), y = nameKey(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
}

/**
 * 担当者名の入力(文字列 or 配列)を名前の配列に正規化する。
 * - カンマ・読点(, 、 ，)・セミコロン・改行・空白で区切り、前後空白を除去、空要素と重複(空白違い含む)を除く。
 * - ただし空白を含む塊が既知の名前(チームメンバー名など、knownNames)と完全一致(空白無視)するときは
 *   「山岡 潤」のようなフルネームとして1名扱いにする(空白で分割しない)。
 */
function splitNames(v, knownNames = []) {
  const known = new Map();
  for (const n of knownNames || []) { const k = nameKey(n); if (k && !known.has(k)) known.set(k, String(n).trim()); }
  const chunks = (Array.isArray(v) ? v : [v])
    .flatMap(x => String(x == null ? '' : x).split(/[,、，;；\n]+/));
  const out = [], seen = new Set();
  const push = (n) => {
    const t = String(n).trim(), k = nameKey(t);
    if (!k || seen.has(k)) return;
    seen.add(k); out.push(t);
  };
  for (const c of chunks) {
    const t = c.trim();
    if (!t) continue;
    if (/\s/.test(t) && !known.has(nameKey(t))) t.split(/\s+/).forEach(push);
    else push(known.get(nameKey(t)) || t);
  }
  return out;
}

/** チームメンバーに(ゆるく)一致しない名前の一覧。警告表示用(登録は止めない) */
function unknownNames(names, memberNames) {
  return (names || []).filter(n => !(memberNames || []).some(m => looseMatch(n, m)));
}

/** 担当営業・制作の必須チェック。問題なければ null、あれば日本語のエラー文 */
function validateStaff(sales, makers) {
  const s = !(sales && sales.length), m = !(makers && makers.length);
  if (s && m) return '担当営業と制作を入力してください(どちらも1名以上必須です)';
  if (s) return '担当営業を1名以上入力してください';
  if (m) return '制作を1名以上入力してください';
  return null;
}

/** 担当営業・制作のどちらかが空か(案件リストの「担当未入力」表示用) */
function missingStaff(p) {
  return !(p && p.sales && p.sales.length) || !(p && p.makers && p.makers.length);
}

// 編集で書き換えさせない項目(ID・コード・登録者・作成日・同期用の時刻)
const LOCKED = ['id', 'code', 'createdAt', 'createdBy', 'createdById', 'updatedAt', 'lastEditedBy', 'lastEditedAt'];
const STATUSES = ['active', 'delivered'];

/**
 * projects:update のパッチを整形・検証する。
 * sales/makers がパッチに含まれるときだけ必須チェックする(納品完了・キーワード更新など
 * 担当に触れない更新は、担当未入力の既存案件でもそのまま通す)。
 * @returns {{ patch?: object, error?: string }}
 */
function normalizePatch(patch, knownNames = []) {
  const out = { ...(patch || {}) };
  for (const k of LOCKED) delete out[k];
  if ('name' in out) {
    out.name = String(out.name || '').trim();
    if (!out.name) return { error: '案件名を入力してください' };
  }
  if ('client' in out) out.client = String(out.client || '').trim();
  if ('boxUrl' in out) out.boxUrl = String(out.boxUrl || '').trim();
  for (const k of ['budgetHours', 'estimateAmount']) {
    if (k in out) out[k] = Math.max(0, Number(out[k]) || 0);
  }
  if ('status' in out && !STATUSES.includes(out.status)) return { error: '状態の値が不正です' };
  const touchesStaff = 'sales' in out || 'makers' in out;
  if ('sales' in out) out.sales = splitNames(out.sales, knownNames);
  if ('makers' in out) out.makers = splitNames(out.makers, knownNames);
  if (touchesStaff) {
    // 片方だけのパッチでも、もう片方は既存値と合わせて検査するため呼び出し側で補完して渡すこと
    const err = validateStaff(out.sales, out.makers);
    if (err) return { error: err };
  }
  return { patch: out };
}

/**
 * 既存案件にパッチを適用する(Object.assign + 同期用の updatedAt 単調増加 + 最終編集者の記録)。
 * sales/makers の片方だけを送ってきた場合は既存のもう片方で必須チェックする。
 * @returns {{ project?: object, error?: string }}
 */
function applyEdit(project, patch, { userName = '', knownNames = [], now = Date.now() } = {}) {
  if (!project) return { error: '案件が見つかりません' };
  const p0 = { ...(patch || {}) };
  if ('sales' in p0 && !('makers' in p0)) p0.makers = project.makers || [];
  if ('makers' in p0 && !('sales' in p0)) p0.sales = project.sales || [];
  const r = normalizePatch(p0, knownNames);
  if (r.error) return r;
  Object.assign(project, r.patch);
  delete project.keywordsReview;
  project.updatedAt = Math.max(now, (project.updatedAt || 0) + 1);
  project.lastEditedBy = String(userName || '');
  project.lastEditedAt = now;
  return { project };
}

module.exports = { nameKey, looseMatch, splitNames, unknownNames, validateStaff, missingStaff, normalizePatch, applyEdit };
