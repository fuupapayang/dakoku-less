'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, powerMonitor, ipcMain, dialog, systemPreferences, shell, Notification, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('./src/store');
const engine = require('./src/engine');
const projectsLib = require('./src/projects');
const learnLib = require('./src/learn');
const calendarLib = require('./src/calendar');
const meetingsLib = require('./src/meetings');
const sheetsLib = require('./src/sheets');
const recoruLib = require('./src/recoru');
const collisionsLib = require('./src/collisions');
const policyLib = require('./src/policy');
const restoreLib = require('./src/restore');
const Watcher = require('./src/watcher');
const { Sync } = require('./src/sync');
const { seedTeam } = require('./src/demo');

let win = null;
let tray = null;
let store = null;
let quitting = false;

// ---- 稼働トラッカー(実データ検知) ------------------------------------
// powerMonitor.getSystemIdleTime() をポーリングして稼働区間を組み立てる。
// 生のサンプルはメモリ内のみ。永続化は「稼働区間(何時〜何時)」だけ。
const SAMPLE_MS = 15 * 1000;
const SAMPLE_MIN = SAMPLE_MS / 60000;
let currentKey = null;
let currentInterval = null; // {s,e} 進行中の稼働区間
let sampleTimer = null;
let forcedIdle = false;     // スリープ/ロック中
let sampling = false;

// ---- 案件トラッキング(オプトイン) ------------------------------------
// 前面ウィンドウのタイトルはメモリ上で案件判定に使うのみで、原文は保存しない。
let activeWinFn = null;
let activeWinTried = false;
let currentWork = null;     // {projectId, code, name, via, app} | null
let curUnc = null;          // 進行中の未分類ブロック {s, e, tokenCounts}
let teamStatsCache = [];    // チームメンバーの学習統計(同期で取得、メモリのみ)
let sync = null;            // Firebase同期
let watcher = null;         // フォルダ監視
let recentFolderHit = null; // { folder, pid, ts } 直近のファイル更新による案件検知
let lastPrivateWhy = null;
let recentHit = null;       // { pid, ts } 直近に案件を判定できた時刻(手段を問わない)。AIツール操作中の継続計上に使う

// AIツール(デスクトップアプリ名 / ブラウザのタブタイトル)
const AI_APP = /^(ChatGPT|Claude|Antigravity|Cursor|Codex|Gemini|Perplexity|Copilot|Windsurf|Microsoft Copilot)\b/i;
const AI_TITLE = /(ChatGPT|Claude|Gemini|Perplexity|Copilot|NotebookLM|Antigravity|Google AI Studio)/i;
function isAiFg(fg) {
  if (!fg) return false;
  return AI_APP.test(fg.app || '') || AI_TITLE.test(fg.title || '');
}

/** macOSの画面収録権限。granted以外のときはactive-winを呼ばない(権限アラート連発防止) */
function screenPermission() {
  if (process.platform !== 'darwin') return 'granted';
  try { return systemPreferences.getMediaAccessStatus('screen'); } catch (e) { return 'unknown'; }
}

async function getForeground() {
  // タイトル判定がオフの場合、active-winを一切呼ばない(権限ダイアログを出さない)
  if (settings().titleDetect !== true) return null;
  if (screenPermission() !== 'granted') return null; // 権限未反映の間は取得しない
  if (!activeWinTried) {
    activeWinTried = true;
    try { activeWinFn = require('active-win'); } catch (e) { activeWinFn = null; }
  }
  if (!activeWinFn) return null;
  try {
    const w = await activeWinFn();
    if (!w) return null;
    return { title: w.title || '', app: (w.owner && w.owner.name) || '' };
  } catch (e) { return null; }
}

/** フォルダ監視: 案件フォルダ内のファイル更新を検知して案件を対応づける */
function onFolderHit(folder) {
  const hit = projectsLib.matchText(folder, store.data.projects);
  if (hit) {
    recentFolderHit = { folder, pid: hit.id, ts: Date.now() };
  } else {
    // フォルダは検知したが未登録の案件コード → 案内(頻度を抑えて1時間に1回)
    const now = Date.now();
    if (now - (onFolderHit.lastWarn || 0) > 3600000) {
      onFolderHit.lastWarn = now;
      const code = (folder.match(/^([A-Z]+\d+)_/) || [])[1];
      if (code) notify('未登録の案件フォルダを検知', `${folder} を検知しましたが、案件コード ${code} が未登録です。案件タブで登録すると計上されます。`);
    }
  }
}

function startWatcher() {
  if (watcher) watcher.stop();
  watcher = new Watcher(onFolderHit);
  const roots = (settings().watchRoots || []).filter(Boolean);
  if (roots.length) watcher.start(roots);
}

function syncUnc(day) {
  if (!curUnc) return;
  const rec = { s: curUnc.s, e: curUnc.e, tokens: projectsLib.topTokens(curUnc.tokenCounts), hint: curUnc.hint || null };
  const last = day.unclassified[day.unclassified.length - 1];
  if (last && last.s === curUnc.s) day.unclassified[day.unclassified.length - 1] = rec;
  else day.unclassified.push(rec);
}

function flushUnclassified(day) {
  if (curUnc) { syncUnc(day); curUnc = null; }
}

// オンライン会議の判定(アプリ名 or タイトル)
const MEETING_APP = /\b(zoom|teams|webex|around|whereby|discord)\b/i;
const MEETING_TITLE = /(google meet|meet\.google|zoom meeting|microsoft teams|オンライン会議|ビデオ会議|ウェビナー|webinar|会議中|ミーティング|打ち合わせ|打合せ|定例|mtg\b)/i;
function isMeetingFg(fg) {
  if (!fg) return false;
  return MEETING_APP.test(fg.app || '') || MEETING_TITLE.test(fg.title || '');
}
function isMeetingCal(combinedCal, now) {
  return (combinedCal || []).some(ev => ev.s <= now && now < ev.e && (ev.kind === 'internal' ||
    /(会議|ミーティング|mtg|打ち合わせ|打合せ|定例|meeting|オンライン)/i.test(ev.summary || '')));
}

/** 案件外の予定(社内会議・撮影/ロケハン)中なら、その区分の時間として day.categoryMin に計上。計上したら区分を返す */
function addCategoryMin(day, now, combinedCal) {
  const kind = calendarLib.activeKindAt(combinedCal || dayCalendar(day, day.date), now);
  if (!kind) return null;
  day.categoryMin = day.categoryMin || {};
  day.categoryMin[kind] = (day.categoryMin[kind] || 0) + SAMPLE_MIN;
  return kind;
}

let lastLearnMin = 0;
let lastMeetingLog = 0;

function trackWork(day, now, fg) {
  const combinedCal = dayCalendar(day, day.date);

  // オンライン会議の記録(実働=タイトル検知を優先、カレンダー予定を補足)
  if (settings().detectMeetings !== false && (isMeetingFg(fg) || isMeetingCal(combinedCal, now))) {
    day.meetingMin = (day.meetingMin || 0) + SAMPLE_MIN;
    if (now - lastMeetingLog > 10 * 60000) {
      lastMeetingLog = now;
      logEvent(day, `オンライン会議を検知(${engine.fmtTime(now)})`);
    }
  }

  const text = (fg && fg.title) || '';
  let hit = projectsLib.classify({
    title: text, calendar: combinedCal, now, projects: store.data.projects
  });
  // タイトルで判定できない場合、直近のファイル更新で検知した案件を「継続」計上する。
  // 最後のファイル更新から stickyMin 分以内は同じ案件とみなし、別案件のファイルが
  // 更新されると自動で切り替わる(フォルダ監視の継続方式)。
  const stickyMs = (settings().folderStickyMin || 30) * 60000;
  let viaFolder = false;
  if (!hit && recentFolderHit && now - recentFolderHit.ts <= stickyMs) {
    const p = store.data.projects.find(p => p.id === recentFolderHit.pid);
    if (p && p.active !== false) { hit = { id: p.id, code: p.code, name: p.name, via: 'folder' }; viaFolder = true; }
  }
  // AIツール(ChatGPT/Claude/Antigravity等)操作中:
  //  タイトルに案件コードがあればそれで判定済み。無ければ直前に判定できた案件を継続計上
  //  (AIへの相談・生成は、直前まで作業していた案件の続きであることが多いため)
  const ai = isAiFg(fg);
  if (ai) day.aiMin = (day.aiMin || 0) + SAMPLE_MIN;
  if (!hit && ai && recentHit && now - recentHit.ts <= (settings().aiStickyMin || 30) * 60000) {
    const p = store.data.projects.find(p => p.id === recentHit.pid);
    if (p && p.active !== false) hit = { id: p.id, code: p.code, name: p.name, via: 'ai-tool' };
  }
  if (hit) {
    if (hit.via !== 'ai-tool') recentHit = { pid: hit.id, ts: now };
    day.projectMin[hit.id] = (day.projectMin[hit.id] || 0) + SAMPLE_MIN;
    currentWork = { projectId: hit.id, code: hit.code, name: hit.name, via: hit.via, app: fg ? fg.app : '' };
    flushUnclassified(day);
    // 確定判定から動向を弱く学習(1分に1回)。フォルダ判定時はタイトル語句を学習して精度向上
    const nowMin = Math.floor(now / 60000);
    if (fg && text && hit.via !== 'ai-tool' && nowMin !== lastLearnMin) {
      lastLearnMin = nowMin;
      learnLib.learn(store.data.learnStats, {
        tokens: projectsLib.tokenize(text), ts: now, projectId: hit.id, weight: viaFolder ? 2 : 1
      });
    }
    return;
  }
  // 案件が判定できず、案件外の予定(社内会議・撮影/ロケハン)中 → その区分として計上(推論より予定を優先)
  const kind = addCategoryMin(day, now, combinedCal);
  if (kind) {
    currentWork = { projectId: null, category: kind, app: fg ? fg.app : '' };
    flushUnclassified(day);
    return;
  }
  currentWork = { projectId: null, app: fg ? fg.app : '' };
  if (!fg || (!fg.title && !fg.app)) return; // 権限なし・取得失敗
  const tokens = projectsLib.tokenize(text);

  // 動向学習による推論(個人+チーム統計、会議の余韻を加味)
  const carryPid = learnLib.carryProject(combinedCal, now,
    (t) => projectsLib.matchText(t, store.data.projects));
  const guess = learnLib.infer(
    [store.data.learnStats, ...teamStatsCache],
    { tokens, ts: now, carryPid, projects: store.data.projects }
  );
  if (guess && guess.p >= learnLib.AUTO_THRESHOLD && guess.p - guess.second >= 0.3) {
    const p = store.data.projects.find(p => p.id === guess.pid);
    if (p) {
      day.projectMin[p.id] = (day.projectMin[p.id] || 0) + SAMPLE_MIN;
      currentWork = { projectId: p.id, code: p.code, name: p.name, via: 'ai', app: fg.app, pct: Math.round(guess.p * 100) };
      flushUnclassified(day);
      return;
    }
  }

  // 未分類ブロックへ(AI候補があればヒントとして保持)
  if (curUnc && now - curUnc.e <= 5 * engine.MIN) {
    curUnc.e = now;
  } else {
    flushUnclassified(day);
    curUnc = { s: now, e: now, tokenCounts: {} };
  }
  for (const t of tokens) curUnc.tokenCounts[t] = (curUnc.tokenCounts[t] || 0) + 1;
  curUnc.hint = guess ? { pid: guess.pid, pct: Math.round(guess.p * 100) } : (curUnc.hint || null);
  syncUnc(day);
}

function settings() { return store.data.settings; }

/** デスクトップ通知(設定でオフ可) */
function notify(title, body) {
  if (settings().notifications === false) return;
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch (e) { /* 通知不可環境では無視 */ }
}

