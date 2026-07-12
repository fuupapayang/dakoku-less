# DakokuLess — 打刻を、もう意識しない。

WorkOn for Desktop(β版)を参考にした、AIが勤務時間を自動推定する打刻レス勤怠デスクトップアプリ(Electron / Windows・macOS対応)。

## 機能

**従業員側**
- 打刻レス自動記録: `powerMonitor` でPCの実稼働(操作/アイドル/スリープ/画面ロック)を検知し、始業・休憩・終業を自動推定
- 信頼度判定: 安定 / 微妙 / 不安定 の3段階
- マイルール: 勤怠を修正するとAIが差分からルール候補を提案(HITL)。「マイルールに追加 / 今回だけ」を選択でき、以降の推定に自動適用
- カレンダー連携: .ics をインポートすると、会議中の無操作を稼働扱い、「移動」「外出」予定を対象外として提案
- 提出モード4段階: オート(全自動)/ ほどほど(不安定な日だけ手動)/ きっちり(安定した日のみ自動)/ マニュアル
- タイムライン表示、検知イベントログ、履歴からの修正・提出
- トレイ常駐(ウィンドウを閉じても記録継続)、ログイン時自動起動

**管理者側**
- メンバー勤怠一覧(日付切替)、承認 / 差し戻し
- 提出状況KPI、乖離アラート(提出とPCログの差30分超)
- ※ 本人以外のメンバーはデモデータ(設定から再生成可)

**プライバシー設計**
- 生の稼働サンプルはメモリ上のみで推論に利用し、即時破棄
- アプリ名・ウィンドウタイトル・入力内容は一切収集しない
- 永続化されるのは「何時から何時まで働いたか」の区間と推定結果のみ

## 実行方法

```bash
cd dakoku-less
npm install
npm start        # 起動
npm test         # 推定エンジンのユニットテスト
npm run dist:mac # macOS向けビルド(.dmg)
npm run dist:win # Windows向けビルド(.exe)
```

Node.js 18+ が必要です。データは Electron の userData ディレクトリに `dakoku-less-data.json` として保存されます。

## GitHubで配布(無料)

`.github/workflows/build.yml` により、`v*` タグを push すると GitHub Actions が
Windows(.exe)/macOS(.dmg) のインストーラーを自動ビルドし、Releases に添付します。

```bash
cd dakoku-less
git init && git add -A && git commit -m "initial commit"
git remote add origin https://github.com/<あなたのユーザー名>/dakoku-less.git
git push -u origin main

git tag v0.1.0
git push origin v0.1.0   # → Actionsがビルドし、Releasesページに配布物が並ぶ
```

※ 無料運用のためコード署名なしでビルドします。初回起動時に
macOSでは「右クリック→開く」、Windowsでは SmartScreen の「詳細情報→実行」が必要です。

## 構成

```
main.js              メインプロセス(稼働検知・トレイ・自動提出・IPC)
preload.js           contextBridge(安全なIPC公開)
src/engine.js        勤怠推定エンジン(区間結合・空白分類・ルール適用・信頼度・ICS)
src/store.js         JSON永続化
src/demo.js          管理者ビュー用デモチーム生成
renderer/            UI(今日の勤務・履歴・マイルール・設定・管理者ビュー)
test/engine.test.js  エンジンのユニットテスト(10件)
```

## 推定ロジック概要

1. 15秒ごとにシステムのアイドル秒数をサンプリング(閾値は設定可、既定90秒)
2. 稼働区間を結合(3分以内の空白は連続とみなす)
3. 空白を分類: マイルール → カレンダー予定 → ヒューリスティック(15分以上は休憩、11〜14時は昼休憩と推定)の優先順
4. 始業=最初の稼働、終業=最後の稼働。微妙な空白の数などから信頼度を判定
5. 日付切替(既定 深夜4時)で前日分を確定し、提出モードに応じて自動提出
