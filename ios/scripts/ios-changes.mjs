#!/usr/bin/env node
// iOSアプリ本体（TestFlightへ配るバイナリ）の更新が要るかを判定する（#591）。
//
//   node ios/scripts/ios-changes.mjs [--base <ref>] [--head <ref>] [--json]
//
// 比べる相手（--base）の既定は「最後にTestFlightへ配布し終えたコミット」＝タグ
// `ios-testflight/<ビルド番号>` のうち最新のもの。ここに印が無い（初回）ときは要配布とする。
// 印は処理済み・内部グループへの割当てが済んだあとにだけ付けるので、途中で失敗した配布の
// 変更も、次のリリースの判定に残る（リリースごとの差分ではなく、配布済みとの差分で見る）。
//
// 配布物に入るのは Kurashio/・KurashioWidget/・Kurashio.xcodeproj/ だけ。README・scripts は
// 入らないので除外し、pbxproj の版番号の行（MARKETING_VERSION・CURRENT_PROJECT_VERSION）だけの
// 差分も数えない（リリースのバンプで毎回書き換わる・#535）。
// ios-rebuild-notice.yml も同じ判定を呼ぶ（食い違わせない）。

import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const TAG_PREFIX = "ios-testflight/";

// pathspec（git diff に渡す）。配布物側だけを含め、Markdown は外す。
export const DISTRIBUTED_PATHSPEC = [
  "ios/Kurashio",
  "ios/KurashioWidget",
  "ios/Kurashio.xcodeproj",
  ":(exclude,glob)**/*.md",
];

const VERSION_LINE =
  /^[+-][\t ]*(MARKETING_VERSION|CURRENT_PROJECT_VERSION) = [^;]+;[\t ]*$/;

/** `git diff -U0` の出力から、配布物に影響する変更行だけを返す（純関数）。 */
export function meaningfulChangeLines(diffText) {
  return diffText
    .split("\n")
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line))
    .filter((line) => !VERSION_LINE.test(line));
}

/** 意味のある変更行を持つファイルだけを、diff の見出しから拾う（版番号だけのpbxprojは含めない）。 */
export function changedFilesOf(diffText) {
  const files = [];
  for (const block of diffText.split(/^diff --git /m).slice(1)) {
    const name = block.match(/^a\/(.+?) b\//)?.[1];
    if (name && meaningfulChangeLines(block).length > 0) files.push(name);
  }
  return files;
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** 最後に配布し終えたコミットの印（タグ名）。無ければ null。 */
export function latestDistributedTag(cwd) {
  const tags = git(
    ["tag", "--list", `${TAG_PREFIX}*`, "--sort=-version:refname"],
    cwd
  )
    .split("\n")
    .filter(Boolean);
  return tags[0] ?? null;
}

/**
 * 判定する。戻り値: { needed, reason, base, changedFiles }
 * base 未指定なら最新の配布済みタグ。タグが無ければ初回として要配布。
 */
export function decide({ cwd, base, head = "HEAD" }) {
  const baseRef = base ?? latestDistributedTag(cwd);
  if (!baseRef) {
    return {
      needed: true,
      reason: "TestFlightへの配布実績が無い（初回）",
      base: null,
      changedFiles: [],
    };
  }
  const diff = git(
    ["diff", "-U0", `${baseRef}..${head}`, "--", ...DISTRIBUTED_PATHSPEC],
    cwd
  );
  const lines = meaningfulChangeLines(diff);
  if (lines.length === 0) {
    return {
      needed: false,
      reason: `${baseRef} 以降、配布物（Swift・Widget・Xcode設定・アセット）に変更なし`,
      base: baseRef,
      changedFiles: [],
    };
  }
  const changedFiles = changedFilesOf(diff);
  return {
    needed: true,
    reason: `${baseRef} 以降、配布物に${lines.length}行の変更あり`,
    base: baseRef,
    changedFiles,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") out.base = argv[++i];
    else if (argv[i] === "--head") out.head = argv[++i];
    else if (argv[i] === "--json") out.json = true;
    else throw new Error(`知らない引数: ${argv[i]}`);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { base, head, json } = parseArgs(process.argv.slice(2));
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const result = decide({ cwd: root, base, head });
  if (json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`${result.needed ? "要配布" : "配布不要"}: ${result.reason}`);
    for (const f of result.changedFiles) console.log(`  ${f}`);
  }
}
