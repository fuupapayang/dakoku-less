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

// 4) 本人判定: 作成者IDが一致する時だけ編集可。旧データ(IDなし)は表示名一致で判定
const me = { ids: ['uLocal', 'mTeam1'], name: 'あなた' };
assert.strictEqual(cal.canEdit({ createdById: 'mTeam1', createdByName: '別名' }, me), true);
assert.strictEqual(cal.canEdit({ createdById: 'mOther', createdByName: 'あなた' }, me), false); // 同名の他人
assert.strictEqual(cal.canEdit({ createdBy: 'あなた' }, me), true);   // 旧データ・本人名
assert.strictEqual(cal.canEdit({ createdBy: '佐藤' }, me), false);    // 旧データ・他人
assert.strictEqual(cal.canEdit({}, me), false);                       // 作成者不明は閲覧のみ

// 5) 作成・編集: 作成者を記録し、編集は updatedAt を必ず進めてマージで勝つ
const creator = { id: 'mTeam1', name: 'あなた' };
const f = cal.sanitizeInput({ date: '2026-07-14', sMin: 600, eMin: 660, title: ' 定例 ', projectId: 'p1', members: ['佐藤', ''] }, ['p1']);
assert.deepStrictEqual(f, { date: '2026-07-14', sMin: 600, eMin: 660, title: '定例', projectId: 'p1', kind: null, members: ['佐藤'] });
assert.ok(cal.sanitizeInput({ date: '2026-07-14', sMin: 660, eMin: 600 }).error);
assert.strictEqual(cal.sanitizeInput({ date: '2026-07-14', sMin: 600, eMin: 660, projectId: 'zz' }, ['p1']).projectId, null);
const created = cal.createEvent(f, creator, 1000);
assert.strictEqual(created.createdById, 'mTeam1');
assert.strictEqual(created.createdByName, 'あなた');
assert.strictEqual(created.createdBy, 'あなた');
const edited = cal.applyEdit(created, { ...f, title: '定例(時間変更)', sMin: 630 }, creator, 500); // 時計が戻っても
assert.ok(edited.updatedAt > created.updatedAt);
assert.strictEqual(edited.createdById, 'mTeam1');
assert.strictEqual(edited.id, created.id);
const m2 = cal.mergeEvents([edited], [created]);            // 古いリモートと同期しても編集が残る
assert.strictEqual(m2[0].title, '定例(時間変更)');
assert.strictEqual(cal.mergeEvents([created], [edited])[0].sMin, 630);
// 旧データを本人が編集すると作成者IDが確定する
const legacy = { id: 'old', date: '2026-07-14', sMin: 600, eMin: 660, title: '旧', createdBy: 'あなた', updatedAt: 5 };
const legacyEd = cal.applyEdit(legacy, { title: '旧(修正)' }, creator, 10);
assert.strictEqual(legacyEd.createdById, 'mTeam1');
assert.strictEqual(legacyEd.createdByName, 'あなた');

// 6) 削除(tombstone)は、より新しい編集コピーがあっても優先
const del = { ...created, deleted: true, updatedAt: 1500 };
const edLater = { ...created, title: '後から編集', updatedAt: 2000 };
assert.strictEqual(cal.mergeEvents([del], [edLater])[0].deleted, true);
assert.strictEqual(cal.mergeEvents([edLater], [del])[0].deleted, true);

// 7) 案件外の区分: 社内会議(案件外)/撮影・ロケハン
assert.deepStrictEqual(cal.KIND_IDS, ['internal', 'shoot']);
assert.strictEqual(cal.kindLabel('internal'), '社内会議（案件外）');
assert.strictEqual(cal.kindLabel('shoot'), '撮影・ロケハン');
assert.strictEqual(cal.normKind('bogus'), null);
const kf = cal.sanitizeInput({ date: '2026-07-14', sMin: 780, eMin: 960, title: '', kind: 'shoot', projectId: 'p1' }, ['p1']);
assert.strictEqual(kf.kind, 'shoot');
assert.strictEqual(kf.projectId, null);           // 区分と案件は排他
assert.strictEqual(kf.title, '撮影・ロケハン');      // タイトル省略時は区分名
const kEvs = [
  { id: 'k1', date: '2026-07-14', sMin: 600, eMin: 660, title: '全体朝会', kind: 'internal' },
  { id: 'k2', date: '2026-07-14', sMin: 780, eMin: 960, title: 'ロケハン', kind: 'shoot' }
];
const kOut = cal.eventsForEngine(kEvs, '2026-07-14', 'あなた', projects);
assert.strictEqual(kOut[0].summary, '社内会議（案件外）_全体朝会');
assert.strictEqual(kOut[0].kind, 'internal');
assert.strictEqual(kOut[1].kind, 'shoot');
const base = new Date(2026, 6, 14).getTime();
assert.strictEqual(cal.activeKindAt(kOut, base + 630 * 60000), 'internal');
assert.strictEqual(cal.activeKindAt(kOut, base + 800 * 60000), 'shoot');
assert.strictEqual(cal.activeKindAt(kOut, base + 700 * 60000), null);
assert.strictEqual(cal.activeKindAt(out, base + 630 * 60000), null); // 案件の予定は区分なし

// 8) エンジン: 区分付き予定中の無操作は稼働扱い(私用・移動の語句を含んでも)
const engine = require('../src/engine');
const day = {
  intervals: [{ s: base + 540 * 60000, e: base + 780 * 60000 }, { s: base + 960 * 60000, e: base + 1080 * 60000 }],
  calendar: cal.eventsForEngine([{ id: 'k3', date: '2026-07-14', sMin: 780, eMin: 960, title: '撮影(私用車で移動)', kind: 'shoot' }], '2026-07-14', 'あなた', projects)
};
const est = engine.estimate(day, [], { idleThresholdSec: 90, breakThresholdMin: 15, mergeGapMin: 5, dayStartHour: 4 });
assert.ok(!est.breaks.some(b => b.s >= base + 780 * 60000 && b.e <= base + 960 * 60000), '撮影中が休憩/対象外になっている');
assert.ok(est.segments.some(sg => sg.kind === 'work' && sg.s === base + 780 * 60000 && sg.e === base + 960 * 60000));
// 「撮影・ロケハン」の語句自体は私用・移動の正規表現に当たらない
assert.ok(!/通院|私用|中抜け|離席/.test('撮影・ロケハン') && !/移動|外出|直行|直帰|出張/.test('撮影・ロケハン'));

console.log('✓ all calendar tests passed');

