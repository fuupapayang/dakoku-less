'use strict';
/**
 * 案件キーワードの整理(総管理者向け)。
 *
 * 旧バージョンの案件ID衝突で、同じキーワードが複数の案件に混ざって付いている。
 * キーワード判定は「リストで最初に一致した案件」を採るため、混ざったままだと全員の工数が誤った案件に入る。
 *
 * 整理案のルール(総管理者が確認して変更できる):
 *  1. キーワードがある案件のコードそのもの(例 "F542") → その案件にだけ残す
 *  2. ID修復の対象ではない案件(keywordsReview なし)にも付いている → そちらにだけ残す
 *  3. ID修復の対象の案件にしか付いていない → どの案件のものか判別できないので全て外す(付け直しは総管理者が選ぶ)
 */
const norm = (k) => String(k || '').trim().toLowerCase();

/** 2案件以上に付いているキーワードの一覧と整理案 */
function findDuplicates(projects) {
  const map = new Map(); // norm -> { keyword, projectIds:Set }
  for (const p of projects || []) {
    for (const k of p.keywords || []) {
      const n = norm(k);
      if (!n) continue;
      if (!map.has(n)) map.set(n, { keyword: String(k).trim(), ids: new Set() });
      map.get(n).ids.add(p.id);
    }
  }
  const byId = Object.fromEntries((projects || []).map(p => [p.id, p]));
  const out = [];
  for (const { keyword, ids } of map.values()) {
    if (ids.size < 2) continue;
    const list = [...ids].map(id => byId[id]).filter(Boolean);
    let keep, reason;
    const own = list.filter(p => norm(p.code) === norm(keyword));
    const clean = list.filter(p => !p.keywordsReview);
    if (own.length) { keep = own.map(p => p.id); reason = '案件コードと同じ'; }
    else if (clean.length) { keep = clean.map(p => p.id); reason = 'ID修復の対象ではない案件に残す'; }
    else { keep = []; reason = 'どの案件のものか判別できないため外す(付け直し先を選んでください)'; }
    out.push({
      keyword,
      projects: list.map(p => ({ id: p.id, code: p.code, name: p.name, review: !!p.keywordsReview })),
      keep, reason
    });
  }
  return out.sort((a, b) => b.projects.length - a.projects.length || a.keyword.localeCompare(b.keyword));
}

/**
 * 整理を反映(破壊的)。
 * @param decisions [{ keyword, keep:[projectId], addTo?:projectId }] keep 以外の案件からキーワードを外し、addTo があれば付ける
 * @returns { changed: [projectId] }
 */
function applyCleanup(projects, decisions, now = Date.now()) {
  const byId = Object.fromEntries(projects.map(p => [p.id, p]));
  const changed = new Set();
  for (const d of decisions || []) {
    const n = norm(d.keyword);
    if (!n) continue;
    const keep = new Set([...(d.keep || []), ...(d.addTo ? [d.addTo] : [])]);
    for (const p of projects) {
      const has = (p.keywords || []).some(k => norm(k) === n);
      if (has && !keep.has(p.id)) {
        p.keywords = p.keywords.filter(k => norm(k) !== n);
        changed.add(p.id);
      }
    }
    if (d.addTo && byId[d.addTo] && !(byId[d.addTo].keywords || []).some(k => norm(k) === n)) {
      byId[d.addTo].keywords = [...(byId[d.addTo].keywords || []), String(d.keyword).trim()];
      changed.add(d.addTo);
    }
  }
  // 他案件と重なるキーワードが無くなった案件は「キーワード要確認」を外す
  const dupLeft = new Set(findDuplicates(projects).flatMap(d => d.projects.map(p => p.id)));
  for (const p of projects) {
    if (changed.has(p.id)) p.updatedAt = now; // 同期では新しい方のキーワードが採用される
    if (p.keywordsReview && !dupLeft.has(p.id) && changed.has(p.id)) delete p.keywordsReview;
  }
  return { changed: [...changed] };
}

module.exports = { findDuplicates, applyCleanup };
