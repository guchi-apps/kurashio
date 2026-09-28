#!/usr/bin/env node
// XcodeプロジェクトのMARKETING_VERSIONを frontend/package.json の version に合わせる（#535）。
// release-develop-to-main.yml のバンプPR作成時（bump-command）から自動で呼ばれ、developへ
// マージされた時点で常に一致させる。カレントディレクトリに依存せず動くため、リポジトリ
// ルート・ios/ のどちらから実行しても同じ結果になる。
//
//   node ios/scripts/sync-version.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const IOS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(IOS_DIR);
const PACKAGE_JSON_PATH = join(ROOT, "frontend", "package.json");
const PBXPROJ_PATH = join(
  IOS_DIR,
  "Kurashio.xcodeproj",
  "project.pbxproj"
);

function main() {
  const { version } = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
  if (!version) {
    throw new Error(`version not found in ${PACKAGE_JSON_PATH}`);
  }

  const original = readFileSync(PBXPROJ_PATH, "utf8");
  const pattern = /MARKETING_VERSION = [^;]+;/g;
  const matches = original.match(pattern) ?? [];
  if (matches.length === 0) {
    throw new Error(`MARKETING_VERSION not found in ${PBXPROJ_PATH}`);
  }

  const updated = original.replace(pattern, `MARKETING_VERSION = ${version};`);
  if (updated === original) {
    console.log(`MARKETING_VERSION is already ${version}; skipping.`);
    return;
  }

  writeFileSync(PBXPROJ_PATH, updated, "utf8");
  console.log(
    `Updated MARKETING_VERSION to ${version} (${matches.length} occurrence(s)).`
  );
}

main();
