'use strict';
/**
 * 「制作に自分の名前がある案件なのに、監視フォルダ内に案件フォルダ(CODE_名称)が無い」の判定と、
 * そのアラートの後始末(7日スヌーズ・新規分だけの通知・制作から外れる・フォルダ名の生成)。
 * main.js の folderStatus / checkFolders / folder:* IPC から使う純粋関数(走査だけ fs を使う)。
 * (demo/mock-api.js にデモ用の固定データがあります)
 */
const path = require('path');
const { isMaker } = require('./collisions');
const { nameKey, looseMatch } = require('./projectEdit');

const SNOOZE_MS = 7 * 86400000;
const CODE_DIR = /^([A-Z]+\d+)_/; // 大文字のみ(工数の記録=フォルダ監視と同じ判定。小文字フォルダは記録されないため警告を消さない)
const SCAN_MAX_DEPTH = 3;
const SCAN_MAX_DIRS = 20000; // 巨大ドライブ対策(読み込むフォルダ数の上限)

/** フォルダ名 → 案件コード(大文字)。「t724_xx」も T724 とみなす。該当しなければ null */
function codeOfFolderName(name) {
  const m = String(name || '').match(CODE_DIR);
  return m ? m[1].toUpperCase() : null;
}

/**
 * 監視フォルダ配下(ルート自身を含め深さ maxDepth まで)の「CODE_名称」フォルダのコード集合。
 * ルート自体が案件フォルダ(例: 監視フォルダ = .../T724_メイツ)でも拾う。
 * @param fsImpl テスト用に差し替え可能({ readdirSync })
 */
function scanCodes(roots, { maxDepth = SCAN_MAX_DEPTH, maxDirs = SCAN_MAX_DIRS, fsImpl = require('fs') } = {}) {
  const codes = new Set();
  let budget = maxDirs;
  const walk = (dir, depth) => {
    const own = codeOfFolderName(path.basename(dir));
    if (own) codes.add(own);
    if (depth >= maxDepth || budget-- <= 0) return;
    let ents; try { ents = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const r of roots || []) if (r) walk(r, 0);
  return codes;
}

/**
 * 旧形式の永久非表示(folderHintDismissed: コード配列)を「今から7日のスヌーズ」に移行し、
 * 期限切れのスヌーズを掃除する。settings を破壊的に更新し、変更があれば true。
 */
function migrateSnooze(settings, now = Date.now()) {
  let changed = false;
  const snooze = (settings.folderSnooze && typeof settings.folderSnooze === 'object' && !Array.isArray(settings.folderSnooze))
    ? { ...settings.folderSnooze } : {};
  if (Array.isArray(settings.folderHintDismissed)) {
    for (const c of settings.folderHintDismissed) {
      const k = String(c || '').toUpperCase();
      if (k && !(snooze[k] > now)) snooze[k] = now + SNOOZE_MS;
    }
    delete settings.folderHintDismissed;
    changed = true;
  }
  for (const [k, until] of Object.entries(snooze)) if (!(Number(until) > now)) { delete snooze[k]; changed = true; }
  if (changed || !settings.folderSnooze) settings.folderSnooze = snooze;
  return changed;
}

function isSnoozed(snooze, code, now = Date.now()) {
  return Number((snooze || {})[String(code || '').toUpperCase()] || 0) > now;
}

/**
 * 自分が制作に入っている稼働中の案件のうち、案件フォルダが見つからないもの。
 * - 対象: active !== false かつ status が active(未設定は active)、コードあり、制作に自分(ゆるい一致)
 * - 「最近使っただけ」の案件は対象外(制作に名前がある案件だけ)
 * - コードは大文字小文字を区別しない
 * @param foundCodes Set|Array 見つかったコード
 * @param snooze {CODE: untilTs} スヌーズ中は除外(includeSnoozed: true なら含める)
 * @returns [{ id, code, name, folderName, snoozed }]
 */
function missingFolderProjects(projects, userName, foundCodes, { snooze = {}, now = Date.now(), includeSnoozed = false } = {}) {
  const found = new Set([...(foundCodes || [])].map(c => String(c).toUpperCase()));
  const out = [];
  for (const p of projects || []) {
    if (!p || p.active === false || (p.status || 'active') !== 'active' || !p.code) continue;
    if (!isMaker(p, userName)) continue;
    const code = String(p.code).toUpperCase();
    if (found.has(code)) continue;
    const snoozed = isSnoozed(snooze, code, now);
    if (snoozed && !includeSnoozed) continue;
    out.push({ id: p.id, code: p.code, name: p.name || '', folderName: folderNameFor(p.code, p.name), snoozed });
  }
  return out.sort((a, b) => String(a.code).localeCompare(String(b.code)));
}

/** 作成するフォルダ名「CODE_案件名」。ファイル名に使えない / \ : * ? " < > | と制御文字を除き、案件名部分は最大60文字 */
function folderNameFor(code, name) {
  let n = String(name || '').replace(/[\/\\:*?"<>|\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  n = [...n].slice(0, 60).join('').trim().replace(/[. ]+$/, ''); // 末尾のドット・空白は Windows で不可
  return `${String(code || '').trim()}_${n || '案件'}`;
}

/**
 * 「制作から外れる」: 自分の名前だけを制作から除いた makers を返す。
 * 完全一致(空白無視)の名前があればそれだけを、無ければゆるい一致の名前を外す。
 * @returns {{ makers?: string[], error?: string, onlyMaker?: boolean }}
 */
function removeMeFromMakers(project, userName) {
  const makers = (project && project.makers) || [];
  const me = nameKey(userName);
  if (!me) return { error: '設定で表示名を入力してください' };
  const exact = makers.filter(m => nameKey(m) === me);
  const drop = exact.length ? exact : makers.filter(m => looseMatch(m, userName));
  if (!drop.length) return { error: '制作にあなたの名前が見つかりません(すでに外れています)' };
  const rest = makers.filter(m => !drop.includes(m));
  if (!rest.length) {
    return { onlyMaker: true, error: '制作があなただけのため外れられません。先に別の制作担当を設定してください(案件リスト → 編集)' };
  }
  return { makers: rest };
}

/**
 * 新しく「フォルダなし」になった案件だけを通知する計画。
 * notified: {CODE: 'YYYY-MM-DD'(最初に通知した日)}。今も未作成の案件は残し、解消した案件は消す
 * (再び未作成になったらまた通知する)。上限 cap 件まで個別通知し、残りは件数だけ。
 * @returns {{ toNotify: object[], more: number, notified: object }}
 */
function planNotifications(missing, notified, today, cap = 3) {
  const prev = notified && typeof notified === 'object' ? notified : {};
  const next = {};
  const fresh = [];
  for (const p of missing || []) {
    const k = String(p.code).toUpperCase();
    if (prev[k]) next[k] = prev[k];
    else { next[k] = today; fresh.push(p); }
  }
  return { toNotify: fresh.slice(0, cap), more: Math.max(0, fresh.length - cap), notified: next };
}

/** child が parent の中(同一含む)にあるか */
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

module.exports = {
  SNOOZE_MS, codeOfFolderName, scanCodes, migrateSnooze, isSnoozed, missingFolderProjects,
  folderNameFor, removeMeFromMakers, planNotifications, isInside
};
