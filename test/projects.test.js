'use strict';
const assert = require('assert');
const pj = require('../src/projects');

const projects = [
  { id: 'p1', code: 'A123', name: '山田商事 在庫管理', keywords: ['山田商事', '在庫管理'], active: true },
  { id: 'p2', code: 'B200', name: '鈴木建設 勤怠刷新', keywords: ['鈴木建設'], active: true },
  { id: 'p3', code: 'C300', name: '停止中案件', keywords: ['テスト'], active: false }
];

// 1) コード判定: 「CODE_」前置(大文字+アンダースコア必須)
assert.strictEqual(pj.matchText('A123_見積書.xlsx - Excel', projects).id, 'p1');
assert.strictEqual(pj.matchText('会議メモ B200_議事録', projects).id, 'p2');
// 2) 旧[CODE]表記・小文字・アンダースコアなしは一致しない
assert.strictEqual(pj.matchText('週次定例 [B200] - Zoom', projects), null);
assert.strictEqual(pj.matchText('a123_見積書.xlsx', projects), null);
assert.strictEqual(pj.matchText('B200-議事録.docx', projects), null);
// 3) コードの誤爆防止: 単なる部分一致では反応しない
assert.strictEqual(pj.matchText('FA1234レポート.docx', projects), null);
// 3b) コード形式バリデーション
assert.ok(pj.CODE_FORMAT.test('F000') && pj.CODE_FORMAT.test('T123') && pj.CODE_FORMAT.test('AB12'));
assert.ok(!pj.CODE_FORMAT.test('f000') && !pj.CODE_FORMAT.test('F000_') && !pj.CODE_FORMAT.test('123F') && !pj.CODE_FORMAT.test('F-000'));
// 4) キーワード判定
const kw = pj.matchText('山田商事様_打合せメモ - Word', projects);
assert.strictEqual(kw.id, 'p1');
assert.strictEqual(kw.via, 'keyword');
// 5) 停止中案件は無視
assert.strictEqual(pj.classify({ title: 'テスト計画書', projects }), null);

// 6) カレンダー優先
const now = Date.now();
const hit = pj.classify({
  title: '無関係なメール - Outlook',
  calendar: [{ s: now - 10 * 60000, e: now + 10 * 60000, summary: 'A123_定例会議' }],
  now, projects
});
assert.strictEqual(hit.id, 'p1');
assert.strictEqual(hit.via, 'calendar');

// 7) トークン抽出: ストップワード・数字・拡張子を除外
const tokens = pj.tokenize('山田商事_請求書2026 - Excel | 2026.xlsx');
assert.ok(tokens.includes('山田商事'));
assert.ok(tokens.includes('請求書2026'));
assert.ok(!tokens.includes('Excel'));
assert.ok(!tokens.includes('xlsx'));
assert.ok(!tokens.includes('2026'));

// 8) topTokens
assert.deepStrictEqual(pj.topTokens({ a1: 3, b2: 5, c3: 1 }, 2), ['b2', 'a1']);

console.log('✓ all project tests passed');