/** 未提出リマインド(今日以外でpendingの日) */
function remindPending() {
  const n = Object.values(store.data.days).filter(d =>
    d.date !== currentKey && d.status === 'pending' && d.estimation && d.estimation.start).length;
  if (n > 0) notify('未提出の勤怠があります', `${n}日分が未提出です。履歴タブから確認・提出してください。`);
}

/** 予算工数アラート: 消化80% / 100%で1回ずつ通知 */
function consumedMinOf(pid) {
  let total = 0;
  for (const d of Object.values(store.data.days)) total += (d.projectMin || {})[pid] || 0;
  const myId = (settings().sync || {}).memberId;
  const rt = store.data.remoteTeam;
  if (rt) for (const m of rt.members || []) {
    if (m.id === myId) continue;
    for (const d of Object.values(m.days || {})) total += (d.projectMin || {})[pid] || 0;
  }
  return total;
}

function checkBudgets() {
  let changed = false;
  for (const p of store.data.projects) {
    if (p.active === false || (p.status || 'active') !== 'active' || !p.budgetHours) continue;
    const pct = consumedMinOf(p.id) / 60 / p.budgetHours;
    if (pct >= 1 && !p.alert100) {
      p.alert100 = true; changed = true;
      notify('⚠ 予算工数を超過しました', `${p.code} ${p.name}: 消化率 ${Math.round(pct * 100)}%(予算 ${p.budgetHours}h)`);
    } else if (pct >= 0.8 && !p.alert80) {
      p.alert80 = true; changed = true;
      notify('予算工数の消化が80%に達しました', `${p.code} ${p.name}: 消化率 ${Math.round(pct * 100)}%(予算 ${p.budgetHours}h)`);
    }
  }
  if (changed) { store.save(); pushUpdate(); }
}

/**
 * 監視フォルダの点検: 未登録 / 見つからない(外付け・NAS未接続) / 担当案件のフォルダが監視範囲に無い
 * 監視範囲内のフォルダ名(CODE_名称)は30分ごとに浅く走査してキャッシュする
 */
let folderScan = { at: 0, codes: new Set() };
function scanFolderCodes(roots) {
  const codes = new Set();
  const walk = (dir, depth) => {
    const own = Watcher.projectFolderIn(path.basename(dir));
    if (own) codes.add(own.split('_')[0]);
    if (depth >= 2) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return codes;
}
function folderStatus() {
  const roots = settings().watchRoots || [];
  const existing = roots.filter(r => { try { return fs.existsSync(r); } catch (_) { return false; } });
  const missing = roots.filter(r => !existing.includes(r));
  if (Date.now() - folderScan.at > 30 * 60000) folderScan = { at: Date.now(), codes: scanFolderCodes(existing) };
  const me = settings().userName;
  const dismissed = new Set(settings().folderHintDismissed || []);
  const since = engine.dayKey(Date.now() - 30 * 86400000, settings().dayStartHour);
  const usedRecently = new Set();
  for (const [k, d] of Object.entries(store.data.days)) if (k >= since) for (const pid of Object.keys(d.projectMin || {})) usedRecently.add(pid);
  const mine = store.data.projects.filter(p => p.active !== false && (p.status || 'active') === 'active' && p.code &&
    (collisionsLib.isMaker(p, me) || usedRecently.has(p.id)));
  const unregistered = mine.filter(p => !folderScan.codes.has(String(p.code).toUpperCase()) && !dismissed.has(p.code))
    .map(p => ({ code: p.code, name: p.name }));
  return { noRoots: roots.length === 0, missing, unregistered, trackWork: !!settings().trackWork };
}
function checkFolders() {
  const st = folderStatus();
  const today = engine.dayKey(Date.now(), settings().dayStartHour);
  if (settings().folderNoticeDay === today) return;
  let msg = null;
  if (st.noRoots) msg = '監視する案件フォルダが未登録です。このままでは案件ごとの作業時間(工数)が記録されません。設定してください。';
  else if (st.missing.length) msg = `監視フォルダが見つかりません(外付けドライブ・NASが未接続?): ${st.missing.map(r => path.basename(r)).join(', ')}。接続するまで工数が記録されません。`;
  else if (st.unregistered.length) msg = `担当案件のフォルダが監視範囲にありません: ${st.unregistered.slice(0, 5).map(p => p.code).join(', ')}${st.unregistered.length > 5 ? ' ほか' : ''}。工数が記録されない可能性があります。`;
  if (!msg) return;
  settings().folderNoticeDay = today;
  store.save();
  notify('案件フォルダの登録をお願いします', msg);
}

// ---- 会社ポリシー・総管理者 ------------------------------------------------
function pol() { return policyLib.effective(store.data.policy); }

/** ポリシーの検知パラメータを設定へ強制反映(各自は変更不可) */
function applyPolicyParams() {
  const p = pol().params;
  const s = settings();
  let changed = false;
  for (const k of Object.keys(p)) if (s[k] !== p[k]) { s[k] = p[k]; changed = true; }
  if (changed && currentKey) reestimate(currentKey);
  return changed;
}

let adminUntil = 0;                 // 総管理者モードの有効期限(メモリのみ。再起動でロック)
let adminFails = { n: 0, until: 0 }; // 連続失敗のロックアウト
const ADMIN_SESSION_MS = 30 * 60000;
function adminUnlocked() { return Date.now() < adminUntil; }

/** ポリシーを保存(同期中はチーム全体へ) */
async function savePolicy(next) {
  store.data.policy = { ...(store.data.policy || {}), ...next, updatedAt: Date.now(), updatedBy: settings().userName };
  applyPolicyParams();
  store.save();
  if (sync && sync.enabled()) await sync.setDoc('meta/policy', store.data.policy);
  pushUpdate();
}

/** 私用判定(A+B+C)。私用ならその理由、仕事なら null */
function privateReason(now, key, fg, day) {
  const p = pol();
  if ((settings().privateUntil || 0) > now) return 'mode';                // C) 私用モード
  if (day && meetingsLib.openMeeting(day.calendar)) return null;          // 社内会議を記録中は仕事(明示操作を優先)
  if (policyLib.privateAppHit(fg, p)) return 'app';                       // B) 私用アプリ・サイト
  if (policyLib.inWorkWindow(now, key, p)) return null;                   // 勤務時間帯は従来どおり
  // A) 時間外・休日は「仕事の証拠」がある時だけ稼働
  return hasWorkEvidence(now, key, fg, day) ? null : 'offhours';
}

/** 仕事の証拠: 仕事用アプリ / AIツール / 会議 / 案件の判定 / 案件フォルダの更新 */
function hasWorkEvidence(now, key, fg, day) {
  const p = pol();
  if (policyLib.isWorkApp(fg, p) || isAiFg(fg) || isMeetingFg(fg)) return true;
  const cal = dayCalendar(day, key);
  if (isMeetingCal(cal, now)) return true;
  if (projectsLib.classify({ title: (fg && fg.title) || '', calendar: cal, now, projects: store.data.projects })) return true;
  if (recentFolderHit && now - recentFolderHit.ts <= (settings().folderStickyMin || 30) * 60000) return true;
  return false;
}

/**
 * 勤務時間内でも「仕事の証拠がない稼働」が60分以上続いた区間を記録(マウス自動操作ツール等の検知)。
 * 前面ウィンドウを取得できる時(タイトル判定オン)だけ判定する。勤怠からは差し引かず、管理者に表示する。
 */
const NO_EVIDENCE_MIN = 60;
let noEv = null; // { s, e } 進行中の「証拠なし」区間
function trackNoEvidence(day, now, key, fg, counted) {
  const judgeable = counted && fg;
  if (judgeable && !hasWorkEvidence(now, key, fg, day)) {
    if (!noEv || now - noEv.e > settings().mergeGapMin * engine.MIN) noEv = { s: now, e: now };
    else noEv.e = now;
    if (noEv.e - noEv.s >= NO_EVIDENCE_MIN * 60000) {
      day.noEvidence = day.noEvidence || [];
      const last = day.noEvidence[day.noEvidence.length - 1];
      if (last && last.s === noEv.s) last.e = noEv.e;
      else { day.noEvidence.push({ s: noEv.s, e: noEv.e }); logEvent(day, `仕事の証拠がない操作が${NO_EVIDENCE_MIN}分以上続いています(${engine.fmtTime(noEv.s)}〜)`); }
      day.noEvidenceMin = Math.round(day.noEvidence.reduce((a, b) => a + (b.e - b.s) / 60000, 0));
    }
  } else if (counted) {
    noEv = null; // 証拠あり → 区間リセット(判定不能時は維持)
  }
}

/** みなし残業(既定45h)に対する当月の残業状況 */
function overtimeStatus(days = store.data.days) {
  const today = currentKey || engine.dayKey(Date.now(), settings().dayStartHour);
  const ym = today.slice(0, 7);
  const limitMin = (settings().minashiHours || 45) * 60;
  const ot = recoruLib.monthOvertime(days, ym, today);
  return { ...ot, ym, limitMin, level: recoruLib.overtimeLevel(ot, limitMin) };
}

/** 段階が上がったときだけ通知(月ごと・段階ごとに1回) */
function checkOvertime() {
  const st = overtimeStatus();
  if (st.level === 'ok') return;
  const s = settings();
  if (!s.otAlert || s.otAlert.ym !== st.ym) s.otAlert = { ym: st.ym, sent: [] };
  if (s.otAlert.sent.includes(st.level)) return;
  s.otAlert.sent.push(st.level);
  store.save();
  const h = (m) => engine.fmtDur(m);
  const msg = {
    pace: ['残業が多めのペースです', `今月の残業 ${h(st.overtimeMin)}。このペースだと月末に約${h(st.forecastMin)}となり、みなし残業${h(st.limitMin)}を超える見込みです。`],
    warn: ['みなし残業の80%に達しました', `今月の残業 ${h(st.overtimeMin)} / ${h(st.limitMin)}。月末予測 ${h(st.forecastMin)}。`],
    over: ['⚠ みなし残業を超えました', `今月の残業 ${h(st.overtimeMin)} がみなし残業${h(st.limitMin)}を超えています。上長に相談してください。`]
  }[st.level];
  notify(msg[0], msg[1]);
}

function logEvent(day, msg) {
  day.events.push({ t: Date.now(), msg });
  if (day.events.length > 200) day.events.shift();
}

function persistInterval(day) {
  if (!currentInterval) return;
  const last = day.intervals[day.intervals.length - 1];
  if (last && last.s === currentInterval.s) last.e = currentInterval.e;
  else day.intervals.push({ ...currentInterval });
}

/** この端末の利用者ID(チーム未設定時の予定作成者ID)。初回に生成して保存 */
function localUserId() {
  const s = settings();
  if (!s.localUserId) { s.localUserId = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); store.save(); }
  return s.localUserId;
}
/** 予定の作成者情報: チーム同期中はそのチームの memberId、未設定ならローカルID */
function calCreator() {
  const sy = settings().sync || {};
  const id = (sy.enabled && sy.memberId) || localUserId();
  const used = settings().calCreatorIds = settings().calCreatorIds || [];
  if (!used.includes(id)) used.push(id); // チーム脱退後も自分の予定を本人として扱えるよう記録
  return { id, name: settings().userName };
}
/** 本人判定用: ローカルID + 参加した全チームの memberId(チーム参加前に作った予定も本人として編集できる) */
function calMe() {
  const s = settings();
  const ids = [localUserId(), (s.sync || {}).memberId, ...(s.teamProfiles || []).map(t => t.memberId), ...(s.calCreatorIds || [])].filter(Boolean);
  return { ids: [...new Set(ids)], name: s.userName };
}

/** ICSインポート分・突発の社内会議(記録中は終了=今) + 共有カレンダー(自分に関係する予定)を結合 */
function dayCalendar(day, key) {
  return [
    ...meetingsLib.forEngine(day.calendar, Date.now(), meetingsLib.MAX_MIN, SAMPLE_MS),
    ...calendarLib.eventsForEngine(store.data.calEvents, key, settings().userName, store.data.projects)
  ];
}

