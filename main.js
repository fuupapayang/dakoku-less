'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, powerMonitor, ipcMain, dialog, systemPreferences, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const Store = require('./src/store');
const engine = require('./src/engine');
const projectsLib = require('./src/projects');
const learnLib = require('./src/learn');
const calendarLib = require('./src/calendar');
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

/** macOSの画面収録権限。granted以外のときはactive-winを呼ばない(権限アラート連発防止) */
function screenPermission() {
  if (process.platform !== 'darwin') return 'granted';
  try { return systemPreferences.getMediaAccessStatus('screen'); } catch (e) { return 'unknown'; }
}

/**
 * 前面アプリで開いている書類のフルパス(macOSのみ)。
 * F599_xxx フォルダ内のファイルを開いていれば、パスに含まれるフォルダ名で案件判定できる。
 * アクセシビリティ権限が必要。失敗時は10分間リトライしない(プロンプト連発防止)。
 */
let axFailUntil = 0;
function axTrustedNow() {
  if (process.platform !== 'darwin') return false;
  try { return systemPreferences.isTrustedAccessibilityClient(false); } catch (e) { return false; }
}
function getDocPath() {
  return new Promise((resolve) => {
    // フォルダ判定が明示的にONで、かつ権限が許可済みのときだけ実行(既定では一切呼ばない)
    if (settings().folderDetect !== true) return resolve(null);
    if (process.platform !== 'darwin' || !axTrustedNow() || Date.now() < axFailUntil) return resolve(null);
    execFile('osascript', ['-e',
      'tell application "System Events" to tell (first application process whose frontmost is true) to get value of attribute "AXDocument" of front window'
    ], { timeout: 3000 }, (err, stdout) => {
      if (err) { axFailUntil = Date.now() + 10 * 60 * 1000; return resolve(null); }
      const out = String(stdout || '').trim();
      if (!out || out === 'missing value') return resolve(null);
      try { resolve(decodeURIComponent(out.replace(/^file:\/\//, ''))); }
      catch (e) { resolve(out); }
    });
  });
}

async function getForeground() {
  if (screenPermission() !== 'granted') return null; // 権限未反映の間は取得しない
  if (!activeWinTried) {
    activeWinTried = true;
    try { activeWinFn = require('active-win'); } catch (e) { activeWinFn = null; }
  }
  if (!activeWinFn) return null;
  try {
    const w = await activeWinFn();
    if (!w) return null;
    const docPath = await getDocPath();
    return { title: w.title || '', app: (w.owner && w.owner.name) || '', docPath };
  } catch (e) { return null; }
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

let lastLearnMin = 0;

function trackWork(day, now, fg) {
  const combinedCal = dayCalendar(day, day.date);
  // タイトル+書類パスを判定対象に(パスに F599_xxx フォルダが含まれれば案件判定される)
  const text = [fg && fg.title, fg && fg.docPath].filter(Boolean).join(' ');
  const hit = projectsLib.classify({
    title: text, calendar: combinedCal, now, projects: store.data.projects
  });
  if (hit) {
    day.projectMin[hit.id] = (day.projectMin[hit.id] || 0) + SAMPLE_MIN;
    currentWork = { projectId: hit.id, code: hit.code, name: hit.name, via: hit.via, app: fg ? fg.app : '' };
    flushUnclassified(day);
    // 確定判定から動向を弱く学習(1分に1回)
    const nowMin = Math.floor(now / 60000);
    if (fg && text && nowMin !== lastLearnMin) {
      lastLearnMin = nowMin;
      learnLib.learn(store.data.learnStats, {
        tokens: projectsLib.tokenize(text), ts: now, projectId: hit.id, weight: 1
      });
    }
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

/** ICSインポート分 + 共有カレンダー(自分に関係する予定)を結合 */
function dayCalendar(day, key) {
  return [
    ...(day.calendar || []),
    ...calendarLib.eventsForEngine(store.data.calEvents, key, settings().userName, store.data.projects)
  ];
}

function reestimate(key) {
  const day = store.day(key);
  const prev = day.estimation;
  day.estimation = engine.estimate(
    { ...day, calendar: dayCalendar(day, key) }, store.data.rules, settings());
  if (!prev && day.estimation.start) logEvent(day, `始業を検知(${engine.fmtTime(day.estimation.start)} PC稼働)`);
  return day.estimation;
}

function pushUpdate() {
  if (win && !win.isDestroyed()) win.webContents.send('state:update', buildState());
}

function finalizeDay(key) {
  const day = store.day(key);
  if (day.status !== 'recording') return;
  reestimate(key);
  day.status = 'pending';
  const conf = day.estimation ? day.estimation.confidence : 'LOW';
  if (day.estimation && day.estimation.start && engine.shouldAutoSubmit(settings().submitMode, conf)) {
    submitDay(key, true);
  }
  logEvent(day, `本日分を確定(信頼度: ${conf})`);
  const est = day.estimation;
  if (est && est.start) {
    notify(
      day.status === 'submitted' ? '勤怠を自動提出しました' : '勤怠の確認をお願いします',
      `${key} ${engine.fmtTime(est.start)}〜${engine.fmtTime(est.end)} 実働${engine.fmtDur(est.workMin)}` +
      (day.status === 'submitted' ? '' : `(信頼度: ${conf} — 履歴タブから提出してください)`)
    );
  }
}

function submitDay(key, auto = false) {
  const day = store.day(key);
  const est = day.correction || day.estimation;
  if (!est || est.start == null) return { ok: false, error: '提出できる推定結果がありません' };
  day.status = 'submitted';
  day.submittedAt = Date.now();
  day.submitted = {
    start: est.start, end: est.end,
    workMin: est.workMin, breakMin: est.breakMin, auto
  };
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
    const active = idleSec < settings().idleThresholdSec;
    const key = engine.dayKey(now, settings().dayStartHour);

    // 日付ロールオーバー: 前日を確定して自動提出判定
    if (currentKey && key !== currentKey) {
      const prev = store.day(currentKey);
      if (currentInterval) { persistInterval(prev); currentInterval = null; }
      flushUnclassified(prev);
      finalizeDay(currentKey);
    }
    currentKey = key;
    const day = store.day(key);

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
      trackWork(day, now, await getForeground());
    } else if (!active) {
      flushUnclassified(day);
      currentWork = null;
    }

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

// ---- Firebaseチーム同期 -------------------------------------------------
function syncCfg() {
  const s = settings().sync || {};
  return { ...s, userName: settings().userName };
}

async function runSync() {
  if (!sync || !sync.enabled()) return { ok: false, error: 'チーム同期が未設定です' };
  if (runSync.busy) return { ok: false, error: '同期中です' };
  runSync.busy = true;
  sync.status.state = 'syncing';
  pushUpdate();
  try {
    // 1) 案件マスターをマージ(キーワードはチームでユニオン)
    for (const p of store.data.projects) p.updatedAt = p.updatedAt || p.createdAt || Date.now();
    const merged = await sync.syncProjects(store.data.projects);
    store.data.projects = merged.map(p => ({ keywords: [], active: true, ...p }));
    // 2) 共有カレンダーをマージ
    const remoteCal = (await sync.getDoc('meta/calendar')) || { events: [] };
    store.data.calEvents = calendarLib.mergeEvents(store.data.calEvents, remoteCal.events || []);
    await sync.setDoc('meta/calendar', { events: store.data.calEvents, updatedAt: Date.now() });
    // 3) 自分の勤怠サマリー・学習統計をpush
    await sync.pushSummary(store.data.days);
    await sync.pushDict(store.data.learnStats);
    // 3) チーム全体をpull
    const pulled = await sync.pullAll();
    teamStatsCache = pulled.teamStats;
    store.data.remoteTeam = { members: pulled.members, pulledAt: Date.now() };
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
    checkBudgets();
    store.save();
    pushUpdate();
    return { ok: true, members: pulled.members.length };
  } catch (e) {
    sync.status.state = 'error';
    sync.status.error = String(e.message || e).slice(0, 200);
    pushUpdate();
    return { ok: false, error: sync.status.error };
  } finally { runSync.busy = false; }
}

// ---- 状態のシリアライズ -----------------------------------------------
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
    calEvents: (store.data.calEvents || []).filter(ev => !ev.deleted),
    currentWork,
    learnN: store.data.learnStats ? store.data.learnStats.n : 0,
    team: store.data.team,
    remoteTeam: store.data.remoteTeam,
    syncStatus: sync ? sync.status : null,
    screenPermission: screenPermission(),
    axTrusted: process.platform === 'darwin'
      ? (() => { try { return systemPreferences.isTrustedAccessibilityClient(false); } catch (e) { return false; } })()
      : true,
    recording: !!currentInterval,
    platform: process.platform
  };
}

// ---- ウィンドウ / トレイ ------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 900, minHeight: 600,
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
  const status = currentInterval ? '記録中' : '待機中';
  tray.setToolTip(`全自動勤怠管理くん ${status}` + (est && est.start ? ` | ${engine.fmtTime(est.start)}〜 稼働 ${engine.fmtDur(est.workMin)}` : ''));
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets/tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
  const menu = Menu.buildFromTemplate([
    { label: '全自動勤怠管理くんを開く', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: '今日の分を今すぐ提出', click: () => { if (currentKey) { submitDay(currentKey); pushUpdate(); } } },
    { type: 'separator' },
    { label: '終了', click: () => { quitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => { win.show(); win.focus(); });
  updateTray();
}

// ---- IPC ----------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('state:get', () => buildState());

  ipcMain.handle('settings:update', (e, patch) => {
    Object.assign(store.data.settings, patch);
    if ('autoLaunch' in patch) {
      try { app.setLoginItemSettings({ openAtLogin: !!patch.autoLaunch }); } catch (_) {}
    }
    // 注: アクセシビリティ許可のダイアログは自動では出さない。
    // 案件タブの「フォルダ判定を有効にする」ボタン(perm:requestAx)からのみ表示する。
    if (currentKey) reestimate(currentKey);
    store.save();
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
    if (p) { Object.assign(p, patch); p.updatedAt = Date.now(); }
    store.save(); pushUpdate(); return buildState();
  });
  ipcMain.handle('projects:delete', (e, id) => {
    store.data.projects = store.data.projects.filter(p => p.id !== id);
    store.save(); pushUpdate(); return buildState();
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
  ipcMain.handle('sync:save', (e, patch) => {
    const s = settings();
    s.sync = { ...s.sync, ...patch };
    if (s.sync.enabled && !s.sync.memberId) {
      s.sync.memberId = 'm' + Math.random().toString(36).slice(2, 10);
    }
    store.save(); pushUpdate();
    return buildState();
  });
  ipcMain.handle('sync:now', async () => {
    const r = await runSync();
    return { ...r, state: buildState() };
  });

  // 共有カレンダー
  ipcMain.handle('cal:add', (e, ev) => {
    store.data.calEvents.push({
      id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      date: ev.date, sMin: ev.sMin, eMin: ev.eMin,
      title: String(ev.title || '予定').slice(0, 80),
      projectId: ev.projectId || null,
      members: ev.members || [],
      createdBy: settings().userName,
      updatedAt: Date.now(), deleted: false
    });
    if (currentKey) reestimate(currentKey);
    store.save(); pushUpdate();
    return buildState();
  });
  ipcMain.handle('cal:delete', (e, id) => {
    const ev = store.data.calEvents.find(ev => ev.id === id);
    if (ev) { ev.deleted = true; ev.updatedAt = Date.now(); }
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

  // macOS権限まわり
  ipcMain.handle('perm:requestAx', () => {
    axFailUntil = 0;
    settings().folderDetect = true; // ボタン押下で明示的にオプトイン
    store.save();
    try { return systemPreferences.isTrustedAccessibilityClient(true); } catch (e) { return false; }
  });
  ipcMain.handle('perm:disableFolder', () => {
    settings().folderDetect = false;
    store.save(); pushUpdate();
    return buildState();
  });
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
  registerIpc();
  createWindow();
  createTray();
  startTracker();
  sync = new Sync(syncCfg);
  setInterval(() => { if (sync.enabled()) runSync(); }, 3 * 60 * 1000);
  setTimeout(() => { if (sync.enabled()) runSync(); }, 10 * 1000);
  setTimeout(remindPending, 30 * 1000);
  setInterval(remindPending, 6 * 60 * 60 * 1000);
  setInterval(checkBudgets, 10 * 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else win.show();
  });
});

app.on('before-quit', () => {
  quitting = true;
  if (sampleTimer) clearInterval(sampleTimer);
  if (currentKey && currentInterval) persistInterval(store.day(currentKey));
  if (currentKey) flushUnclassified(store.day(currentKey));
  if (store) store.save();
});

app.on('window-all-closed', () => { /* トレイ常駐のため終了しない */ });
