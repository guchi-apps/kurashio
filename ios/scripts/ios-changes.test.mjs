// ios-changes.mjs の判定テスト（`node --test ios/scripts/`）。
// 一時的なgitリポジトリを作り、配布物・非配布物・版番号だけの差分を実際にコミットして確かめる。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { decide, meaningfulChangeLines } from "./ios-changes.mjs";

const PBX = "ios/Kurashio.xcodeproj/project.pbxproj";
let dir;

function git(...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}
function write(path, content) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}
function commit(message) {
  git("add", "-A");
  git("commit", "-q", "-m", message);
}
function pbx(version, build) {
  return `MARKETING_VERSION = ${version};\nCURRENT_PROJECT_VERSION = ${build};\nother = 1;\n`;
}

describe("meaningfulChangeLines", () => {
  it("版番号の行だけの差分は数えない", () => {
    const diff = [
      "--- a/x",
      "+++ b/x",
      "-\t\t\t\tMARKETING_VERSION = 4.29.2;",
      "+\t\t\t\tMARKETING_VERSION = 4.30.0;",
      "-\t\t\t\tCURRENT_PROJECT_VERSION = 1;",
      "+\t\t\t\tCURRENT_PROJECT_VERSION = 2;",
    ].join("\n");
    assert.deepEqual(meaningfulChangeLines(diff), []);
  });

  it("それ以外の行は数える", () => {
    assert.equal(meaningfulChangeLines("+let a = 1\n-let a = 2").length, 2);
  });
});

describe("decide", () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "ios-changes-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    write("ios/Kurashio/App.swift", "let a = 1\n");
    write("ios/KurashioWidget/W.swift", "let w = 1\n");
    write("ios/README.md", "# a\n");
    write("ios/scripts/x.sh", "echo a\n");
    write(PBX, pbx("1.0.0", 1));
    commit("initial");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("配布実績（印）が無ければ初回として要配布", () => {
    const r = decide({ cwd: dir });
    assert.equal(r.needed, true);
    assert.equal(r.base, null);
  });

  it("印より後に配布物の変更が無ければ不要（README・scripts・版番号だけ）", () => {
    git("tag", "ios-testflight/100");
    write("ios/README.md", "# b\n");
    commit("readme");
    write("ios/scripts/x.sh", "echo b\n");
    commit("scripts");
    write(PBX, pbx("1.1.0", 5));
    commit("bump");
    const r = decide({ cwd: dir });
    assert.equal(r.needed, false);
    assert.equal(r.base, "ios-testflight/100");
  });

  it("Swiftを変えると要配布。ファイル名も返る", () => {
    write("ios/Kurashio/App.swift", "let a = 2\n");
    commit("swift");
    const r = decide({ cwd: dir });
    assert.equal(r.needed, true);
    assert.deepEqual(r.changedFiles, ["ios/Kurashio/App.swift"]);
  });

  it("配布に失敗して印が進まなければ、次のリリースでも変更が残る", () => {
    write("ios/README.md", "# c\n");
    commit("docs only, next release");
    assert.equal(decide({ cwd: dir }).needed, true);
  });

  it("配布し終えて印を進めると不要に戻る。Widgetだけの変更も拾う", () => {
    git("tag", "ios-testflight/200");
    assert.equal(decide({ cwd: dir }).needed, false);
    write("ios/KurashioWidget/W.swift", "let w = 2\n");
    commit("widget");
    const r = decide({ cwd: dir });
    assert.equal(r.needed, true);
    assert.equal(r.base, "ios-testflight/200");
  });

  it("印はビルド番号の数値順で最新を選ぶ（99 < 200）", () => {
    git("tag", "ios-testflight/99");
    assert.equal(decide({ cwd: dir }).base, "ios-testflight/200");
  });
});