function reestimate(key) {
  const day = store.day(key);
  const prev = day.estimation;
  const calendar = dayCalendar(day, key);
  // 突発の社内会議がPC稼働の範囲の外へはみ出す分(会議から直帰した等)も勤務に含める
  const nowTs = Date.now();
  const spans = calendar.filter(meetingsLib.isAdhoc).map(ev => ({ s: ev.s, e: Math.min(ev.e, nowTs) }));
  const extra = meetingsLib.extraIntervals(spans, day.intervals);
  day.estimation = engine.estimate(
    { ...day, intervals: [...(day.intervals || []), ...extra], calendar }, store.data.rules, settings());
  if (!prev && day.estimation.start) logEvent(day, `始業を検知(${engine.fmtTime(day.estimation.start)} PC稼働)`);
  return day.estimation;
}

function pushUpdate() {
  if (win && !win.isDestroyed()) win.webContents.send('state:update', buildState());
}

/**
 * 1日分を確定。
 * @param stale true = アプリ終了・再起動などで「記録中」のまま残っていた過去日(自動提出しない)
 */
function finalizeDay(key, stale = false) {
  const day = store.day(key);
  if (day.status !== 'recording') return;
  autoCloseMeeting(day, key, '日付が変わったため自動終了'); // 念のため(通常は closeStaleMeetings で終了済み)
  reestimate(key);
  day.status = 'pending';
  const est = day.estimation;
  const conf = est ? est.confidence : 'LOW';
  // 休日・長時間・後から確定した日は、人が確認してから提出する(誤った値をそのまま提出しない)
  const reasons = recoruLib.reviewReasons(key, est, { longMin: settings().reviewLongMin || 720 });
  if (stale) reasons.push('記録中のまま残っていた日');
  day.reviewReasons = reasons;
  if (est && est.start && !reasons.length && engine.shouldAutoSubmit(settings().submitMode, conf)) {
    submitDay(key, true);
  }
  logEvent(day, `${stale ? '記録中のまま残っていた日を' : '本日分を'}確定(信頼度: ${conf}${reasons.length ? ' / 要確認: ' + reasons.join('・') : ''})`);
  if (est && est.start && !stale) {
    notify(
      day.status === 'submitted' ? '勤怠を自動提出しました' : '勤怠の確認をお願いします',
      `${key} ${engine.fmtTime(est.start)}〜${engine.fmtTime(est.end)} 実働${engine.fmtDur(est.workMin)}` +
      (day.status === 'submitted' ? '' : `(${reasons.length ? reasons.join('・') : '信頼度: ' + conf} — 履歴タブから確認して提出してください)`)
    );
  }
}

/** 今日より前で「記録中」のまま残っている日をすべて確定(アプリ終了・PC再起動で日付を跨いだ場合の取りこぼし対策) */
function finalizeStaleDays(todayKey) {
  const stale = Object.keys(store.data.days).filter(k => k < todayKey && store.data.days[k].status === 'recording');
  for (const k of stale) finalizeDay(k, true);
  if (stale.length) {
    store.save();
    notify('未確定の勤怠を確定しました', `${stale.length}日分が「記録中」のまま残っていました。履歴タブで確認して提出してください。`);
  }
}

/**
 * 推定ロジック修正(v0.12: マイルール/予定が空白全体を稼働扱いにしていた不具合)後の再計算。
 * 自動提出された日(承認前)だけを対象に、差が15分以上あれば「未提出」に戻して確認を促す。
 * 手動で提出・修正した日、承認済みの日は変更しない。
 */
function recheckAutoSubmitted() {
  if (settings().engineFixV12) return;
  let n = 0;
  for (const [key, day] of Object.entries(store.data.days)) {
    if (day.status !== 'submitted' || !day.submitted || !day.submitted.auto || day.correction) continue;
    const before = day.submitted.workMin || 0;
    const est = reestimate(key);
    if (!est || est.start == null || Math.abs((est.workMin || 0) - before) < 15) continue;
    day.status = 'pending';
    day.reviewReasons = ['推定ロジック修正で再計算'];
    logEvent(day, `推定ロジックの修正により再計算しました(実働 ${engine.fmtDur(before)} → ${engine.fmtDur(est.workMin)})。確認して再提出してください`);
    n++;
  }
  settings().engineFixV12 = true;
  store.save();
  if (n) notify('勤怠を再計算しました', `マイルールの適用範囲の不具合を修正し、自動提出済みの${n}日分を再計算しました。履歴タブで確認して再提出してください。`);
}

function submitDay(key, auto = false) {
  const day = store.day(key);
  const est = day.correction || day.estimation;
  if (!est || est.start == null) return { ok: false, error: '提出できる推定結果がありません' };
  day.status = 'submitted';
  day.submittedAt = Date.now();
  delete day.reviewReasons;
  // 本人修正で実働が30分以上増えた場合は総管理者の承認が必要(承認までは集計にPCログの推定値を使う)
  const delta = day.correction && day.estimation ? Math.round((day.correction.workMin || 0) - (day.estimation.workMin || 0)) : 0;
  const needsApproval = delta >= 30;
  day.submitted = {
    start: est.start, end: est.end,
    workMin: est.workMin, breakMin: est.breakMin, auto,
    ...(day.correction ? { corrDeltaMin: delta } : {}),
    ...(needsApproval ? { needsApproval: true } : {})
  };
  if (needsApproval) {
    logEvent(day, `実働を${delta}分増やす修正のため、総管理者の承認待ちです(承認まではPCログの推定値で集計)`);
    notify('修正した勤怠は承認待ちです', `${key} 実働 +${engine.fmtDur(delta)} の修正は総管理者の承認後に反映されます。`);
  }
  logEvent(day, auto ? '自動提出しました' : '手動で提出しました');
  store.save();
  return { ok: true };
}

async function sample() {
  if (sampling) return;
  sampling = true;
  try {
    const now = Date.now();
    const idleSec = forcedIdle ? Infinity : powerMonitor.getSystemIdleTime();
    const inputActive = idleSec < settings().idleThresholdSec;
    const key = engine.dayKey(now, settings().dayStartHour);
    // 前面ウィンドウ(タイトル判定オン時のみ取得)。私用判定と案件判定の両方に使う
    const fg = inputActive ? await getForeground() : null;

    // 日付ロールオーバー: 前日を確定して自動提出判定
    if (currentKey && key !== currentKey) {
      const prev = store.day(currentKey);
      if (currentInterval) { persistInterval(prev); currentInterval = null; }
      flushUnclassified(prev);
      closeStaleMeetings(key, now, false); // 終了し忘れの社内会議は前日のうちに閉じる(翌日へまたがせない)
      finalizeDay(currentKey);
    }
    if (key !== currentKey) {
      if (!currentKey) closeStaleMeetings(key, now, true); // 起動直後: 前回から残っている社内会議を整理
      finalizeStaleDays(key); // 起動直後・日付変更時に取りこぼしを確定
    }
    currentKey = key;
    const day = store.day(key);

    // 私用判定: 私用モード / 私用アプリ / 時間外・休日で仕事の証拠なし → 稼働に数えない
    const why = inputActive ? privateReason(now, key, fg, day) : null;
    const active = inputActive && !why;
    if (why) {
      day.privateMin = (day.privateMin || 0) + SAMPLE_MIN;
      day.privateBy = day.privateBy || {};
      day.privateBy[why] = (day.privateBy[why] || 0) + SAMPLE_MIN;
      if (lastPrivateWhy !== why) logEvent(day, { mode: '私用モード中', app: '私用アプリ・サイトを検知', offhours: '時間外・休日で仕事の証拠がないため私用扱い' }[why] + `(${engine.fmtTime(now)}〜)`);
    }
    lastPrivateWhy = why;
    trackNoEvidence(day, now, key, fg, active);

    if (active) {
      if (currentInterval && now - currentInterval.e <= settings().mergeGapMin * engine.MIN) {
        currentInterval.e = now;
      } else {
        if (currentInterval) persistInterval(day);
        currentInterval = { s: now, e: now };
        if (day.intervals.length > 0) logEvent(day, `稼働を再検知(${engine.fmtTime(now)})`);
      }
      persistInterval(day);
    } else if (currentInterval && now - currentInterval.e > settings().mergeGapMin * engine.MIN) {
      persistInterval(day);
      currentInterval = null;
      logEvent(day, `操作の空白を検知(${engine.fmtTime(now)}〜)`);
    }

    // 案件トラッキング(オプトイン時のみ前面ウィンドウを参照)
    if (active && settings().trackWork) {
      trackWork(day, now, fg);
    } else if (!active) {
      flushUnclassified(day);
      currentWork = null;
      // 無操作(私用判定ではない)でも、案件外の予定中はPCを離れて会議・撮影している時間として区分に計上
      // (突発の社内会議を記録中は trackAdhocMeeting が計上するので二重に数えない)
      if (!inputActive && settings().trackWork && !meetingsLib.openMeeting(day.calendar)) addCategoryMin(day, now);
    }
    trackAdhocMeeting(day, now, active);

    reestimate(key);
    store.save();
    pushUpdate();
    updateTray();
  } finally { sampling = false; }
}

function startTracker() {
  sample();
  sampleTimer = setInterval(sample, SAMPLE_MS);
  powerMonitor.on('suspend', () => { forcedIdle = true; noteSystem('スリープを検知'); });
  powerMonitor.on('resume', () => { forcedIdle = false; noteSystem('復帰を検知'); sample(); });
  powerMonitor.on('lock-screen', () => { forcedIdle = true; noteSystem('画面ロックを検知'); });
  powerMonitor.on('unlock-screen', () => { forcedIdle = false; noteSystem('ロック解除を検知'); sample(); });
}

function noteSystem(msg) {
  if (!currentKey) return;
  logEvent(store.day(currentKey), msg);
}

// ---- 突発の社内会議(今日の勤務 / トレイの 開始・終了) -----------------------
// 記録は本人の day.calendar に {adhoc:true} の予定として保存(チーム共有カレンダーには載せない)。
// 記録中(open)は終了=今として推定エンジン・会議判定・区分計上に効く。詳細は src/meetings.js
const MEETING_MAX_MS = meetingsLib.MAX_MIN * 60000;

function todayKeyNow() { return currentKey || engine.dayKey(Date.now(), settings().dayStartHour); }
/** 今日の記録中の社内会議(日データを新規作成しない) */
function todayOpenMeeting() {
  const d = store && store.data.days[todayKeyNow()];
  return d ? meetingsLib.openMeeting(d.calendar) : null;
}
function meetingProject(mt) {
  return mt.projectId ? store.data.projects.find(p => p.id === mt.projectId) || null : null;
}
function meetingLabel(mt) {
  const p = meetingProject(mt);
  return p ? `社内会議[${p.code}]` : '社内会議';
}

/**
 * この会議のために計上した分数を delta 分だけ増減(削除・時刻修正用)。減らすのは計上済みの分まで。
 * 計上先: 会議時間(meetingMin) と、案件(projectMin) または 社内会議（案件外）(categoryMin.internal)
 */
function adjustMeetingCredit(day, mt, delta) {
  const c = mt.credit = mt.credit || { meetingMin: 0, min: 0 };
  const dm = Math.max(-c.meetingMin, delta);
  c.meetingMin += dm;
  day.meetingMin = Math.max(0, (day.meetingMin || 0) + dm);
  const db = Math.max(-c.min, delta);
  c.min += db;
  const p = meetingProject(mt);
  if (p) {
    day.projectMin = day.projectMin || {};
    day.projectMin[p.id] = Math.max(0, (day.projectMin[p.id] || 0) + db);
  } else {
    day.categoryMin = day.categoryMin || {};
    day.categoryMin.internal = Math.max(0, (day.categoryMin.internal || 0) + db);
  }
}

