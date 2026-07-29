'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const Store = require('../src/store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
const s = new Store(dir);

// 同一コードの重複案件 + 参照(工数・予定・学習)
s.data.projects = [
  { id: 'a1', code: 'T651', name: 'CM', keywords: ['ファミリー'], sales: ['佐藤'], status: 'active' },
  { id: 'a2', code: 'T651', name: 'CM', keywords: ['CM'], sales: [], status: 'active' },
  { id: 'b1', code: 'T776', name: '構成案', keywords: [], status: 'active' }
];
s.data.days = { '2026-07-30': { projectMin: { a1: 60, a2: 30 }, unclassified: [] } };
s.data.calEvents = [{ id: 'c1', projectId: 'a2', date: '2026-07-30', sMin: 600, eMin: 660, title: 'x' }];
s.data.learnStats = { tokens: {}, slots: {}, totals: { a1: 3, a2: 5 }, n: 8 };

const remap = s.dedupeProjects();

// 重複解消: T651は1件に
assert.strictEqual(s.data.projects.filter(p => p.code === 'T651').length, 1);
assert.strictEqual(s.data.projects.length, 2);
// a2 → a1 に付け替え
assert.strictEqual(remap.a2, 'a1');
// 工数が統合先へ合算
assert.strictEqual(s.data.days['2026-07-30'].projectMin.a1, 90);
assert.ok(s.data.days['2026-07-30'].projectMin.a2 == null);
// カレンダーの参照が付け替え
assert.strictEqual(s.data.calEvents[0].projectId, 'a1');
// 学習totalsも合算
assert.strictEqual(s.data.learnStats.totals.a1, 8);
// キーワードは統合(ユニオン)
const t651 = s.data.projects.find(p => p.code === 'T651');
assert.ok(t651.keywords.includes('ファミリー') && t651.keywords.includes('CM'));

fs.rmSync(dir, { recursive: true, force: true });
console.log('✓ all store tests passed');
