'use strict';
const assert = require('assert');
const cal = require('../src/calendar');

const projects = [{ id: 'p1', code: 'F000', name: '山田商事' }];

// 1) マージ: 新しいupdatedAtが勝つ、tombstone維持
const a = [{ id: 'e1', date: '2026-07-14', sMin: 600, eMin: 660, title: '定例', updatedAt: 1 }];
const b = [{ id: 'e1', date: '2026-07-14', sMin: 600, eMin: 660, title: '定例(変更)', updatedAt: 2 },
           { id: 'e2', date: '2026-07-15', sMin: 540, eMin: 570, title: '納品', updatedAt: 1, deleted: true }];
const merged = cal.mergeEvents(a, b);
assert.strictEqual(merged.length, 2);
assert.strictEqual(merged.find(e => e.id === 'e1').title, '定例(変更)');
assert.strictEqual(merged.find(e => e.id === 'e2').deleted, true);

// 2) エンジン変換: コード前置summary、メンバー絞り込み
const evs = [
  { id: 'e1', date: '2026-07-14', sMin: 600, eMin: 660, title: '定例', projectId: 'p1', members: [] },
  { id: 'e2', date: '2026-07-14', sMin: 700, eMin: 730, title: '他人の予定', members: ['佐藤'] },
  { id: 'e3', date: '2026-07-15', sMin: 600, eMin: 660, title: '別日' }
];
const out = cal.eventsForEngine(evs, '2026-07-14', 'あなた', projects);
assert.strictEqual(out.length, 1);
assert.strictEqual(out[0].summary, 'F000_定例');
assert.strictEqual(new Date(out[0].s).getHours(), 10);

// 3) 次の予定
const nx = cal.nextEventFor(evs, 'p1', '2026-07-14');
assert.strictEqual(nx.id, 'e1');
assert.strictEqual(cal.nextEventFor(evs, 'p1', '2026-07-20'), null);

console.log('✓ all calendar tests passed');
