'use strict';
/**
 * 会社ポリシー(総管理者だけが変更できる設定)。
 * チーム同期中は Firestore の teams/{team}/meta/policy に保存され、メンバー全員に配られる。
 * 同期していない場合は端末内(store.data.policy)に保存する。
 *
 *  - 検知パラメータ(無操作とみなす秒数 / 休憩とみなす空白 / 日付の切替時刻)
 *  - 勤務時間帯(この時間外と休日は「仕事の証拠」がある時間だけ稼働に数える)
 *  - 仕事用アプリ一覧 / 私用アプリ・サイト一覧
 *  - 総管理者パスワード(ハッシュのみ保存)
 */
const crypto = require('crypto');
const recoru = require('./recoru');

const DEFAULT_PARAMS = { idleThresholdSec: 90, breakThresholdMin: 15, dayStartHour: 4 };

// アプリ名、またはブラウザのタブタイトルに含まれる語(大文字小文字を区別しない)
const DEFAULT_WORK_APPS = [
  'Figma', 'Photoshop', 'Illustrator', 'After Effects', 'Premiere', 'InDesign', 'Lightroom', 'Adobe XD',
  'Acrobat', 'Blender', 'Cinema 4D', 'DaVinci Resolve', 'Final Cut',
  'Excel', 'Word', 'PowerPoint', 'Keynote', 'Numbers', 'Pages', 'Outlook',
  'Teams', 'Slack', 'Zoom', 'Google Meet', 'Chatwork', 'Backlog', 'Notion', 'Box',
  'Visual Studio Code', 'Code', 'Xcode', 'Terminal', 'iTerm', 'Canva',
  'Google ドキュメント', 'Google スプレッドシート', 'Google スライド', 'Google Docs', 'Google Sheets', 'Google Slides',
  'ChatGPT', 'Claude', 'Antigravity', 'Cursor', 'Gemini', 'Perplexity', 'Copilot', 'NotebookLM',
  'RecoRu', 'レコル'
];
// SNS・YouTubeは業務(広告・SNS運用・動画制作)で使う会社が多いため初期値には入れない(必要なら総管理者が追加)
const DEFAULT_PRIVATE_APPS = [
  'Netflix', 'Prime Video', 'Disney+', 'Hulu', 'U-NEXT', 'ABEMA', 'TVer', 'DAZN', 'Twitch',
  'Steam', 'Epic Games', 'Nintendo', 'PlayStation',
  '楽天市場', 'メルカリ', 'ヤフオク', 'ZOZOTOWN',
  'LINE MUSIC', 'Spotify', 'Apple Music', 'Apple TV', 'ミュージック'
];

const DEFAULT_POLICY = {
  params: { ...DEFAULT_PARAMS },
  workStartMin: 9 * 60,   // 09:00
  workEndMin: 22 * 60,    // 22:00
  workApps: DEFAULT_WORK_APPS,
  privateApps: DEFAULT_PRIVATE_APPS,
  adminHash: '', adminSalt: ''
};

/** 保存済みポリシーに初期値を補完 */
function effective(saved) {
  const p = { ...DEFAULT_POLICY, ...(saved || {}) };
  p.params = { ...DEFAULT_PARAMS, ...((saved && saved.params) || {}) };
  if (!Array.isArray(p.workApps)) p.workApps = DEFAULT_WORK_APPS;
  if (!Array.isArray(p.privateApps)) p.privateApps = DEFAULT_PRIVATE_APPS;
  return p;
}

/**
 * 一覧との照合。5文字以下の短い語(Code, Word, Box, Zoom…)はアプリ名の単語一致のみ
 * (ページタイトルの「WordPress」「QRコード」等への誤爆を防ぐ)。長い語はアプリ名・タブタイトルの部分一致。
 */
function matchList(fg, list) {
  if (!fg) return null;
  const app = String(fg.app || '');
  const title = String(fg.title || '').toLowerCase();
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (list || []).find(w => {
    const word = String(w || '').trim();
    if (!word) return false;
    if (word.length <= 5) return new RegExp(`(^|[^A-Za-z])${esc(word)}($|[^A-Za-z])`, 'i').test(app);
    return app.toLowerCase().includes(word.toLowerCase()) || title.includes(word.toLowerCase());
  }) || null;
}
const isWorkApp = (fg, pol) => !!matchList(fg, pol.workApps);
const privateAppHit = (fg, pol) => matchList(fg, pol.privateApps);

/** 平日(祝日を除く)の勤務時間帯の内側か */
function inWorkWindow(ts, key, pol) {
  if (recoru.dayType(key) !== 'work') return false;
  const d = new Date(ts);
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= pol.workStartMin && m < pol.workEndMin;
}

/* ---- 総管理者パスワード(scrypt。平文は保存しない) ---- */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, pol) {
  if (!pol || !pol.adminHash || !pol.adminSalt) return false;
  const { hash } = hashPassword(password, pol.adminSalt);
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(pol.adminHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 総管理者が変更できる値の検証(範囲外は既定値に戻す) */
function sanitize(input) {
  const clamp = (v, lo, hi, d) => (Number.isFinite(+v) && +v >= lo && +v <= hi ? Math.round(+v) : d);
  const list = (v, d) => Array.isArray(v) ? [...new Set(v.map(s => String(s).trim()).filter(Boolean))].slice(0, 300) : d;
  const p = input || {};
  return {
    params: {
      idleThresholdSec: clamp(p.params && p.params.idleThresholdSec, 30, 600, DEFAULT_PARAMS.idleThresholdSec),
      breakThresholdMin: clamp(p.params && p.params.breakThresholdMin, 5, 120, DEFAULT_PARAMS.breakThresholdMin),
      dayStartHour: clamp(p.params && p.params.dayStartHour, 0, 12, DEFAULT_PARAMS.dayStartHour)
    },
    workStartMin: clamp(p.workStartMin, 0, 1439, DEFAULT_POLICY.workStartMin),
    workEndMin: clamp(p.workEndMin, 1, 1440, DEFAULT_POLICY.workEndMin),
    workApps: list(p.workApps, DEFAULT_WORK_APPS),
    privateApps: list(p.privateApps, DEFAULT_PRIVATE_APPS)
  };
}

module.exports = {
  DEFAULT_PARAMS, DEFAULT_POLICY, DEFAULT_WORK_APPS, DEFAULT_PRIVATE_APPS,
  effective, isWorkApp, privateAppHit, inWorkWindow, hashPassword, verifyPassword, sanitize
};