/** 会議を end で終了して記録。1分未満は記録せず取り消す。記録したエントリ(取り消し時は null)を返す */
function closeMeeting(day, mt, end, how) {
  mt.e = Math.max(mt.s, end);
  delete mt.open; delete mt.seenAt;
  if (!meetingsLib.recordable(mt.s, mt.e)) {
    adjustMeetingCredit(day, mt, -Infinity);
    day.calendar = (day.calendar || []).filter(ev => ev !== mt);
    logEvent(day, `${meetingLabel(mt)}(${engine.fmtTime(mt.s)}〜)は${meetingsLib.MIN_RECORD_MIN}分未満のため記録しませんでした`);
    return null;
  }
  const min = Math.round((mt.e - mt.s) / 60000);
  logEvent(day, `${meetingLabel(mt)} ${engine.fmtTime(mt.s)}〜${engine.fmtTime(mt.e)}（${min}分）を記録${how ? `(${how})` : ''}`);
  return mt;
}

/** 終了し忘れの会議を「もっともらしい時刻」(開始+上限 / 最後の記録・稼働 / 勤務日の終わり の早い方)で閉じる */
function autoCloseMeeting(day, key, how) {
  const mt = meetingsLib.openMeeting(day.calendar);
  if (!mt) return null;
  const end = meetingsLib.plausibleEnd(mt, day.intervals, meetingsLib.dayBounds(key, settings().dayStartHour).end);
  return { mt, rec: closeMeeting(day, mt, end, how) };
}

/**
 * 起動直後・日付変更時: 記録中のまま残った社内会議を閉じる。
 * 今日の会議は、アップデート等の短い再起動(最後の記録から RESUME_GRACE_MIN 分以内)なら継続する。
 */
function closeStaleMeetings(todayKey, now, startup) {
  const closed = [];
  for (const [k, d] of Object.entries(store.data.days)) {
    const mt = meetingsLib.openMeeting(d.calendar);
    if (!mt || k > todayKey) continue;
    if (k === todayKey) {
      if (!startup) continue;
      if (now - (mt.seenAt || mt.s) <= meetingsLib.RESUME_GRACE_MIN * 60000 && now - mt.s < MEETING_MAX_MS) {
        logEvent(d, `${meetingLabel(mt)}(${engine.fmtTime(mt.s)}〜)の記録を継続します(アプリ再起動)`);
        continue;
      }
    }
    const r = autoCloseMeeting(d, k, k === todayKey ? 'アプリ再起動のため自動終了' : '日付が変わったため自動終了');
    if (k !== todayKey && d.status !== 'recording') reestimate(k); // 確定済みの日も推定を更新(記録中の日は確定処理で再計算)
    if (r && r.rec) closed.push(r.rec);
  }
  if (closed.length) {
    const m = closed[0];
    notify('社内会議を自動で終了しました',
      `終了し忘れの社内会議を ${engine.fmtTime(m.s)}〜${engine.fmtTime(m.e)} として記録しました。実際と違う場合は修正してください。`);
    store.save();
    if (tray) buildTrayMenu();
  }
}

/** サンプルごと: 記録中の会議の時間を会議・区分(または選んだ案件)に計上。上限を超えたら自動終了 */
function trackAdhocMeeting(day, now, active) {
  const mt = meetingsLib.openMeeting(day.calendar);
  if (!mt) return;
  if (now - mt.s >= MEETING_MAX_MS) {
    const rec = closeMeeting(day, mt, mt.s + MEETING_MAX_MS, `${meetingsLib.MAX_MIN / 60}時間を超えたため自動終了`);
    if (rec) notify('社内会議を自動で終了しました',
      `${engine.fmtTime(rec.s)}に開始した社内会議が${meetingsLib.MAX_MIN / 60}時間を超えたため、${engine.fmtTime(rec.e)}で終了として記録しました。実際の終了時刻と違う場合は「今日の勤務」で修正してください。`);
    buildTrayMenu();
    return;
  }
  mt.seenAt = now;
  const c = mt.credit = mt.credit || { meetingMin: 0, min: 0 };
  const s = settings();
  if (active && s.trackWork) {
    // trackWork() が予定(会議・社内会議区分/案件)として計上済み。会議に入った分だけ控えておく
    // (画面のタイトル等で別の案件が判定された分は、その案件の作業として計上される = 案件優先のルール)
    if (s.detectMeetings === false) day.meetingMin = (day.meetingMin || 0) + SAMPLE_MIN; // 明示の会議は設定に関係なく会議時間に含める
    c.meetingMin += SAMPLE_MIN;
    const w = currentWork;
    if (w && (mt.projectId ? w.projectId === mt.projectId : w.category === 'internal')) c.min += SAMPLE_MIN;
    return;
  }
  // 無操作(会議室などでPCを離れている)/ 案件トラッキングがオフ → ここで計上
  day.meetingMin = (day.meetingMin || 0) + SAMPLE_MIN;
  c.meetingMin += SAMPLE_MIN;
  const p = meetingProject(mt);
  if (p) {
    day.projectMin[p.id] = (day.projectMin[p.id] || 0) + SAMPLE_MIN;
    if (!active) currentWork = { projectId: p.id, code: p.code, name: p.name, via: 'calendar', app: '' };
  } else {
    day.categoryMin = day.categoryMin || {};
    day.categoryMin.internal = (day.categoryMin.internal || 0) + SAMPLE_MIN;
    if (!active) currentWork = { projectId: null, category: 'internal', app: '' };
  }
  c.min += SAMPLE_MIN;
}

function afterMeetingChange(key) {
  reestimate(key);
  store.save();
  buildTrayMenu(); updateTray(); pushUpdate();
}

/** 開始(今の時刻)。projectId を選んだ場合はその案件の会議として計上 */
function startMeeting(projectId) {
  const now = Date.now();
  const key = todayKeyNow();
  const day = store.day(key);
  day.calendar = day.calendar || [];
  const cur = meetingsLib.openMeeting(day.calendar);
  if (cur) return { ok: false, error: `社内会議はすでに記録中です(${engine.fmtTime(cur.s)}〜)` };
  let p = null;
  if (projectId) {
    p = store.data.projects.find(x => x.id === projectId && x.active !== false && (x.status || 'active') === 'active');
    if (!p) return { ok: false, error: '選んだ案件が見つかりません(削除・納品完了の可能性があります)' };
  }
  if ((settings().privateUntil || 0) > now) { // 会議 = 仕事なので私用モードは終了
    settings().privateUntil = 0;
    logEvent(day, '私用モードを解除(社内会議を開始)');
  }
  const mt = meetingsLib.createMeeting(now, p);
  day.calendar.push(mt);
  logEvent(day, `${meetingLabel(mt)}を開始(${engine.fmtTime(now)}〜)`);
  afterMeetingChange(key);
  return { ok: true, s: mt.s };
}

/** 終了(今の時刻)。記録した時間帯を返す */
function endMeeting() {
  const key = todayKeyNow();
  const day = store.data.days[key];
  const mt = day && meetingsLib.openMeeting(day.calendar);
  if (!mt) return { ok: false, error: '記録中の社内会議はありません' };
  const rec = closeMeeting(day, mt, meetingsLib.effectiveEnd(mt, Date.now()), '');
  afterMeetingChange(key);
  return rec ? { ok: true, recorded: true, s: rec.s, e: rec.e, min: Math.round((rec.e - rec.s) / 60000) } : { ok: true, recorded: false };
}

/** 今日の会議だけ、本人が削除/時刻修正できる */
function findTodayMeeting(key, id) {
  if (key !== todayKeyNow()) return { error: '修正・削除できるのは今日の社内会議だけです(過去の日は履歴タブの「修正」を使ってください)' };
  const day = store.data.days[key];
  const mt = day && (day.calendar || []).find(ev => meetingsLib.isAdhoc(ev) && ev.id === id);
  if (!mt) return { error: '社内会議の記録が見つかりません' };
  return { day, mt };
}
function deleteMeeting(key, id) {
  const f = findTodayMeeting(key, id);
  if (f.error) return { ok: false, error: f.error };
  const { day, mt } = f;
  adjustMeetingCredit(day, mt, -Infinity);
  day.calendar = day.calendar.filter(ev => ev !== mt);
  logEvent(day, `${meetingLabel(mt)} ${engine.fmtTime(mt.s)}〜${mt.open ? '(記録中)' : engine.fmtTime(mt.e)} の記録を削除`);
  afterMeetingChange(key);
  return { ok: true };
}
function updateMeeting(key, id, sMin, eMin) {
  const f = findTodayMeeting(key, id);
  if (f.error) return { ok: false, error: f.error };
  const { day, mt } = f;
  if (mt.open) return { ok: false, error: '記録中の会議は「社内会議 終了」を押してから修正してください' };
  const v = meetingsLib.validateEdit(key, sMin, eMin, Date.now(), settings().dayStartHour);
  if (v.error) return { ok: false, error: v.error };
  const before = `${engine.fmtTime(mt.s)}〜${engine.fmtTime(mt.e)}`;
  // 長さの差分だけ 会議時間・区分(案件) の計上も増減(短くする場合は計上済みの分まで)
  adjustMeetingCredit(day, mt, Math.round((v.e - v.s) / 60000) - Math.round((mt.e - mt.s) / 60000));
  mt.s = v.s; mt.e = v.e;
  logEvent(day, `${meetingLabel(mt)}の時刻を修正(${before} → ${engine.fmtTime(mt.s)}〜${engine.fmtTime(mt.e)})`);
  afterMeetingChange(key);
  return { ok: true };
}

// ---- Firebaseチーム同期(複数チーム対応) --------------------------------
function activeProfile() {
  const s = settings();
  return (s.teamProfiles || []).find(t => t.id === s.activeTeamId) || null;
}

/** アクティブなチームプロファイルを settings.sync に反映(同期モジュールはsyncを参照) */
function applyActiveProfile() {
  const s = settings();
  const p = activeProfile();
  s.sync = p
    ? { enabled: true, projectId: p.projectId, apiKey: p.apiKey, teamId: p.teamId, memberId: p.memberId }
    : { enabled: false, projectId: '', apiKey: '', teamId: '', memberId: '' };
}

function syncCfg() {
  const s = settings().sync || {};
  return {
    ...s, userName: settings().userName, recoruUserId: settings().recoruUserId || '',
    appVersion: app.getVersion(), platform: process.platform, arch: process.arch
  };
}

/** 招待コード(base64のJSON)を作成/解析 */
function makeInvite(p) {
  const payload = { v: 1, label: p.label, projectId: p.projectId, apiKey: p.apiKey, teamId: p.teamId };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}
function parseInvite(code) {
  try {
    const o = JSON.parse(Buffer.from(String(code).trim(), 'base64').toString('utf8'));
    if (!o.projectId || !o.apiKey || !o.teamId) return null;
    return { label: o.label || o.teamId, projectId: o.projectId, apiKey: o.apiKey, teamId: o.teamId };
  } catch (e) { return null; }
}

/** チームを切り替え(前チームのリモート情報を破棄して再同期) */
async function switchTeam(id) {
  settings().activeTeamId = id || '';
  applyActiveProfile();
  store.data.remoteTeam = null;
  teamStatsCache = [];
  if (sync) { sync._tok = null; sync.status = { state: 'idle', lastSync: null, error: null, members: 0, auth: 'none' }; }
  store.save();
  pushUpdate();
  if (sync && sync.enabled()) return runSync();
  return { ok: true };
}

