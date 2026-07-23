# macOS 署名・公証のセットアップ手順

未署名アプリは、最近のmacOS(Sequoia以降)で「マルウェア」としてブロックされます。
これを根本的に解消するには、Appleの **Developer ID による署名 + 公証(notarization)** が必要です。
アプリ側(electron-builder設定・公証フック・CIワークフロー)は準備済みなので、
以下の「あなたの作業」を行い、GitHubに5つのSecretを登録すれば、以降のビルドは自動で署名・公証されます。

所要時間の目安: Apple登録の審査待ちを除けば約30〜40分。

---

## 1. Apple Developer Program に登録(年 99 USD)

https://developer.apple.com/programs/enroll/ から登録します。
個人でも法人でも可。承認まで数時間〜2日程度かかることがあります。

登録後、**Team ID**(10桁の英数字)を控えます。
確認場所: https://developer.apple.com/account → 「Membership details」→ Team ID。
→ これが GitHub Secret の **APPLE_TEAM_ID** になります。

## 2. 「Developer ID Application」証明書を作る

Mac の「キーチェーンアクセス」または https://developer.apple.com/account/resources/certificates で作成します。

かんたんなのは Xcode 経由:
1. Xcode → Settings → Accounts に Apple ID を追加
2. チームを選択 → 「Manage Certificates…」→「＋」→ **Developer ID Application** を作成

作成後、「キーチェーンアクセス」アプリで、その証明書(秘密鍵付き)を書き出します:
1. 分類「自分の証明書」で「Developer ID Application: ...」を選択(▶で秘密鍵が下にぶら下がっている状態)
2. 右クリック →「"..."を書き出す」→ 形式 **個人情報交換(.p12)** で保存
3. 書き出し時に設定した**パスワード**を控える → GitHub Secret の **CSC_KEY_PASSWORD**

.p12 を Base64 に変換します(ターミナル):
```
base64 -i /path/to/証明書.p12 | pbcopy
```
これでクリップボードに入った文字列が GitHub Secret の **CSC_LINK** です。

## 3. App用パスワード(公証用)を作る

https://account.apple.com → サインイン → 「サインインとセキュリティ」→「Appパスワード」→「＋」
名前は「dakoku-notarize」などでOK。表示された `xxxx-xxxx-xxxx-xxxx` を控える。
→ GitHub Secret の **APPLE_APP_SPECIFIC_PASSWORD**
Apple IDのメールアドレス自体は GitHub Secret の **APPLE_ID**。

## 4. GitHub に 5 つの Secret を登録

リポジトリ → Settings → Secrets and variables → Actions → 「New repository secret」で登録:

| Secret 名 | 値 |
|---|---|
| `CSC_LINK` | .p12 を Base64 化した文字列(手順2) |
| `CSC_KEY_PASSWORD` | .p12 書き出し時のパスワード(手順2) |
| `APPLE_ID` | Apple ID のメールアドレス |
| `APPLE_APP_SPECIFIC_PASSWORD` | Appパスワード(手順3) |
| `APPLE_TEAM_ID` | Team ID(手順1) |

## 5. 署名版をビルド

新しいタグを push すれば、自動で署名+公証されたdmgがReleasesに出ます:
```
git tag v0.8.1
git push origin v0.8.1
```
または GitHub の Actions → 「Build & Release」→「Run workflow」で手動実行。

公証には数分〜十数分かかります。完成したdmgからインストールすれば、
**`xattr` もGatekeeper警告も不要**で、ダブルクリックでそのまま起動できます。

---

## 補足

- Team ID を控えたら教えてください。念のため設定の最終確認をします。
- Windows の署名(SmartScreen対策)は別途コードサイニング証明書が必要です(年数万円〜)。必要になれば対応します。
- Secret 未登録の間は、ビルドは従来どおり成功しますが未署名のままです(公証は自動スキップ)。
