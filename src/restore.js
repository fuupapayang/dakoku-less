'use strict';
/**
 * 過去の工数をファイルの更新時刻から復元する(後付けの案件判定)。
 *
 * アプリはプライバシーのため「どのファイル/ウィンドウを見ていたか」を保存していないが、
 * 「PCを操作していた時間帯(day.intervals)」は残っている。これを案件フォルダ内の
 * ファイル更新時刻と突き合わせ、フォルダ監視と同じルール(保存の前後 stickyMin 分はその案件の作業)で
 * 操作時間を案件に割り当てる。
 *
 * 安全のための方針:
 *  - すでに記録されている工数とは二重に数えない(同じ案件の既存分を差し引き、日ごとの未割当時間を上限にする)
 *  - 復元した分は day.restoredMin に別記録し、取り消し・再実行ができる
 */
const MIN = 60000;
const CODE_SEG = /^([A-Z]+\d+)_/;

/** パスに含まれる最初の「CODE_名称」フォルダのコード(なければnull) */
function codeInPath(p) {
  for (const seg of String(p).split(/[\\/]+/)) {
    const m = seg.match(CODE_SEG);
    if (m) return m[1];
  }
  return null;
}

/** [{t, path}] → 時刻順の [{t, code}] */
function savesFromFiles(files) {
  const out = [];
  for (const f of files || []) {
    const code = codeInPath(f.path);
    if (code) out.push({ t: f.t, code });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** t 以下で最も新しい保存のindex(なければ -1) */
function lastAtOrBefore(saves, t) {
  let lo = 0, hi = saves.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (saves[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** その分(t)はどの案件か: 直前 stickyMin 分以内の保存を優先、なければ直後 stickyMin 分以内の保存 */
function codeAt(saves, t, stickyMs) {
  const i = lastAtOrBefore(saves, t);
  if (i >= 0 && t - saves[i].t <= stickyMs) return saves[i].code;
  const n = saves[i + 1];
  if (n && n.t - t <= stickyMs) return n.code;
  return null;
}

const sum = (o) => Object.values(o || {}).reduce((a, b) => a + (b || 0), 0);

/** 復元前の工数(以前に復元した分を除く) */
function baseProjectMin(day) {
  const base = { ...(day.projectMin || {}) };
  for (const [pid, m] of Object.entries(day.restoredMin || {})) {
    base[pid] = Math.max(0, (base[pid] || 0) - m);
    if (!base[pid]) delete base[pid];
  }
  return base;
}

/**
 * 月の工数を復元した場合の追加分を計算(データは変更しない)
 * @param o { days, saves, projects, ym:'YYYY-MM', stickyMin=30 }
 * @returns { perDay: {key:{pid:min}}, byProject: {pid:min}, unregistered: {code:min}, beforeMin, addMin, days }
 */
function plan({ days, saves, projects, ym, stickyMin = 30 }) {
  const idByCode = {};
  for (const p of projects || []) if (p.code) idByCode[String(p.code).toUpperCase()] = p.id;
  const stickyMs = stickyMin * MIN;
  const perDay = {}, byProject = {}, unregistered = {};
  let beforeMin = 0, addMin = 0;
  for (const key of Object.keys(days || {}).sort()) {
    if (key.slice(0, 7) !== ym) continue;
    const day = days[key];
    const base = baseProjectMin(day);
    beforeMin += sum(base);
    // 操作していた各1分を案件へ
    const raw = {};
    let active = 0;
    for (const iv of day.intervals || []) {
      for (let t = iv.s; t < iv.e; t += MIN) {
        active++;
        const code = codeAt(saves, t, stickyMs);
        if (!code) continue;
        const pid = idByCode[code];
        if (pid) raw[pid] = (raw[pid] || 0) + 1;
        else unregistered[code] = (unregistered[code] || 0) + 1;
      }
    }
    // 既に記録済みの同じ案件の分は差し引く(二重計上しない)
    const add = {};
    for (const [pid, m] of Object.entries(raw)) {
      const net = m - (base[pid] || 0);
      if (net > 0) add[pid] = net;
    }
    // 日ごとの上限 = 操作時間 − 既存の工数 − 社内会議/撮影
    const room = Math.max(0, active - sum(base) - sum(day.categoryMin));
    const want = sum(add);
    if (want > room && want > 0) {
      const k = room / want;
      for (const pid of Object.keys(add)) add[pid] = Math.floor(add[pid] * k);
    }
    for (const pid of Object.keys(add)) if (!add[pid]) delete add[pid];
    if (Object.keys(add).length) {
      perDay[key] = add;
      for (const [pid, m] of Object.entries(add)) { byProject[pid] = (byProject[pid] || 0) + m; addMin += m; }
    }
  }
  return { perDay, byProject, unregistered, beforeMin: Math.round(beforeMin), addMin, days: Object.keys(perDay).length };
}

/** 月の以前の復元を取り消す(破壊的)。取り消した分数を返す */
function undo(days, ym) {
  let n = 0;
  for (const [key, day] of Object.entries(days || {})) {
    if (key.slice(0, 7) !== ym || !day.restoredMin) continue;
    for (const [pid, m] of Object.entries(day.restoredMin)) {
      day.projectMin[pid] = Math.max(0, (day.projectMin[pid] || 0) - m);
      if (!day.projectMin[pid]) delete day.projectMin[pid];
      n += m;
    }
    delete day.restoredMin;
  }
  return n;
}

/** 計画を反映(破壊的)。同じ月を再実行した場合は、前回の復元を取り消してから反映する */
function apply(days, ym, p) {
  undo(days, ym);
  for (const [key, add] of Object.entries(p.perDay)) {
    const day = days[key];
    day.projectMin = day.projectMin || {};
    for (const [pid, m] of Object.entries(add)) day.projectMin[pid] = (day.projectMin[pid] || 0) + m;
    day.restoredMin = { ...add };
  }
  return p.addMin;
}

module.exports = { codeInPath, savesFromFiles, codeAt, plan, apply, undo, baseProjectMin };
