'use strict';
/**
 * 工数の付け替え指示(総管理者 → 各メンバーのPC)。
 *
 * 工数の元データは各メンバーのPCにしか無いため、総管理者は「指示」を作ってチームに配り
 * (Firestore meta/reassign)、各メンバーのアプリが次回同期で自分の分を反映して結果を報告する
 * (reassignDone/{memberId})。指示は1回だけ反映される(反映済みIDを端末に記録)。
 *
 * order = { id, memberId, memberName, fromPid, toPid|null(工数から外す), from:'YYYY-MM-DD', to:'YYYY-MM-DD', createdAt, createdBy }
 */

function newOrder(o, me) {
  return {
    id: 'ra' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    memberId: String(o.memberId || ''), memberName: String(o.memberName || ''),
    fromPid: String(o.fromPid || ''), toPid: o.toPid ? String(o.toPid) : null,
    from: String(o.from || ''), to: String(o.to || ''),
    createdAt: Date.now(), createdBy: String(me || '')
  };
}

function validate(o) {
  if (!o.memberId) return 'メンバーを選んでください';
  if (!o.fromPid) return '元の案件を選んでください';
  if (o.toPid && o.toPid === o.fromPid) return '付け替え先が元の案件と同じです';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.from) || !/^\d{4}-\d{2}-\d{2}$/.test(o.to)) return '期間を指定してください';
  if (o.from > o.to) return '期間の開始日が終了日より後になっています';
  return null;
}

/** 期間内の対象分数(変更しない)。days は端末の day でも同期サマリーでもよい */
function preview(days, o) {
  let min = 0, n = 0;
  for (const [k, d] of Object.entries(days || {})) {
    if (k < o.from || k > o.to) continue;
    const m = (d.projectMin || {})[o.fromPid] || 0;
    if (m > 0) { min += m; n++; }
  }
  return { min: Math.round(min), days: n };
}

/** 反映(破壊的)。復元分(restoredMin)も一緒に移す。移した分数を返す */
function applyOrder(days, o) {
  let moved = 0;
  for (const [k, d] of Object.entries(days || {})) {
    if (k < o.from || k > o.to || !d.projectMin) continue;
    const m = d.projectMin[o.fromPid];
    if (!(m > 0)) continue;
    delete d.projectMin[o.fromPid];
    if (o.toPid) d.projectMin[o.toPid] = (d.projectMin[o.toPid] || 0) + m;
    if (d.restoredMin && d.restoredMin[o.fromPid]) {
      const r = d.restoredMin[o.fromPid];
      delete d.restoredMin[o.fromPid];
      if (o.toPid) d.restoredMin[o.toPid] = (d.restoredMin[o.toPid] || 0) + r;
      if (!Object.keys(d.restoredMin).length) delete d.restoredMin;
    }
    moved += m;
  }
  return Math.round(moved);
}

/** 自分宛てで未反映の指示 */
function pendingFor(orders, memberId, applied) {
  const done = new Set(applied || []);
  return (orders || []).filter(o => o && o.memberId === memberId && !done.has(o.id));
}

module.exports = { newOrder, validate, preview, applyOrder, pendingFor };