async function runSync(force) {
  if (!sync || !sync.enabled()) return { ok: false, error: 'チーム同期が未設定です' };
  if (runSync.busy) return { ok: false, error: '同期中です' };
  // 無料枠の上限に当たった直後はしばらく待機(手動「今すぐ同期」時はforceで即試行)
  if (!force && runSync.quotaUntil && Date.now() < runSync.quotaUntil) {
    return { ok: false, error: '無料枠の上限のため待機中', quota: true };
  }
  runSync.busy = true;
  sync.status.state = 'syncing';
  pushUpdate();
  try {
    // 1) 案件マスターをマージ(コード基準でユニオン。idはチームで統一される)
    for (const p of store.data.projects) p.updatedAt = p.updatedAt || p.createdAt || Date.now();
    const localByCode = {};
    for (const p of store.data.projects) {
      const c = String(p.code || '').trim().toUpperCase();
      if (c) localByCode[c] = p.id;
    }
    const merged = await sync.syncProjects(store.data.projects);
    // コード同一でidが変わった案件は、工数/予定/学習の参照を新idへ付け替え(データ保全)
    const remapTo = {}; // 旧id -> 新idの集合
    for (const m of merged) {
      const c = String(m.code || '').trim().toUpperCase();
      const oldId = c ? localByCode[c] : null;
      if (oldId && oldId !== m.id) (remapTo[oldId] = remapTo[oldId] || new Set()).add(m.id);
    }
    const remap = {}, ambiguous = {};
    for (const [oid, set] of Object.entries(remapTo)) {
      if (set.size === 1) remap[oid] = [...set][0];
      else ambiguous[oid] = [...set]; // 1つの旧idが複数案件に分かれた → 根拠で付け替え/要確認へ
    }
    if (Object.keys(remap).length) {
      for (const d of Object.values(store.data.days)) {
        if (!d.projectMin) continue;
        for (const [oid, nid] of Object.entries(remap)) {
          if (d.projectMin[oid] != null) {
            d.projectMin[nid] = (d.projectMin[nid] || 0) + d.projectMin[oid];
            delete d.projectMin[oid];
          }
        }
      }
      for (const ev of store.data.calEvents || []) {
        if (ev.projectId && remap[ev.projectId]) ev.projectId = remap[ev.projectId];
      }
      const ls = store.data.learnStats;
      if (ls && ls.totals) for (const [oid, nid] of Object.entries(remap)) {
        if (ls.totals[oid] != null) { ls.totals[nid] = (ls.totals[nid] || 0) + ls.totals[oid]; delete ls.totals[oid]; }
      }
    }
    store.data.projects = merged.map(p => ({ keywords: [], active: true, ...p }));
    if (Object.keys(ambiguous).length) {
      const r = store.repairIdCollisions(ambiguous);
      if (r && r.review) notify('案件工数の確認をお願いします', `案件IDの重複を修復しました。${r.review}分の工数は案件タブの「要確認の工数」で振り分けてください。`);
    }
    // 2) 共有カレンダーをマージ(変化があるときだけ書き込む)
    const remoteCal = (await sync.getDoc('meta/calendar')) || { events: [] };
    store.data.calEvents = calendarLib.mergeEvents(store.data.calEvents, remoteCal.events || []);
    if (sync._changed('calendar', store.data.calEvents)) {
      await sync.setDoc('meta/calendar', { events: store.data.calEvents, updatedAt: Date.now() });
    }
    // 3) 自分の勤怠サマリー・学習統計をpush
    await sync.pushSummary(store.data.days, null, store.data.rules);
    await sync.pushDict(store.data.learnStats);
    // 3) チーム全体をpull
    const pulled = await sync.pullAll();
    teamStatsCache = pulled.teamStats;
    // 会社ポリシー: チームにあれば採用。無く端末側に総管理者設定があれば初回だけチームへ登録
    const remotePolicy = await sync.getDoc('meta/policy');
    if (remotePolicy) store.data.policy = remotePolicy;
    else if (store.data.policy && store.data.policy.adminHash) await sync.setDoc('meta/policy', store.data.policy);
    applyPolicyParams();
    // チーム共有のスプレッドシート書き出し先(未設定ならnull)
    const teamSheets = await sync.getDoc('meta/sheets');
    store.data.remoteTeam = { members: pulled.members, pulledAt: Date.now(), sheets: teamSheets };
    // 4) 自分宛の承認/差し戻しを反映
    for (const [k, v] of Object.entries(pulled.myReview)) {
      if (k === 'updatedAt') continue;
      const d = store.data.days[k];
      if (!d) continue;
      if (v === 'approved' && d.status === 'submitted') {
        d.status = 'approved'; logEvent(d, '管理者が承認しました(同期)');
        notify('勤怠が承認されました', `${k} の勤怠が承認されました`);
      }
      if (v === 'rejected' && d.status !== 'rejected') {
        d.status = 'rejected'; logEvent(d, '管理者が差し戻しました(同期)');
        notify('勤怠が差し戻されました', `${k} の勤怠を確認して再提出してください`);
      }
    }
    sync.status.state = 'ok';
    sync.status.lastSync = Date.now();
    sync.status.error = null;
    runSync.quotaUntil = 0;
    checkBudgets();
    store.save();
    pushUpdate();
    maybeAutoExport(); // チーム共有の書き出し設定を初めて受け取った直後にも前月分を出す
    return { ok: true, members: pulled.members.length };
  } catch (e) {
    sync.status.state = 'error';
    sync.status.error = String(e.message || e).slice(0, 200);
    // 無料枠の上限(429)に当たったら翌日の朝まで自動待機(無駄な再試行で枠を消費しない)
    if (e && e.quota) {
      runSync.quotaUntil = Date.now() + 6 * 60 * 60 * 1000; // 6時間待機
      notify('チーム同期を一時停止しました', 'Firebase無料枠の1日の上限に達したため、しばらく同期を控えます。翌日の上限リセットで自動回復します。');
    }
    pushUpdate();
    return { ok: false, error: sync.status.error };
  } finally { runSync.busy = false; }
}

// ---- Googleスプレッドシート書き出し ------------------------------------
const STATUS_LABEL = { recording: '記録中', pending: '未提出', submitted: '提出済み', approved: '承認済み', rejected: '差し戻し' };

/**
 * 実際に使う書き出し設定。チームで共有された設定(Firestore meta/sheets)があればそれを優先し、
 * 無ければこの端末だけの設定を使う。
 */
function sheetsConfig() {
  const s = settings();
  const team = store.data.remoteTeam && store.data.remoteTeam.sheets;
  if (team && team.url) {
    return { url: team.url, token: team.token || '', autoExport: !!team.autoExport, shared: true, by: team.updatedBy || '' };
  }
  return { url: s.sheetsUrl, token: s.sheetsToken, autoExport: !!s.autoExportSheets, shared: false, by: '' };
}

/** 指定月(YYYY-MM)の「自分の」履歴・工数を個人タブへ書き出し(チーム集計タブはGASが再構成) */
async function exportSheets(ym) {
  const cfg = sheetsConfig();
  if (!cfg.url) return { ok: false, error: 'スプレッドシート連携URLが未設定です' };
  const me = { name: settings().userName, days: store.data.days };
  const projById = Object.fromEntries((store.data.projects || []).map(p => [p.id, p]));
  const { sheets, summaries } = sheetsLib.personalExport(me, ym, projById, (st) => STATUS_LABEL[st] || st);
  const res = await sheetsLib.post(cfg.url, cfg.token, sheets, summaries);
  const r = { ok: true, months: [ym], historyRows: sheets[0].rows.length, reportRows: sheets[1].rows.length };
  if (!res || res.v !== sheetsLib.GAS_VERSION) {
    r.warning = 'スプレッドシート側のGASスクリプトが古いため、チーム全員分のタブが更新されません。設定画面の最新スクリプトに貼り替えて再デプロイしてください。';
  }
  return r;
}

function prevMonthKey(d = new Date()) {
  const m = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
}

/** 毎月の自動書き出し: 前月分を1回だけ書き出す(月初〜いつ起動しても取りこぼさない) */
async function maybeAutoExport() {
  const s = settings();
  const cfg = sheetsConfig();
  if (!cfg.autoExport || !cfg.url) return;
  const target = prevMonthKey();
  if (s.lastExportMonth === target) return; // 済み
  try {
    await exportSheets(target);
    s.lastExportMonth = target;
    store.save(); pushUpdate();
    notify('スプレッドシートへ自動書き出し', `${target} の履歴・工数レポートを書き出しました。`);
  } catch (e) {
    console.error('auto export error', e);
  }
}

// ---- 状態のシリアライズ -----------------------------------------------
/**
 * 他メンバーの勤怠詳細は総管理者モードの間だけ画面へ渡す。
 * ロック中は案件の工数(projectMin)だけ渡す(案件の消化状況・予算アラートに必要なため)。
 */
function gatedRemoteTeam() {
  const rt = store.data.remoteTeam;
  if (!rt || adminUnlocked()) return rt;
  return {
    ...rt,
    members: (rt.members || []).map(m => ({
      id: m.id, name: m.name,
      days: Object.fromEntries(Object.entries(m.days || {}).map(([k, d]) => [k, { projectMin: d.projectMin || {} }]))
    }))
  };
}

/** 要確認の工数を「旧ID×候補」ごとにまとめる(全期間) */
function reviewItems() {
  const groups = {};
  for (const [key, d] of Object.entries(store.data.days)) {
    for (const r of d.reviewMin || []) {
      const g = groups[r.from + '|' + r.candidates.join(',')] =
        groups[r.from + '|' + r.candidates.join(',')] || { from: r.from, candidates: r.candidates, total: 0, days: [] };
      g.total += r.min;
      g.days.push({ key, min: r.min });
    }
  }
  const byId = Object.fromEntries(store.data.projects.map(p => [p.id, p]));
  return Object.values(groups).map(g => ({
    ...g,
    days: g.days.sort((a, b) => a.key.localeCompare(b.key)),
    candidates: g.candidates.map(id => byId[id]).filter(Boolean).map(p => ({ id: p.id, code: p.code, name: p.name }))
  }));
}

function buildState() {
  const days = {};
  const keys = Object.keys(store.data.days).sort().slice(-62);
  for (const k of keys) days[k] = store.data.days[k];
  return {
    settings: settings(),
    todayKey: currentKey || engine.dayKey(Date.now(), settings().dayStartHour),
    days,
    rules: store.data.rules,
    projects: store.data.projects,
    calEvents: (() => { const me = calMe(); return (store.data.calEvents || []).filter(ev => !ev.deleted)
      .map(ev => ({ ...ev, canEdit: calendarLib.canEdit(ev, me) })); })(),
    currentWork,
    learnN: store.data.learnStats ? store.data.learnStats.n : 0,
    team: store.data.team,
    remoteTeam: gatedRemoteTeam(),
    sheetsConfig: sheetsConfig(),
    reviewItems: reviewItems(),
    overtime: overtimeStatus(),
    policy: (() => { const p = pol(); return { params: p.params, workStartMin: p.workStartMin, workEndMin: p.workEndMin, workApps: p.workApps, privateApps: p.privateApps, updatedBy: p.updatedBy || '', updatedAt: p.updatedAt || 0 }; })(),
    adminConfigured: !!pol().adminHash,
    adminUnlocked: adminUnlocked(),
    adminUntil,
    privateUntil: settings().privateUntil || 0,
    meetingMaxMin: meetingsLib.MAX_MIN,
    appVersion: app.getVersion(),
    update: updateState,
    holidays: [...recoruLib.HOLIDAYS],
    folderStatus: folderStatus(),
    gasScript: sheetsLib.gasScript(sheetsConfig().token),
    syncReady: !!(sync && sync.enabled()),
    syncStatus: sync ? sync.status : null,
    teamProfiles: (settings().teamProfiles || []).map(t => ({ id: t.id, label: t.label, teamId: t.teamId, projectId: t.projectId })),
    activeTeamId: settings().activeTeamId || '',
    screenPermission: screenPermission(),
    watchRoots: settings().watchRoots || [],
    watchStatus: watcher ? watcher.status() : { mode: 'idle', roots: 0, lastHitAt: 0 },
    recording: !!currentInterval,
    platform: process.platform,
    arch: process.arch
  };
}

