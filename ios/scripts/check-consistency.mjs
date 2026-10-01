#!/usr/bin/env node
// iOSの殻（ios/）とWeb側（frontend/）の「揃えておくべき値」を照合する（#568）。
// subpc には Xcode が無くSwiftをビルドできないため、ビルドしなくても確かめられるずれだけを
// 機械的に拾う。Node標準モジュールだけで動き、依存のインストールは要らない
// （ci.yml の frontend ジョブが npm ci の前に毎回実行する）。
//
//   node ios/scripts/check-consistency.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const IOS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(IOS_DIR);

const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

/** 失敗の一覧。空なら成功 */
export function collectProblems(files) {
  const problems = [];

  // 1. 共有Swiftは2つのフォルダに同じ内容を置く（README「SharedWidgetSnapshot.swift」）
  if (files.sharedApp !== files.sharedWidget) {
    problems.push(
      "ios/Kurashio/SharedWidgetSnapshot.swift と ios/KurashioWidget/SharedWidgetSnapshot.swift の内容が違います（両方を揃えること）"
    );
  }

  // 2. MARKETING_VERSION は frontend/package.json の version と一致（#535）
  const { version } = JSON.parse(files.packageJson);
  const versions = [...files.pbxproj.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map(
    (m) => m[1].trim()
  );
  if (versions.length === 0) {
    problems.push("project.pbxproj に MARKETING_VERSION がありません");
  }
  for (const v of new Set(versions)) {
    if (v !== version) {
      problems.push(
        `MARKETING_VERSION (${v}) が frontend/package.json の version (${version}) と違います（node ios/scripts/sync-version.mjs で直る）`
      );
    }
  }

  // 3. ログインの戻り先: Web の NATIVE_AUTH_REDIRECT と Swift の authCallbackScheme
  const redirect = files.nativeApp.match(
    /NATIVE_AUTH_REDIRECT\s*=\s*"([a-z][a-z0-9+.-]*):\/\//i
  );
  const scheme = files.appConfig.match(/authCallbackScheme\s*=\s*"([^"]+)"/);
  if (!redirect || !scheme) {
    problems.push(
      "NATIVE_AUTH_REDIRECT または authCallbackScheme が読み取れません（書き方を変えたならこのスクリプトも直す）"
    );
  } else if (redirect[1] !== scheme[1]) {
    problems.push(
      `ログインの戻り先のスキームが違います: Web は "${redirect[1]}"、Swift は "${scheme[1]}"`
    );
  }

  // 4. ブリッジ名: Web が探す window.webkit.messageHandlers.<名> と Swift の bridgeName
  const bridge = files.appConfig.match(/bridgeName\s*=\s*"([^"]+)"/);
  if (bridge && !files.nativeApp.includes(`messageHandlers.${bridge[1]}`)) {
    problems.push(
      `Swift の bridgeName "${bridge[1]}" を Web（native-app.ts）が参照していません`
    );
  }

  // 5. project.pbxproj を手で編集した場合の壊れ方（括弧・ID参照）
  let depth = 0;
  for (const ch of files.pbxproj) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) problems.push("project.pbxproj の {} の対応が取れていません");

  const defined = new Set(
    [...files.pbxproj.matchAll(/^\t\t([0-9A-F]{24})(?: \/\*[^*]*\*\/)? = \{/gm)].map(
      (m) => m[1]
    )
  );
  const used = new Set(files.pbxproj.match(/\b[0-9A-F]{24}\b/g) ?? []);
  const undefinedIds = [...used].filter((id) => !defined.has(id));
  if (undefinedIds.length > 0) {
    problems.push(
      `project.pbxproj に定義の無いIDを参照しています: ${undefinedIds.join(", ")}`
    );
  }

  // 6. iPad対応（#642）: 向きは4方向すべて宣言する（足りないと App Store Connect が
  //    ITMS-90474 でアップロードを断る）。ウィンドウは1つに限る（通知・端末トークンの受け先
  //    appDelegate.webViewModel が1つしか持てない）。INFOPLIST_KEY_UIApplicationSupportsMultipleScenes
  //    という設定キーは無いので、アプリ本体の Info.plist に false を書く
  const ipadOrientations = [...files.pbxproj.matchAll(
    /INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad = "([^"]*)"/g
  )];
  if (ipadOrientations.length === 0) {
    problems.push("project.pbxproj に iPad の向き（UISupportedInterfaceOrientations_iPad）がありません");
  }
  for (const m of ipadOrientations) {
    for (const o of ["Portrait", "PortraitUpsideDown", "LandscapeLeft", "LandscapeRight"]) {
      if (!m[1].split(/\s+/).includes(`UIInterfaceOrientation${o}`)) {
        problems.push(`iPad の向きに UIInterfaceOrientation${o} がありません（4方向すべて必要）`);
      }
    }
  }
  if (
    !/UIApplicationSupportsMultipleScenes<\/key>\s*<false\/>/.test(files.appInfoPlist)
  ) {
    problems.push(
      "ios/Kurashio/Info.plist に UIApplicationSupportsMultipleScenes = false がありません（iPad で複数ウィンドウが開くと通知・トークンの受け先がずれる）"
    );
  }

  return problems;
}

function main() {
  const problems = collectProblems({
    sharedApp: read("ios", "Kurashio", "SharedWidgetSnapshot.swift"),
    sharedWidget: read("ios", "KurashioWidget", "SharedWidgetSnapshot.swift"),
    packageJson: read("frontend", "package.json"),
    pbxproj: read("ios", "Kurashio.xcodeproj", "project.pbxproj"),
    nativeApp: read("frontend", "lib", "native-app.ts"),
    appConfig: read("ios", "Kurashio", "AppConfig.swift"),
    appInfoPlist: read("ios", "Kurashio", "Info.plist"),
  });

  if (problems.length > 0) {
    console.error("iOSの整合チェックに失敗しました:");
    for (const p of problems) console.error(`- ${p}`);
    process.exit(1);
  }
  console.log("iOSの整合チェック: OK");
}

// テストから import されたときは実行しない
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
