'use strict';
/**
 * 案件トラッキング: ウィンドウタイトル/カレンダー予定から案件を自動判定する。
 * 優先順: カレンダー予定 → 案件コード([A123] / A123_) → キーワード。
 * プライバシー: タイトル原文はメモリ上で判定に使うのみ。永続化されるのは
 * 「案件×分数」と、未分類ブロックの候補トークン(上位5語)だけ。
 */

const STOP = new Set([
  'excel', 'word', 'powerpoint', 'outlook', 'teams', 'slack', 'zoom', 'chrome', 'safari',
  'edge', 'firefox', 'finder', 'explorer', 'google', 'microsoft', 'adobe', 'acrobat',
  'docs', 'sheets', 'slides', 'drive', 'gmail', 'notion', 'figma',
  'pdf', 'docx', 'xlsx', 'pptx', 'txt', 'csv', 'html', 'app',
  'www', 'http', 'https', 'com', 'co', 'jp', 'ne', 'or',
  '新規', '無題', 'untitled', 'document', 'presentation', 'book', 'sheet',
  'file', 'ファイル', 'ページ', 'タブ', 'ホーム', 'home', 'new', 'tab', 'window'
]);

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** タイトルから案件キーワード候補となるトークンを抽出(原文は保持しない) */
function tokenize(title) {
  return String(title || '')
    .split(/[\s　\-_—–~|/\\.()\[\]{}【】「」『』<>:：;,、。・"'“”’!?！?？#*=+&@]+/)
    .map(t => t.trim())
    .filter(t =>
      t.length >= 2 && t.length <= 20 &&
      !STOP.has(t.toLowerCase()) &&
      !/^\d+$/.test(t) &&
      !/^[a-z]$/i.test(t)
    );
}

/** 案件コードの形式: 大文字英字+数字(例: F000, T123)。タイトル内では「F000_」のように _ が必須 */
const CODE_FORMAT = /^[A-Z]+\d+$/;

/** テキストが案件に一致するか。一致すれば {id, code, name, via} */
function matchText(text, projects) {
  if (!text) return null;
  const raw = String(text);
  const lower = raw.toLowerCase();
  // 1) 案件コード(明示): 「F000_」形式のみ。大文字限定・アンダースコア必須(大文字小文字を区別)
  for (const p of projects) {
    const c = String(p.code || '').trim();
    if (!c) continue;
    if (new RegExp(`(^|[^A-Za-z0-9])${escapeRe(c)}_`).test(raw)) {
      return { id: p.id, code: p.code, name: p.name, via: 'code' };
    }
  }
  // 2) キーワード(顧客名・システム名など)
  for (const p of projects) {
    if ((p.keywords || []).some(k => k && String(k).length >= 2 && lower.includes(String(k).toLowerCase()))) {
      return { id: p.id, code: p.code, name: p.name, via: 'keyword' };
    }
  }
  return null;
}

/**
 * サンプル1件の案件判定
 * @param {Object} o { title, calendar:[{s,e,summary}], now, projects }
 */
function classify({ title, calendar, now, projects }) {
  const act = (projects || []).filter(p => p.active !== false);
  if (act.length === 0) return null;
  // 会議中はカレンダー予定の案件を最優先(PC操作の内容より確実)
  if (calendar && now) {
    const ev = calendar.find(ev => ev.s <= now && now < ev.e);
    if (ev) {
      const hit = matchText(ev.summary, act);
      if (hit) return { ...hit, via: 'calendar' };
    }
  }
  return matchText(title, act);
}

/** トークン頻度マップから上位n語 */
function topTokens(counts, n = 5) {
  return Object.entries(counts || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(e => e[0]);
}

module.exports = { tokenize, matchText, classify, topTokens, CODE_FORMAT };
