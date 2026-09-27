'use strict';
const assert = require('assert');
const sh = require('../src/sheets');

const members = [
  { name: '佐藤', days: {
    '2026-09-01': { estimation: { start: new Date(2026, 8, 1, 9, 0).getTime(), end: new Date(2026, 8, 1, 18, 0).getTime(), workMin: 480, breakMin: 60 }, status: 'approved', meetingMin: 30, projectMin: { p1: 300, p2: 180 } },
    '2026-08-31': { estimation: { start: 1, end: 2, workMin: 100, breakMin: 0 }, status: 'submitted', projectMin: { p1: 100 } } // 前月・対象外
  } }
];
const projById = { p1: { code: 'F001', name: 'A案件' }, p2: { code: 'T002', name: 'B案件' } };

// 履歴: 2026-09 のみ
const hist = sh.historyRows(members, '2026-09', (s) => s);
assert.strictEqual(hist.tab, '履歴_2026-09');
assert.strictEqual(hist.rows.length, 1);
assert.deepStrictEqual(hist.rows[0].slice(0, 7), ['佐藤', '2026-09-01', '火', '09:00', '18:00', '01:00', '08:00']);
assert.strictEqual(hist.rows[0][7], '00:30'); // 会議

// 工数: 2026-09 の案件別
const rep = sh.reportRows(members, '2026-09', projById);
assert.strictEqual(rep.tab, '工数_2026-09');
assert.strictEqual(rep.rows.length, 2);
const f = rep.rows.find(r => r[1] === 'F001');
assert.deepStrictEqual(f, ['佐藤', 'F001', 'A案件', 300, '05:00']);

console.log('✓ all sheets tests passed');
