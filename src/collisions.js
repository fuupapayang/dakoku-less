'use strict';
/**
 * 案件IDの衝突修復。
 *
 * 旧バージョンは案件IDを端末ごとの連番(p1, p2…)で採番していたため、別々の端末で作られた
 * 「別の案件」が同じIDを持ち、チーム同期で案件マスターに同居していた(例: p20 = T466/T724/T777)。
 * 工数はIDで記録されるため、同じIDの案件すべてに同じ分数が表示されていた。
 *
 * 修復方針:
 *  1. 衝突したIDの案件に、案件コードから決まる新ID(pc_コード)を振り直す。
 *     コードから一意に決まるので、どの端末で修復しても同じIDになり、同期で食い違わない。
 *  2. 旧IDに記録済みの工数は、根拠がある場合だけ付け替える:
 *       - その日より後に登録された案件は候補から外す
 *       - 担当制作者(makers)に本人が含まれる案件が1つに絞れればそれを採用
 *     絞り切れない工数は推測で配らず「要確認」(day.reviewMin)に移し、本人が案件タブで選ぶ。
 */

const DAY = 86400000;

function codeKey(p) { return String(p.code || '').trim().toUpperCase(); }

/** コードから決まる新ID(英数字以外は除去) */
function codeId(code) { return 'pc_' + String(code).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

/**
 * 案件マスターのID衝突を検出して振り直す。
 * @returns {{ projects: Array, collisions: Object<string, string[]> }} collisions: 旧ID -> 新IDの候補一覧
 */
function splitCollisions(projects) {
  const byId = new Map();
  for (const p of projects) {
    if (!byId.has(p.id)) byId.set(p.id, []);
    byId.get(p.id).push(p);
  }
  const collisions = {};
  const out = [];
  for (const p of projects) {
    const group = byId.get(p.id);
    const codes = new Set(group.map(codeKey));
    if (group.length > 1 && codes.size > 1 && codeKey(p)) {
      const nid = codeId(codeKey(p));
      (collisions[p.id] = collisions[p.id] || []).push(nid);
      out.push({ ...p, id: nid, idFixedFrom: p.id, keywordsReview: true });
    } else {
      out.push(p);
    }
  }
  return { projects: out, collisions };
}

/** 表示名と担当制作者の照合(「井上」と「井上さくら」のような部分一致を許容) */
function isMaker(p, userName) {
  const me = String(userName || '').replace(/\s/g, '');
  if (!me) return false;
  return (p.makers || []).some(m => {
    const x = String(m || '').replace(/\s/g, '');
    return x && (me.includes(x) || x.includes(me));
  });
}

/**
 * 旧IDの工数をどの案件に付け替えるか決める。根拠が無ければnull(要確認)。
 * @param dateKey 'YYYY-MM-DD'
 * @param candidates 新IDの案件オブジェクト配列
 */
function pickCandidate(dateKey, candidates, userName) {
  const dayEnd = new Date(dateKey).getTime() + DAY;
  let c = candidates.filter(p => !p.createdAt || p.createdAt < dayEnd);
  if (c.length === 1) return c[0].id;
  if (c.length === 0) c = candidates;
  const mine = c.filter(p => isMaker(p, userName));
  if (mine.length === 1) return mine[0].id;
  return null;
}

/**
 * 端末内データ(工数・カレンダー・学習統計)を修復する。dataは store.data 形式。破壊的に更新。
 * @returns {{ moved: number, review: number }} 付け替えた分数 / 要確認に回した分数
 */
function repairData(data, collisions, userName) {
  const byId = Object.fromEntries((data.projects || []).map(p => [p.id, p]));
  let moved = 0, review = 0;
  for (const [key, d] of Object.entries(data.days || {})) {
    if (!d.projectMin) continue;
    for (const [oid, nids] of Object.entries(collisions)) {
      const min = d.projectMin[oid];
      if (min == null) continue;
      delete d.projectMin[oid];
      if (!(min > 0)) continue;
      const cands = nids.map(id => byId[id]).filter(Boolean);
      const pick = pickCandidate(key, cands, userName);
      if (pick) {
        d.projectMin[pick] = (d.projectMin[pick] || 0) + min;
        moved += min;
      } else {
        (d.reviewMin = d.reviewMin || []).push({ min: Math.round(min), candidates: nids, from: oid });
        review += min;
      }
    }
  }
  // カレンダー予定: タイトルに案件コードか案件名が含まれる候補が1つならそれに、無ければ未割当
  for (const ev of data.calEvents || []) {
    const nids = ev.projectId && collisions[ev.projectId];
    if (!nids) continue;
    const title = String(ev.title || '');
    const hit = nids.map(id => byId[id]).filter(p => p && (
      (p.code && title.includes(p.code)) || (p.name && title.includes(String(p.name).trim()))
    ));
    ev.projectId = hit.length === 1 ? hit[0].id : null;
  }
  // 学習統計: 旧IDの学習はどの案件のものか判別できず、誤推論の元になるため破棄
  const ls = data.learnStats;
  if (ls) {
    for (const oid of Object.keys(collisions)) {
      if (ls.totals && ls.totals[oid] != null) { ls.n = Math.max(0, (ls.n || 0) - ls.totals[oid]); delete ls.totals[oid]; }
      for (const bucket of [ls.tokens || {}, ls.slots || {}]) {
        for (const m of Object.values(bucket)) delete m[oid];
      }
    }
  }
  return { moved: Math.round(moved), review: Math.round(review) };
}

module.exports = { splitCollisions, repairData, pickCandidate, isMaker, codeId };