// ---- ウィンドウ / トレイ ------------------------------------------------
function createWindow() {
  // 画面の作業領域に合わせて大きめに開く(13インチMacBook ≒1440x900 でも収まる)
  let width = 1280, height = 840;
  try {
    const wa = screen.getPrimaryDisplay().workAreaSize;
    width = Math.max(960, Math.min(1400, Math.round(wa.width * 0.92)));
    height = Math.max(640, Math.min(920, Math.round(wa.height * 0.92)));
  } catch (e) { /* 取得できない場合は既定値 */ }
  win = new BrowserWindow({
    width, height, minWidth: 960, minHeight: 640, center: true,
    title: '全自動勤怠管理くん',
    backgroundColor: '#f5f7f6',
    icon: path.join(__dirname, 'assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'renderer/index.html'));
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); } // 常駐して記録継続
  });
}

function updateTray() {
  if (!tray) return;
  const day = currentKey ? store.day(currentKey) : null;
  const est = day && day.estimation;
  if (settings().privateUntil && settings().privateUntil <= Date.now()) {
    settings().privateUntil = 0;
    if (currentKey) logEvent(store.day(currentKey), '私用モードが終了しました(自動)');
    buildTrayMenu();
  }
  const status = (settings().privateUntil || 0) > Date.now() ? '私用モード' : todayOpenMeeting() ? '社内会議中' : currentInterval ? '記録中' : '待機中';
  tray.setToolTip(`全自動勤怠管理くん ${status}` + (est && est.start ? ` | ${engine.fmtTime(est.start)}〜 稼働 ${engine.fmtDur(est.workMin)}` : ''));
}

// ---- 自動アップデート(GitHub Releases / electron-updater) ----------------
// 新しい版を見つけたら裏でダウンロードし、PCを10分以上使っていない時(または画面ロック中・アプリ終了時)に
// 自動で入れ替えて再起動する。作業中に突然再起動しないよう、操作中はインストールしない。
let updater = null;
const updateState = { status: 'idle', version: null, error: null, checkedAt: 0 };
function installUpdateNow() {
  if (!updater || updateState.status !== 'downloaded') return;
  try {
    if (currentKey && currentInterval) persistInterval(store.day(currentKey));
    store.save();
  } catch (_) {}
  quitting = true;
  updater.quitAndInstall(true, true); // サイレントで入れ替え → 自動で再起動
}
function setupAutoUpdater() {
  if (!app.isPackaged) return; // 開発中(npm start)は無効
  try { updater = require('electron-updater').autoUpdater; } catch (e) { return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('checking-for-update', () => { updateState.status = 'checking'; updateState.checkedAt = Date.now(); });
  updater.on('update-not-available', () => { updateState.status = 'latest'; pushUpdate(); });
  updater.on('update-available', (info) => { updateState.status = 'downloading'; updateState.version = info.version; pushUpdate(); });
  updater.on('error', (err) => { updateState.status = 'error'; updateState.error = String((err && err.message) || err).slice(0, 200); pushUpdate(); });
  updater.on('update-downloaded', (info) => {
    updateState.status = 'downloaded'; updateState.version = info.version;
    buildTrayMenu(); pushUpdate();
    notify('アップデートの準備ができました', `v${info.version} をダウンロードしました。PCを使っていない時に自動で更新・再起動します(作業は中断されません)。`);
  });
  const check = () => updater.checkForUpdates().catch(() => {});
  setTimeout(check, 20 * 1000);
  setInterval(check, 3 * 60 * 60 * 1000);
  // ダウンロード済みなら、操作していない時に入れ替える
  setInterval(() => {
    if (updateState.status !== 'downloaded') return;
    let idle = 0; try { idle = powerMonitor.getSystemIdleTime(); } catch (_) {}
    if (forcedIdle || idle >= 10 * 60) installUpdateNow();
  }, 60 * 1000);
}

// ---- 過去の工数の復元(ファイルの更新時刻から) ----------------------------
/**
 * roots 以下の「CODE_名称」フォルダ内で、[fromTs, toTs) に更新されたファイルの {t, path} を集める。
 * ファイルの中身は読まない(パスと更新時刻のみ)。案件フォルダの外のファイルは stat もしない。
 */
async function scanFileTimes(roots, fromTs, toTs) {
  const fsp = fs.promises;
  const SKIP = /^(\.|node_modules$|__MACOSX$|\$RECYCLE\.BIN$|System Volume Information$)/;
  const out = [];
  let visited = 0;
  const walk = async (dir, depth, inCase) => {
    if (depth > 10 || visited > 400000) return;
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      visited++;
      if (SKIP.test(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1, inCase || /^[A-Z]+\d+_/.test(e.name));
      else if (inCase && e.isFile()) {
        try {
          const st = await fsp.stat(full);
          const t = st.mtimeMs;
          if (t >= fromTs && t < toTs) out.push({ t, path: full });
        } catch (_) {}
      }
    }
  };
  for (const r of roots) {
    if (!r || !fs.existsSync(r)) continue;
    await walk(r, 0, !!restoreLib.codeInPath(r));
  }
  return { files: out, visited };
}

let restoreCache = null; // { ym, rootsKey, plan, files }
async function restorePlan(ym, roots) {
  const [y, m] = ym.split('-').map(Number);
  const from = new Date(y, m - 1, 1).getTime() - 3600000;   // 前後1時間の余裕(月初・月末の継続計上用)
  const to = new Date(y, m, 1).getTime() + 3600000 + settings().dayStartHour * 3600000;
  const { files, visited } = await scanFileTimes(roots, from, to);
  const saves = restoreLib.savesFromFiles(files);
  const p = restoreLib.plan({ days: store.data.days, saves, projects: store.data.projects, ym, stickyMin: settings().folderStickyMin || 30 });
  restoreCache = { ym, rootsKey: roots.join('\n'), plan: p };
  const byId = Object.fromEntries(store.data.projects.map(x => [x.id, x]));
  return {
    ok: true, ym, files: saves.length, visited,
    beforeMin: p.beforeMin, addMin: p.addMin, days: p.days,
    byProject: Object.entries(p.byProject).sort((a, b) => b[1] - a[1])
      .map(([pid, min]) => ({ code: (byId[pid] || {}).code || pid, name: (byId[pid] || {}).name || '', min })),
    unregistered: Object.entries(p.unregistered).sort((a, b) => b[1] - a[1]).map(([code, min]) => ({ code, min })),
    alreadyRestored: Object.entries(store.data.days).some(([k, d]) => k.slice(0, 7) === ym && d.restoredMin)
  };
}

/** 私用モードを minutes 分オン(0で解除) */
function setPrivate(minutes) {
  const s = settings();
  const day = currentKey ? store.day(currentKey) : null;
  if (minutes > 0) {
    // 私用モード = 仕事ではない → 記録中の社内会議は今の時刻で終了
    const mt = day && meetingsLib.openMeeting(day.calendar);
    if (mt) { closeMeeting(day, mt, meetingsLib.effectiveEnd(mt, Date.now()), '私用モードを開始したため終了'); reestimate(currentKey); }
    s.privateUntil = Date.now() + minutes * 60000;
    if (day) logEvent(day, `私用モードを開始(${engine.fmtTime(s.privateUntil)}まで)`);
  } else {
    s.privateUntil = 0;
    if (day) logEvent(day, '私用モードを解除');
  }
  store.save(); buildTrayMenu(); pushUpdate();
}

function buildTrayMenu() {
  if (!tray) return;
  const until = settings().privateUntil || 0;
  const on = until > Date.now();
  const mt = todayOpenMeeting();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '全自動勤怠管理くんを開く', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    on
      ? { label: `私用モード中(${engine.fmtTime(until)}まで)— 解除する`, click: () => setPrivate(0) }
      : { label: '私用モード(この間は記録しない)', submenu: [30, 60, 120, 240].map(m => ({ label: `${m < 60 ? m + '分' : m / 60 + '時間'}`, click: () => setPrivate(m) })) },
    mt
      ? { label: `社内会議を終了(${engine.fmtTime(mt.s)}〜)`, click: () => {
        const r = endMeeting();
        if (r.ok) notify('社内会議を終了しました', r.recorded ? `${engine.fmtTime(r.s)}〜${engine.fmtTime(r.e)}(${r.min}分)を勤務として記録しました。` : '1分未満のため記録しませんでした。');
      } }
      : { label: '社内会議を開始', click: () => {
        const r = startMeeting(null);
        if (r.ok) notify('社内会議を開始しました', `終わったらトレイメニューか「今日の勤務」の「社内会議 終了」を押してください(${meetingsLib.MAX_MIN / 60}時間で自動終了)。`);
        else notify('社内会議を開始できません', r.error);
      } },
    { type: 'separator' },
    { label: '今日の分を今すぐ提出', click: () => { if (currentKey) { submitDay(currentKey); pushUpdate(); } } },
    ...(updateState.status === 'downloaded'
      ? [{ type: 'separator' }, { label: `今すぐ v${updateState.version} に更新して再起動`, click: installUpdateNow }] : []),
    { type: 'separator' },
    { label: `終了(v${app.getVersion()})`, click: () => { quitting = true; app.quit(); } }
  ]));
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets/tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
  buildTrayMenu();
  tray.on('click', () => { win.show(); win.focus(); });
  updateTray();
}

