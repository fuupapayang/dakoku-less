'use strict';
/** 管理者ビュー用のデモチームデータ生成(本人以外のメンバー) */
const { dayKey } = require('./engine');

function rand(seed) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

function seedTeam(days = 35) {
  const members = [
    { id: 'u2', name: '佐藤 美咲', dept: '営業部' },
    { id: 'u3', name: '田中 蓮', dept: '開発部' },
    { id: 'u4', name: '鈴木 陽菜', dept: '人事部' },
    { id: 'u5', name: '高橋 大和', dept: '開発部' }
  ];
  const rnd = rand(42);
  const today = new Date();
  for (const m of members) {
    m.days = {};
    for (let i = days; i >= 1; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const wd = d.getDay();
      if (wd === 0 || wd === 6) continue;
      if (rnd() < 0.05) continue; // 欠勤/休暇
      const startH = 8 + rnd() * 2;
      const lenH = 8 + rnd() * 2.5;
      const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, Math.round(startH * 60)).getTime();
      const e = s + lenH * 3600 * 1000;
      const breakMin = 45 + Math.round(rnd() * 30);
      const workMin = Math.round(lenH * 60 - breakMin);
      const r = rnd();
      const confidence = r < 0.7 ? 'STABLE' : r < 0.9 ? 'UNSURE' : 'LOW';
      const submitted = confidence !== 'LOW' || rnd() < 0.5;
      const discrepancy = rnd() < 0.08 ? Math.round(30 + rnd() * 60) : 0;
      m.days[dayKey(s)] = {
        start: s, end: e, breakMin, workMin, confidence,
        status: submitted ? (rnd() < 0.6 ? 'approved' : 'submitted') : 'pending',
        discrepancyMin: discrepancy,
        auto: submitted && rnd() < 0.8
      };
    }
  }
  return { members, seededAt: Date.now() };
}

module.exports = { seedTeam };
