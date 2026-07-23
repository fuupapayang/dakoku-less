'use strict';
/**
 * afterSign フック: 署名済みのmacOSアプリをAppleに公証(notarize)する。
 * APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID が揃っているときだけ実行。
 * 未設定(=証明書未導入)のときは何もしない → 未署名ビルドはこれまで通り成功する。
 */
exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('▶ 公証をスキップ(APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID が未設定)');
    return;
  }

  let notarize;
  try { ({ notarize } = require('@electron/notarize')); }
  catch (e) { console.log('▶ @electron/notarize 未インストールのため公証をスキップ'); return; }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  console.log(`▶ 公証を開始: ${appPath}`);
  await notarize({
    appBundleId: context.packager.config.appId || 'jp.example.dakokuless',
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID
  });
  console.log('▶ 公証が完了しました');
};
