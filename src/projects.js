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
  // AIツール名(タイトルに常に含まれ、案件の手がかりにならない)
  'chatgpt', 'claude', 'antigravity', 'gemini', 'cursor', 'perplexity', 'copilot', 'codex', 'notebooklm',
  'pdf', 'docx', 'xlsx', 'pptx', 'txt', 'csv', 'html', 'app',
  'www', 'http', 'https', 'com', 'co', 'jp', 'ne', 'or',
  '新規', '無題', 'untitled', 'document', 'presentation', 'book', 'sheet',
  'file', 'ファイル', 'ページ', 'タブ', 'ホーム', 'home', 'new', 'tab', 'window',
  // ファイルパス由来の一般語(ドキュメントパス判定用)
  'users', 'user', 'applications', 'desktop', 'documents', 'downloads',
  'volumes', 'library', 'shared', 'work', 'data', 'projects', 'デスクトップ', '書類'
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

/**
 * キーワードとして使わない一般語(ツール名・操作語など)。
 * どの案件の作業中でもタイトルに現れるため、案件キーワードに登録されていても判定には使わない
 * (例: 「Claude」「チャット」が登録された案件に、AIツール操作中の時間がすべて吸われていた)。
 * 比較は小文字化して行う。
 */
const KEYWORD_STOP = new Set([
  'claude', 'chatgpt', 'gemini', 'copilot', 'cursor', 'perplexity', 'notebooklm', 'antigravity', 'codex', 'ai',
  'figma', 'slack', 'chrome', 'safari', 'zoom', 'teams', 'google', 'notion', 'filezilla',
  'excel', 'word', 'powerpoint', 'outlook', 'finder', 'explorer',
  'pre', 'tokyo', 'coding', 'test', 'new', 'untitled', 'home',
  'チャット', '保存', '新規', '無題', 'ファイル', 'ホーム', 'テスト'
]);
/**
 * キーワードの最小文字数(これ未満は短すぎて誤爆するため無視)
 *  英数字・記号のみ(ASCII)の語: 3文字以上(例: 'TK' は無視)。さらに単語単位で一致
 *  日本語などを含む語: 2文字以上(例: 南座・梅田 は有効)
 */
const KEYWORD_MIN_LEN_ASCII = 3;
const KEYWORD_MIN_LEN = 2;

const ASCII_WORD = /[A-Za-z0-9]/;

/**
 * キーワードがテキストに含まれるか(text, kw とも小文字化済み)。
 * キーワードの端が英数字なら、その側は英単語の途中に埋もれていないこと(単語境界)を要求する。
 * 例: 'vent' は 'event' に一致しない / 'abc' は 'abc_見積' や 'ABC商事' には一致する。
 * 日本語の端は従来どおり部分一致(日本語は単語区切りが無いため)。
 */
function containsKeyword(lower, kw) {
  const headAscii = ASCII_WORD.test(kw[0]);
  const tailAscii = ASCII_WORD.test(kw[kw.length - 1]);
  if (!headAscii && !tailAscii) return lower.includes(kw);
  let from = 0;
  for (;;) {
    const i = lower.indexOf(kw, from);
    if (i < 0) return false;
    const before = i > 0 ? lower[i - 1] : '';
    const after = lower[i + kw.length] || '';
    const okHead = !headAscii || !before || !ASCII_WORD.test(before);
    const okTail = !tailAscii || !after || !ASCII_WORD.test(after);
    if (okHead && okTail) return true;
    from = i + 1;
  }
}

/** 判定に使えるキーワード(小文字)か: 短すぎる・一般語は除外 */
function usableKeyword(k) {
  const s = String(k || '').trim().toLowerCase();
  const min = /^[\x00-\x7f]*$/.test(s) ? KEYWORD_MIN_LEN_ASCII : KEYWORD_MIN_LEN;
  if (s.length < min) return '';
  if (KEYWORD_STOP.has(s)) return '';
  return s;
}

/**
 * 複数の案件に登録されているキーワード(小文字)の集合。どの案件か決められないため、
 * 本人が制作/営業に入っている案件でだけ有効にする(matchText参照)。
 * 同じ案件が重複して並んでいても1件と数える(コード優先、無ければid)。
 */
function ambiguousKeywords(projects) {
  const owners = new Map(); // kw -> Set(案件キー)
  for (const p of projects || []) {
    const key = String(p.code || '').trim().toUpperCase() || 'id:' + p.id;
    for (const k of p.keywords || []) {
      const s = usableKeyword(k);
      if (!s) continue;
      if (!owners.has(s)) owners.set(s, new Set());
      owners.get(s).add(key);
    }
  }
  const out = new Set();
  for (const [k, set] of owners) if (set.size > 1) out.add(k);
  return out;
}

/** 表示名と制作・営業担当の照合(「井上」と「井上さくら」のような部分一致を許容) */
function isMember(p, userName) {
  const me = String(userName || '').replace(/\s/g, '');
  if (!me) return false;
  return [...(p.makers || []), ...(p.sales || [])].some(m => {
    const x = String(m || '').replace(/\s/g, '');
    return x && (me.includes(x) || x.includes(me));
  });
}

/**
 * テキストが案件に一致するか。一致すれば {id, code, name, via}
 * @param {Object} [opts] { userName } 同点時に本人が制作/営業に入っている案件を優先する
 */
function matchText(text, projects, opts = {}) {
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
  //    短すぎる語・一般語は使わない。
  //    複数案件に登録された語は、本人が制作/営業に入っている案件でだけ有効(該当なし・userName無しなら無視)。
  //    一致した中で「最も長いキーワード」の案件を採用(より具体的な語を優先)。
  //    同じ長さなら本人が制作/営業の案件 → 一覧の先頭の順。
  const amb = ambiguousKeywords(projects);
  let best = null; // { p, len, mine }
  for (const p of projects) {
    const mine = isMember(p, opts.userName);
    let len = 0;
    for (const k of p.keywords || []) {
      const s = usableKeyword(k);
      if (!s || (amb.has(s) && !mine) || s.length <= len) continue;
      if (containsKeyword(lower, s)) len = s.length;
    }
    if (!len) continue;
    if (!best || len > best.len || (len === best.len && mine && !best.mine)) best = { p, len, mine };
  }
  if (best) return { id: best.p.id, code: best.p.code, name: best.p.name, via: 'keyword' };
  return null;
}

/**
 * サンプル1件の案件判定
 * @param {Object} o { title, calendar:[{s,e,summary}], now, projects, userName }
 */
function classify({ title, calendar, now, projects, userName }) {
  const act = (projects || []).filter(p => p.active !== false);
  if (act.length === 0) return null;
  const opts = { userName };
  // 会議中はカレンダー予定の案件を最優先(PC操作の内容より確実)
  if (calendar && now) {
    const ev = calendar.find(ev => ev.s <= now && now < ev.e);
    if (ev) {
      const hit = matchText(ev.summary, act, opts);
      if (hit) return { ...hit, via: 'calendar' };
    }
  }
  return matchText(title, act, opts);
}

/** トークン頻度マップから上位n語 */
function topTokens(counts, n = 5) {
  return Object.entries(counts || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(e => e[0]);
}

module.exports = { tokenize, matchText, classify, topTokens, CODE_FORMAT, KEYWORD_STOP, KEYWORD_MIN_LEN, KEYWORD_MIN_LEN_ASCII, ambiguousKeywords, usableKeyword };