// ---- IPC ----------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('state:get', () => buildState());

  ipcMain.handle('settings:update', (e, patch) => {
    patch = { ...patch };
    // 検知パラメータは会社ポリシーで固定(総管理者モードでも、ここではなくポリシー保存で変更する)
    for (const k of Object.keys(policyLib.DEFAULT_PARAMS)) delete patch[k];
    delete patch.privateUntil;
    delete patch.localUserId; delete patch.calCreatorIds; // 予定の本人判定に使うIDは画面から変更させない
    Object.assign(store.data.settings, patch);
    if ('autoLaunch' in patch) {
      try { app.setLoginItemSettings({ openAtLogin: !!patch.autoLaunch }); } catch (_) {}
    }
    if ('watchRoots' in patch) startWatcher();
    if (currentKey) reestimate(currentKey);
    store.save();
    return buildState();
  });

  // フォルダ監視の対象フォルダを選択(署名不要・アクセシビリティ不要)
  ipcMain.handle('watch:addRoot', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '案件フォルダが並んでいる親フォルダを選択',
      properties: ['openDirectory']
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
    const roots = new Set(settings().watchRoots || []);
    roots.add(res.filePaths[0]);
    settings().watchRoots = [...roots];
    folderScan.at = 0; // 次回の点検で再走査
    startWatcher();
    store.save(); pushUpdate();
    return { ok: true, state: buildState() };
  });
  // C) 私用モード(minutes=0で解除)
  // 過去の工数の復元(当月より前の月のみ)
  ipcMain.handle('restore:preview', async (e, { ym, roots }) => {
    const cur = (currentKey || engine.dayKey(Date.now(), settings().dayStartHour)).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym || '') || ym >= cur) return { ok: false, error: '復元できるのは先月以前の月です' };
    const list = (roots && roots.length ? roots : settings().watchRoots || []).filter(r => fs.existsSync(r));
    if (!list.length) return { ok: false, error: '案件フォルダが見つかりません。フォルダを選択してください(外付けドライブ・NASは接続してから)' };
    try { return await restorePlan(ym, list); } catch (err) { return { ok: false, error: String(err.message || err).slice(0, 200) }; }
  });
  ipcMain.handle('restore:apply', async (e, { ym, roots }) => {
    const list = (roots && roots.length ? roots : settings().watchRoots || []).filter(r => fs.existsSync(r));
    if (!restoreCache || restoreCache.ym !== ym || restoreCache.rootsKey !== list.join('\n')) {
      return { ok: false, error: '先にプレビューを実行してください' };
    }
    const n = restoreLib.apply(store.data.days, ym, restoreCache.plan);
    const day = store.day(currentKey || engine.dayKey(Date.now(), settings().dayStartHour));
    logEvent(day, `${ym} の工数をファイル記録から復元しました(+${engine.fmtDur(n)})`);
    restoreCache = null;
    store.save(); pushUpdate();
    if (sync && sync.enabled()) runSync();
    return { ok: true, addMin: n, state: buildState() };
  });
  ipcMain.handle('restore:undo', (e, { ym }) => {
    const n = restoreLib.undo(store.data.days, ym);
    if (n) logEvent(store.day(currentKey || engine.dayKey(Date.now(), settings().dayStartHour)), `${ym} の復元した工数を取り消しました(-${engine.fmtDur(n)})`);
    store.save(); pushUpdate();
    if (sync && sync.enabled()) runSync();
    return { ok: true, removedMin: n, state: buildState() };
  });
  ipcMain.handle('restore:pickFolder', async () => {
    const res = await dialog.showOpenDialog(win, { title: '案件フォルダが入っているフォルダを選択', properties: ['openDirectory', 'multiSelections'] });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('update:install', () => { installUpdateNow(); return { ok: true }; });
  ipcMain.handle('private:set', (e, minutes) => { setPrivate(minutes); return buildState(); });
  // 突発の社内会議(開始/終了/削除/時刻修正)。記録は本人の day.calendar のみ(チーム共有カレンダーには載せない)
  ipcMain.handle('meeting:start', (e, { projectId } = {}) => ({ ...startMeeting(projectId || null), state: buildState() }));
  ipcMain.handle('meeting:end', () => ({ ...endMeeting(), state: buildState() }));
  ipcMain.handle('meeting:delete', (e, { key, id } = {}) => ({ ...deleteMeeting(key, id), state: buildState() }));
  ipcMain.handle('meeting:update', (e, { key, id, sMin, eMin } = {}) => ({ ...updateMeeting(key, id, sMin, eMin), state: buildState() }));

  // 総管理者
  ipcMain.handle('admin:setup', async (e, password) => {
    if (pol().adminHash) return { ok: false, error: '総管理者パスワードは設定済みです' };
    if (String(password || '').length < 8) return { ok: false, error: 'パスワードは8文字以上にしてください' };
    const { hash, salt } = policyLib.hashPassword(password);
    try { await savePolicy({ adminHash: hash, adminSalt: salt }); } catch (err) { return { ok: false, error: String(err.message || err) }; }
    adminUntil = Date.now() + ADMIN_SESSION_MS;
    return { ok: true, state: buildState() };
  });
  ipcMain.handle('admin:unlock', (e, password) => {
    if (Date.now() < adminFails.until) return { ok: false, error: `入力の失敗が続いたため、${Math.ceil((adminFails.until - Date.now()) / 60000)}分後に再試行してください` };
    if (!policyLib.verifyPassword(password, pol())) {
      adminFails.n++;
      if (adminFails.n >= 5) { adminFails = { n: 0, until: Date.now() + 5 * 60000 }; }
      return { ok: false, error: 'パスワードが違います' };
    }
    adminFails = { n: 0, until: 0 };
    adminUntil = Date.now() + ADMIN_SESSION_MS;
    pushUpdate();
    return { ok: true, state: buildState() };
  });
  ipcMain.handle('admin:lock', () => { adminUntil = 0; pushUpdate(); return buildState(); });
  ipcMain.handle('admin:change', async (e, { oldPassword, newPassword }) => {
    if (!adminUnlocked() || !policyLib.verifyPassword(oldPassword, pol())) return { ok: false, error: '現在のパスワードが違います' };
    if (String(newPassword || '').length < 8) return { ok: false, error: 'パスワードは8文字以上にしてください' };
    const { hash, salt } = policyLib.hashPassword(newPassword);
    try { await savePolicy({ adminHash: hash, adminSalt: salt }); } catch (err) { return { ok: false, error: String(err.message || err) }; }
    return { ok: true, state: buildState() };
  });
  ipcMain.handle('admin:savePolicy', async (e, input) => {
    if (!adminUnlocked()) return { ok: false, error: '総管理者モードでのみ変更できます' };
    try { await savePolicy(policyLib.sanitize(input)); } catch (err) { return { ok: false, error: String(err.message || err) }; }
    adminUntil = Date.now() + ADMIN_SESSION_MS; // 操作したら延長
    return { ok: true, state: buildState() };
  });

  ipcMain.handle('folder:dismiss', (e, code) => {
    const s = settings();
    s.folderHintDismissed = [...new Set([...(s.folderHintDismissed || []), code])];
    store.save(); pushUpdate(); return buildState();
  });
  ipcMain.handle('watch:removeRoot', (e, root) => {
    settings().watchRoots = (settings().watchRoots || []).filter(r => r !== root);
    startWatcher();
    store.save(); pushUpdate();
    return buildState();
  });

  // ユーザー修正(HITL): 修正を保存し、差分からマイルール候補を返す
  ipcMain.handle('day:correct', (e, { key, correction }) => {
    const day = store.day(key);
    const proposals = engine.diffToRuleProposals(day.estimation, correction);
    const workMin = Math.max(0, (correction.end - correction.start) / engine.MIN -
      (correction.breaks || []).reduce((a, b) => a + (b.e - b.s) / engine.MIN, 0));
    day.correction = { ...correction, workMin: Math.round(workMin), correctedAt: Date.now() };
    if (day.status === 'submitted' || day.status === 'approved') day.status = 'pending';
    logEvent(day, '勤怠を手動修正しました');
    store.save();
    pushUpdate();
    return { proposals, state: buildState() };
  });

  ipcMain.handle('rules:add', (e, rule) => {
    if (rule && rule.treatAs === 'work' && engine.ruleSpan(rule) > engine.MAX_WORK_RULE_MIN) {
      return { ...buildState(), error: `「稼働扱い」のルールは${engine.MAX_WORK_RULE_MIN}分以内にしてください(長い不在を稼働に見せかけることを防ぐため)` };
    }
    store.addRule(rule);
    if (currentKey) reestimate(currentKey);
    store.save(); pushUpdate();
    return buildState();
  });
  ipcMain.handle('rules:toggle', (e, id) => {
    const r = store.data.rules.find(r => r.id === id);
    if (r) r.enabled = !r.enabled;
    if (currentKey) reestimate(currentKey);
    store.save(); pushUpdate();
    return buildState();
  });
  ipcMain.handle('rules:delete', (e, id) => {
    store.data.rules = store.data.rules.filter(r => r.id !== id);
    if (currentKey) reestimate(currentKey);
    store.save(); pushUpdate();
    return buildState();
  });

  ipcMain.handle('day:submit', (e, key) => { const r = submitDay(key); pushUpdate(); return r; });

  // 案件マスター CRUD(コード形式: 大文字英字+数字。例 F000, T123)
  ipcMain.handle('projects:add', (e, p) => {
    const code = String(p.code || '').trim();
    if (!projectsLib.CODE_FORMAT.test(code)) {
      return { error: '案件コードは「大文字英字+数字」(例: F000, T123)で入力してください' };
    }
    if (store.data.projects.some(x => x.code === code)) {
      return { error: `案件コード ${code} は既に登録されています` };
    }
    store.addProject({ ...p, code });
    pushUpdate(); return buildState();
  });
  ipcMain.handle('projects:update', (e, { id, patch }) => {
    const p = store.data.projects.find(p => p.id === id);
    if (p) { Object.assign(p, patch); delete p.keywordsReview; p.updatedAt = Date.now(); }
    store.save(); pushUpdate(); return buildState();
  });
  ipcMain.handle('projects:delete', (e, id) => {
    store.data.projects = store.data.projects.filter(p => p.id !== id);
    store.save(); pushUpdate(); return buildState();
  });

  // レコル取込用CSV(提出・承認済みの日のみ)。範囲 [from,to] は YYYY-MM-DD
  ipcMain.handle('recoru:csv', (e, { from, to }) => {
    const rows = [recoruLib.IMPORT_HEADERS];
    // 名前 = 表示名、ユーザID = レコルのユーザID(未設定なら空欄。メモに「ユーザID未設定」が付く)
    const add = (name, uid, days) => {
      for (const k of Object.keys(days).sort()) {
        if (k < from || k > to) continue;
        const d = days[k];
        if (!['submitted', 'approved'].includes(d.status)) continue;
        const est = recoruLib.recordOf(d);
        if (!est || est.start == null) continue;
        const reasons = recoruLib.reviewReasons(k, est, { longMin: settings().reviewLongMin || 720 });
        rows.push(recoruLib.importRow(name, uid, k, est, ['全自動勤怠管理くん', ...reasons].join(' / ')));
      }
    };
    add(settings().userName, (settings().recoruUserId || '').trim(), store.data.days);
    const myId = (settings().sync || {}).memberId;
    for (const m of ((store.data.remoteTeam && store.data.remoteTeam.members) || [])) {
      if (m.id !== myId) add(m.name, (m.recoruUserId || '').trim(), m.days || {});
    }
    return { rows: rows.length - 1, csv: recoruLib.toCSV(rows) };
  });

  // 勤怠履歴CSV(履歴タブ)。本人の全日付から [from,to](YYYY-MM-DD、空なら制限なし)を出力。
  // レンダラーは直近62日しか持たないため、メインプロセスで全データから作る
  ipcMain.handle('history:csv', (e, { from, to } = {}) => {
    const data = recoruLib.historyRows(store.data.days, { from: from || '', to: to || '', statusLabel: STATUS_LABEL });
    const csv = recoruLib.toCSV([recoruLib.HISTORY_HEADERS, ...data]);
    const keyOf = (r) => r[0].replace(/\//g, '-');
    return {
      rows: data.length, csv, name: settings().userName || '',
      from: from || (data.length ? keyOf(data[0]) : ''), to: to || (data.length ? keyOf(data[data.length - 1]) : '')
    };
  });

  // 要確認の工数(ID衝突修復で振り分けできなかった分)を案件へ割り当て
  // keys: 対象日の配列, from: 旧ID → 該当する要確認をまとめて projectId へ
  ipcMain.handle('review:resolve', (e, { keys, from, projectId }) => {
    if (!store.data.projects.some(p => p.id === projectId)) return buildState();
    let total = 0;
    for (const key of keys || []) {
      const day = store.data.days[key];
      if (!day || !day.reviewMin) continue;
      day.reviewMin = day.reviewMin.filter(r => {
        if (r.from !== from || !r.candidates.includes(projectId)) return true;
        day.projectMin[projectId] = (day.projectMin[projectId] || 0) + r.min;
        total += r.min;
        return false;
      });
      if (!day.reviewMin.length) delete day.reviewMin;
    }
    const p = store.data.projects.find(p => p.id === projectId);
    if (total && p) logEvent(store.day(currentKey || engine.dayKey(Date.now(), settings().dayStartHour)), `要確認の工数 ${total}分を「${p.code} ${p.name}」に振り分けました`);
    store.save(); pushUpdate();
    if (sync && sync.enabled()) runSync();
    return buildState();
  });

  // 未分類ブロックを案件に割り当て(HITL: キーワード学習+動向学習)
  ipcMain.handle('day:assign', (e, { key, idx, projectId, keywords }) => {
    const day = store.day(key);
    const b = day.unclassified[idx];
    if (b && projectId) {
      day.projectMin[projectId] = (day.projectMin[projectId] || 0) + Math.round((b.e - b.s) / engine.MIN);
      day.unclassified.splice(idx, 1);
      if (curUnc && curUnc.s === b.s) curUnc = null;
      const p = store.data.projects.find(p => p.id === projectId);
      if (p) {
        for (const k of (keywords || [])) {
          if (k && !p.keywords.includes(k)) p.keywords.push(k);
        }
        p.updatedAt = Date.now();
        logEvent(day, `未分類の作業を「${p.name}」に割り当てました` +
          ((keywords || []).length ? `(キーワード学習: ${keywords.join(', ')})` : ''));
      }
      // 手動割り当ては強い教師信号として動向学習
      learnLib.learn(store.data.learnStats, {
        tokens: b.tokens || [], ts: Math.round((b.s + b.e) / 2), projectId, weight: 3
      });
      store.save();
    }
    pushUpdate(); return buildState();
  });

  // Firebaseチーム同期
  ipcMain.handle('sync:now', async () => {
    const r = await runSync(true); // 手動同期は待機を無視して即実行
    return { ...r, state: buildState() };
  });

  // Googleスプレッドシート書き出し
  ipcMain.handle('sheets:save', (e, patch) => {
    Object.assign(settings(), patch);
    store.save(); pushUpdate();
    return buildState();
  });
  // チームで書き出し先を共有/解除(meta/sheets)。同期中の全メンバーに次回同期で反映される
  ipcMain.handle('sheets:share', async (e, cfg) => {
    if (!adminUnlocked()) return { ok: false, error: 'チーム共有の変更は総管理者モードで行ってください(管理者ビューでロック解除)' };
    if (!sync || !sync.enabled()) return { ok: false, error: '先にチーム同期を設定してください' };
    try {
      const doc = cfg
        ? { url: String(cfg.url || '').trim(), token: String(cfg.token || '').trim(), autoExport: !!cfg.autoExport }
        : { url: '', token: '', autoExport: false };
      if (cfg && !/^https:\/\/script\.google\.com\/.+\/exec$/.test(doc.url)) {
        return { ok: false, error: '連携URLは https://script.google.com/…/exec の形式で入力してください' };
      }
      await sync.setDoc('meta/sheets', { ...doc, updatedBy: settings().userName, updatedAt: Date.now() });
      await runSync(true);
      return { ok: true, state: buildState() };
    } catch (err) { return { ok: false, error: String(err.message || err).slice(0, 200) }; }
  });
  ipcMain.handle('sheets:export', async (e, ym) => {
    try {
      const r = await exportSheets(ym || prevMonthKey());
      return r;
    } catch (err) { return { ok: false, error: String(err.message || err).slice(0, 200) }; }
  });

  // 複数チーム管理
  ipcMain.handle('team:add', (e, { label, projectId, apiKey, teamId, activate }) => {
    if (!projectId || !apiKey || !teamId) return { ok: false, error: 'Project ID / API Key / チームID を入力してください' };
    const s = settings();
    const prof = {
      id: 'tp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      label: (label || teamId).trim(),
      projectId: projectId.trim(), apiKey: apiKey.trim(), teamId: teamId.trim(),
      memberId: 'm' + Math.random().toString(36).slice(2, 10)
    };
    s.teamProfiles.push(prof);
    store.save();
    if (activate !== false) { switchTeam(prof.id); }
    else { pushUpdate(); }
    return { ok: true, id: prof.id, state: buildState() };
  });

  ipcMain.handle('team:join', (e, code) => {
    const inv = parseInvite(code);
    if (!inv) return { ok: false, error: '招待コードが正しくありません' };
    const s = settings();
    // 同じ projectId+teamId の重複参加は既存を有効化
    const dup = s.teamProfiles.find(t => t.projectId === inv.projectId && t.teamId === inv.teamId);
    if (dup) { switchTeam(dup.id); return { ok: true, id: dup.id, dup: true, state: buildState() }; }
    const prof = {
      id: 'tp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      label: inv.label, projectId: inv.projectId, apiKey: inv.apiKey, teamId: inv.teamId,
      memberId: 'm' + Math.random().toString(36).slice(2, 10)
    };
    s.teamProfiles.push(prof);
    store.save();
    switchTeam(prof.id);
    return { ok: true, id: prof.id, state: buildState() };
  });

  ipcMain.handle('team:switch', async (e, id) => {
    const r = await switchTeam(id);
    return { ...r, state: buildState() };
  });

  ipcMain.handle('team:remove', (e, id) => {
    const s = settings();
    s.teamProfiles = s.teamProfiles.filter(t => t.id !== id);
    if (s.activeTeamId === id) { switchTeam(''); }
    else { store.save(); pushUpdate(); }
    return buildState();
  });

  ipcMain.handle('team:invite', (e, id) => {
    const p = settings().teamProfiles.find(t => t.id === id);
    return p ? makeInvite(p) : null;
  });

  ipcMain.handle('team:rename', (e, { id, label }) => {
    const p = settings().teamProfiles.find(t => t.id === id);
    if (p) { p.label = String(label || '').trim() || p.teamId; applyActiveProfile(); store.save(); pushUpdate(); }
    return buildState();
  });

  // 共有カレンダー(編集・削除は登録者本人のみ。UIだけでなくここでも検証する)
  ipcMain.handle('cal:add', (e, ev) => {
    const f = calendarLib.sanitizeInput(ev, store.data.projects.map(p => p.id));
    if (f.error) return { ok: false, error: f.error };
    store.data.calEvents.push(calendarLib.createEvent(f, calCreator()));
    if (currentKey) reestimate(currentKey);
    store.save(); pushUpdate();
    return buildState();
  });
  ipcMain.handle('cal:update', (e, { id, patch }) => {
    const idx = store.data.calEvents.findIndex(ev => ev.id === id && !ev.deleted);
    if (idx < 0) return { ok: false, error: '予定が見つかりません(削除された可能性があります)' };
    const cur = store.data.calEvents[idx];
    if (!calendarLib.canEdit(cur, calMe())) return { ok: false, error: '予定を修正できるのは登録者本人だけです' };
    const f = calendarLib.sanitizeInput({ ...cur, ...(patch || {}) }, store.data.projects.map(p => p.id));
    if (f.error) return { ok: false, error: f.error };
    store.data.calEvents[idx] = calendarLib.applyEdit(cur, f, calCreator());
    if (currentKey) reestimate(currentKey);
    store.save(); pushUpdate();
    return buildState();
  });
  ipcMain.handle('cal:delete', (e, id) => {
    const ev = store.data.calEvents.find(ev => ev.id === id);
    // 削除も登録者本人のみ(作成者不明の旧データ整理用に、総管理者モード中は削除可)
    if (ev && !calendarLib.canEdit(ev, calMe()) && !adminUnlocked()) {
      return { ok: false, error: '予定を削除できるのは登録者本人だけです' };
    }
    if (ev) { ev.deleted = true; ev.updatedAt = Math.max(Date.now(), (ev.updatedAt || 0) + 1); ev.updatedBy = settings().userName; }
    if (currentKey) reestimate(currentKey);
    store.save(); pushUpdate();
    return buildState();
  });
  ipcMain.handle('misc:openUrl', (e, url) => {
    if (/^https?:\/\//.test(String(url))) shell.openExternal(url);
    return true;
  });

  // フォルダから案件マスターを一括インポート(F599_案件名 形式のフォルダ名を読み取り)
  ipcMain.handle('projects:importFolder', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '案件フォルダが並んでいる親フォルダを選択',
      properties: ['openDirectory']
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
    let added = 0, skipped = 0;
    try {
      for (const ent of fs.readdirSync(res.filePaths[0], { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const m = ent.name.match(/^([A-Z]+\d+)_(.+)$/);
        if (!m) continue;
        const code = m[1], name = m[2].trim();
        if (store.data.projects.some(p => p.code === code)) { skipped++; continue; }
        store.addProject({ code, name, keywords: [name] });
        added++;
      }
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
    store.save(); pushUpdate();
    return { ok: true, added, skipped };
  });

  // macOS権限まわり(画面収録のみ。アクセシビリティは使用しません)
  ipcMain.handle('perm:openSettings', (e, pane) => {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?' + (pane || 'Privacy_ScreenCapture'));
    return true;
  });
  ipcMain.handle('app:relaunch', () => {
    quitting = true;
    app.relaunch();
    app.exit(0);
  });

  // ICSインポート(カレンダー連携)
  ipcMain.handle('calendar:import', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'カレンダー(.ics)をインポート',
      filters: [{ name: 'iCalendar', extensions: ['ics'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
    const events = engine.parseICS(fs.readFileSync(res.filePaths[0], 'utf8'));
    let count = 0;
    for (const ev of events) {
      const key = engine.dayKey(ev.s, settings().dayStartHour);
      const day = store.day(key);
      if (!day.calendar.some(x => x.s === ev.s && x.e === ev.e)) { day.calendar.push(ev); count++; }
      day.estimation = engine.estimate(day, store.data.rules, settings());
    }
    store.save(); pushUpdate();
    return { ok: true, count };
  });

  // 管理者: 承認 / 差し戻し(本人・同期メンバー・デモメンバー)
  ipcMain.handle('team:setStatus', async (e, { memberId, dateKey, status }) => {
    if (!adminUnlocked()) return buildState(); // 承認/差し戻しは総管理者モードのみ
    if (memberId === 'self') {
      const day = store.day(dateKey);
      day.status = status;
      logEvent(day, status === 'approved' ? '管理者が承認しました' : '管理者が差し戻しました');
    } else if (store.data.remoteTeam &&
               store.data.remoteTeam.members.some(m => m.id === memberId)) {
      // 同期メンバー: Firestoreのreviewsに書き、相手のアプリが次回pullで反映
      const m = store.data.remoteTeam.members.find(m => m.id === memberId);
      if (m.days[dateKey]) m.days[dateKey].status = status; // 手元の表示も即時更新
      if (sync && sync.enabled()) {
        try { await sync.pushReview(memberId, dateKey, status); } catch (err) { /* 次回同期で再試行可 */ }
      }
    } else if (store.data.team) {
      const m = store.data.team.members.find(m => m.id === memberId);
      if (m && m.days[dateKey]) m.days[dateKey].status = status;
    }
    store.save(); pushUpdate();
    return buildState();
  });

  ipcMain.handle('demo:reseed', () => {
    store.data.team = seedTeam();
    store.save(); pushUpdate();
    return buildState();
  });
}

// ---- ライフサイクル -------------------------------------------------------
app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  if (!store.data.team) store.data.team = seedTeam();
  applyPolicyParams(); store.save();
  registerIpc();
  createWindow();
  createTray();
  startTracker();
  startWatcher();
  setTimeout(recheckAutoSubmitted, 3000);
  setupAutoUpdater();
  setTimeout(() => { checkFolders(); checkOvertime(); }, 60 * 1000);
  setInterval(() => { checkFolders(); checkOvertime(); }, 60 * 60 * 1000);
  if (store.lastRepair && store.lastRepair.review) {
    setTimeout(() => notify('案件工数の確認をお願いします',
      `案件IDの重複(同じ時間が複数案件に表示される不具合)を修復しました。${store.lastRepair.review}分の工数は案件タブの「要確認の工数」で振り分けてください。`), 8000);
  }
  applyActiveProfile();
  sync = new Sync(syncCfg);
  setInterval(() => { if (sync.enabled()) runSync(); }, 10 * 60 * 1000); // 無料枠節約のため10分間隔
  setTimeout(() => { if (sync.enabled()) runSync(); }, 10 * 1000);
  setTimeout(remindPending, 30 * 1000);
  setInterval(remindPending, 6 * 60 * 60 * 1000);
  setInterval(checkBudgets, 10 * 60 * 1000);
  // 月次の自動書き出し(起動30秒後 + 6時間ごとにチェック。前月分を1回だけ書き出す)
  setTimeout(maybeAutoExport, 30 * 1000);
  setInterval(maybeAutoExport, 6 * 60 * 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else win.show();
  });
});

app.on('before-quit', () => {
  quitting = true;
  if (sampleTimer) clearInterval(sampleTimer);
  if (watcher) watcher.stop();
  if (currentKey && currentInterval) persistInterval(store.day(currentKey));
  if (currentKey) flushUnclassified(store.day(currentKey));
  if (store) store.save();
});

app.on('window-all-closed', () => { /* トレイ常駐のため終了しない */ });
