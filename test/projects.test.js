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

// ---- 9) キーワード判定の誤爆対策 ----
const kp = [
  { id: 'v1', code: 'F473', name: 'VENT案件', keywords: ['VENT', 'TK', 'Claude', 'チャット'], active: true },
  { id: 'v2', code: 'F500', name: 'イベント', keywords: ['event'], active: true },
  { id: 'd1', code: 'F601', name: 'レーベン京都', keywords: ['レーベン', 'レーベン京都五条'], active: true },
  { id: 'd2', code: 'F602', name: 'レーベン熊本', keywords: ['レーベン', '熊本四条'], makers: ['中村 健'], active: true },
  { id: 'd3', code: 'F603', name: 'レーベン福岡', keywords: ['レーベン'], sales: ['中村'], active: true },
  { id: 'g1', code: 'F700', name: '大和地所', keywords: ['大和'], active: true },
  { id: 'g2', code: 'F701', name: '大和地所 本社', keywords: ['大和地所'], active: true },
  { id: 'm1', code: 'F801', name: 'A社', keywords: ['acme'], makers: [], active: true },
  { id: 'm2', code: 'F802', name: 'B社', keywords: ['ACME'.toLowerCase() + 'x'], active: true }
];
// 英数字キーワードは単語単位: 'vent' は 'event' の一部には一致しない('event'自体の案件が取る)
assert.strictEqual(pj.matchText('Spring event plan.pptx', kp).id, 'v2');
assert.strictEqual(pj.matchText('Spring Events', kp), null);         // 'event' も 'events' の一部には一致しない
assert.strictEqual(pj.matchText('VENT_企画書', kp).id, 'v1');        // 区切り記号の前後はOK
assert.strictEqual(pj.matchText('ventilation.docx', kp), null);
// 英数字のみの2文字キーワードは無視、日本語は2文字から有効
assert.strictEqual(pj.matchText('TK 打合せメモ', kp), null);
assert.strictEqual(pj.usableKeyword('TK'), '');
assert.strictEqual(pj.usableKeyword('南座'), '南座');
assert.strictEqual(pj.usableKeyword('座'), '');
assert.strictEqual(pj.matchText('大和 打合せ', kp).id, 'g1');
// 一般語(ツール名など)は無視
assert.strictEqual(pj.matchText('Claude - 新しいチャット', kp), null);
assert.ok(pj.KEYWORD_STOP.has('claude') && pj.KEYWORD_STOP.has('チャット'));
// 複数案件に登録されたキーワードは、本人が制作/営業の案件でだけ有効(先頭の案件が取ってしまわない)
assert.strictEqual(pj.matchText('レーベン 物件資料', kp), null);                          // userName無し → 無視
assert.strictEqual(pj.matchText('レーベン 物件資料', kp, { userName: '井上' }), null);     // 本人の案件なし → 無視
assert.strictEqual(pj.matchText('レーベン 物件資料', kp, { userName: '中村健' }).id, 'd2'); // 本人が制作のd2のみ候補
// 本人の案件が複数なら全員候補 → 一覧順(d2 → d3)
assert.strictEqual(pj.matchText('レーベン 物件資料', kp, { userName: '中村' }).id, 'd2');
assert.ok(pj.ambiguousKeywords(kp).has('レーベン'));
// より具体的(長い)キーワードが勝つ(一覧で後ろにあっても)
assert.strictEqual(pj.matchText('レーベン京都五条_パース確認', kp).id, 'd1');
assert.strictEqual(pj.matchText('熊本四条 レーベン', kp).id, 'd2');
// 「大和」(2文字)より長い「大和地所」の案件が取る
assert.strictEqual(pj.matchText('大和地所様 提案書', kp).id, 'g2');
// 日本語は部分一致のまま
assert.strictEqual(pj.matchText('【大和地所本社】見積', kp).id, 'g2');
// 案件コードはキーワードより優先
assert.strictEqual(pj.matchText('F500_レーベン京都五条_資料', kp).id, 'v2');
// 同じ長さで並んだら、本人が制作/営業の案件を優先(無ければ一覧順)
const tie = [
  { id: 't1', code: 'F901', name: 'X', keywords: ['梅田北'], makers: ['田中'], active: true },
  { id: 't2', code: 'F902', name: 'Y', keywords: ['北新地'], sales: ['井上'], active: true }
];
assert.strictEqual(pj.matchText('梅田北・北新地 ロケハン', tie).id, 't1');
assert.strictEqual(pj.matchText('梅田北・北新地 ロケハン', tie, { userName: '井上さくら' }).id, 't2');
assert.strictEqual(pj.classify({ title: '梅田北・北新地 ロケハン', projects: tie, userName: '井上 さくら' }).id, 't2');

console.log('✓ all project tests passed');
