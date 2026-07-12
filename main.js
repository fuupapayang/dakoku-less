'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, powerMonitor, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('./src/store');
const engine = require('./src/engine');
const { seedTeam } = require('./src/demo');

let win = null;
let tray = null;
let store = null;
let quitting = false;

// ---- 稼働トラッカー(実データ検知) ------------------------------------
// powerMonitor.getSystemIdleTime() をポーリングして稼働区間を組み立てる。
// 生のサンプルはメモリ内のみ。永続化は「稼働区間(何時〜何時)」だけ。
const SAMPLE_MS = 15 * 1000;
let currentKey = null;
let currentInterval = null; // {s,e} 進行中の稼働区間
let sampleTimer = null;
let forcedIdle = false;     // スリープ/ロック中

function settings() { return store.data.settings; }

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

function reestimate(key) {
  const day = store.day(key);
  const prev = day.estimation;
  day.estimation = engine.estimate(day, store.data.rules, settings());
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

function sample() {
  const now = Date.now();
  const idleSec = forcedIdle ? Infinity : powerMonitor.getSystemIdleTime();
  const active = idleSec < settings().idleThresholdSec;
  const key = engine.dayKey(now, settings().dayStartHour);

  // 日付ロールオーバー: 前日を確定して自動提出判定
  if (currentKey && key !== currentKey) {
    if (currentInterval) { persistInterval(store.day(currentKey)); currentInterval = null; }
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

  reestimate(key);
  store.save();
  pushUpdate();
  updateTray();
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
    team: store.data.team,
    recording: !!currentInterval,
    platform: process.platform
  };
}

// ---- ウィンドウ / トレイ ------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 900, minHeight: 600,
    title: 'DakokuLess',
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
  tray.setToolTip(`DakokuLess ${status}` + (est && est.start ? ` | ${engine.fmtTime(est.start)}〜 稼働 ${engine.fmtDur(est.workMin)}` : ''));
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets/tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
  const menu = Menu.buildFromTemplate([
    { label: 'DakokuLess を開く', click: () => { win.show(); win.focus(); } },
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

  // 管理者: 承認 / 差し戻し(デモメンバー + 本人)
  ipcMain.handle('team:setStatus', (e, { memberId, dateKey, status }) => {
    if (memberId === 'self') {
      const day = store.day(dateKey);
      day.status = status;
      logEvent(day, status === 'approved' ? '管理者が承認しました' : '管理者が差し戻しました');
    } else {
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else win.show();
  });
});

app.on('before-quit', () => {
  quitting = true;
  if (sampleTimer) clearInterval(sampleTimer);
  if (currentKey && currentInterval) persistInterval(store.day(currentKey));
  if (store) store.save();
});

app.on('window-all-closed', () => { /* トレイ常駐のため終了しない */ });
