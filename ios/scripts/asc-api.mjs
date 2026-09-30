#!/usr/bin/env node
// App Store Connect API の操作（#591）。ios-testflight.yml の「処理待ち」「内部グループ割当て」で使う。
// Node 標準の crypto / fetch だけで動く（依存なし）。
//
//   node ios/scripts/asc-api.mjs build-exists   --version 4.30.0 --build 1234
//   node ios/scripts/asc-api.mjs wait-and-assign --version 4.30.0 --build 1234
//
// 環境変数: ASC_KEY_ID・ASC_ISSUER_ID・ASC_KEY_P8（.p8 の中身をbase64にした1行）
//   TESTFLIGHT_GROUP（内部グループ名。省略時は内部グループが1つだけなら自動で選ぶ）
//   BUNDLE_ID（既定 com.gucchii.kurashio）
// **キーの中身・JWTはログに出さない。** 失敗の理由は段階名つきの短い文で返す。
//
// 終了コード: 0=成功（build-exists は存在するとき0）
//   10=build-exists で未アップロード（失敗ではない。API障害の1と区別するため別の値にしている）
//   2=待ちきれなかった（Appleの処理が遅い。再実行で続きから確かめられる）
//   1=それ以外の失敗（認証・処理失敗・割当て失敗）

import { createPrivateKey, sign } from "node:crypto";
import { fileURLToPath } from "node:url";

const API = "https://api.appstoreconnect.apple.com";

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

/** ES256 の JWT（有効期間は最大20分のところ10分）。 */
export function createJwt({ keyId, issuerId, privateKeyPem, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = { iss: issuerId, iat, exp: iat + 600, aud: "appstoreconnect-v1" };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  // JWT の署名は DER ではなく r||s 形式（ieee-p1363）
  const signature = sign("sha256", Buffer.from(data), {
    key: createPrivateKey(privateKeyPem),
    dsaEncoding: "ieee-p1363",
  });
  return `${data}.${signature.toString("base64url")}`;
}

/** 内部グループを1つ選ぶ。名前指定があればそれ、無ければ内部グループが1つのときだけ。 */
export function pickInternalGroup(groups, name) {
  const internal = groups.filter((g) => g.attributes?.isInternalGroup);
  if (name) {
    const found = internal.find((g) => g.attributes.name === name);
    if (!found) {
      throw new Error(
        `内部グループ「${name}」が見つかりません（内部グループ: ${internal.map((g) => g.attributes.name).join("、") || "なし"}）`
      );
    }
    return found;
  }
  if (internal.length === 1) return internal[0];
  throw new Error(
    `内部グループを1つに決められません（${internal.length}件）。TESTFLIGHT_GROUP で名前を指定してください`
  );
}

class AscClient {
  constructor(env) {
    for (const k of ["ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_P8"]) {
      if (!env[k]) throw new Error(`${k} が未設定です（ios/README.md の初期設定を参照）`);
    }
    this.env = env;
  }
  token() {
    return createJwt({
      keyId: this.env.ASC_KEY_ID,
      issuerId: this.env.ASC_ISSUER_ID,
      privateKeyPem: Buffer.from(this.env.ASC_KEY_P8, "base64").toString("utf8"),
    });
  }
  async request(method, path, body) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token()}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `App Store Connect APIの認証に失敗しました（HTTP ${res.status}）。APIキーが失効・権限不足の可能性があります。ios/README.md の「キーの失効」を参照`
      );
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`App Store Connect API ${method} ${path} が HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    return text ? JSON.parse(text) : {};
  }
}

async function findApp(client, bundleId) {
  const r = await client.request("GET", `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`);
  const app = r.data?.[0];
  if (!app) throw new Error(`Bundle ID ${bundleId} のAppがApp Store Connectに見つかりません`);
  return app;
}

async function findBuild(client, appId, version, build) {
  const q =
    `/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(build)}` +
    `&filter[preReleaseVersion.version]=${encodeURIComponent(version)}&limit=1`;
  return (await client.request("GET", q)).data?.[0] ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fn, { timeoutMs, intervalMs = 30_000 }) {
  const started = Date.now();
  for (;;) {
    const result = await fn();
    if (result.done) return result.value;
    if (Date.now() - started > timeoutMs) {
      const e = new Error(`${label}が${Math.round(timeoutMs / 60000)}分たっても終わりません（${result.note ?? ""}）`);
      e.code = "TIMEOUT";
      throw e;
    }
    console.log(`  待機中: ${result.note ?? label}`);
    await sleep(intervalMs);
  }
}

async function waitAndAssign(client, { version, build, bundleId, groupName }) {
  const app = await findApp(client, bundleId);

  console.log("段階: App Store Connectでのビルド処理");
  const found = await waitFor(
    "ビルドの処理",
    async () => {
      const b = await findBuild(client, app.id, version, build);
      if (!b) return { done: false, note: "ビルドがまだ届いていません" };
      const state = b.attributes.processingState;
      if (state === "VALID") return { done: true, value: b };
      if (state === "FAILED" || state === "INVALID") {
        throw new Error(`ビルドの処理が ${state} で終わりました。App Store Connect のメールと TestFlight の画面で理由を確認してください`);
      }
      return { done: false, note: `処理中（${state}）` };
    },
    { timeoutMs: 40 * 60_000 }
  );
  console.log(`  処理済み（build ${build}）`);

  console.log("段階: 内部テストグループへの配布");
  const groups = (await client.request("GET", `/v1/apps/${app.id}/betaGroups?limit=200`)).data ?? [];
  const group = pickInternalGroup(groups, groupName);
  if (group.attributes.hasAccessToAllBuilds) {
    console.log(`  グループ「${group.attributes.name}」は全ビルドが自動で使えるため、割当ては不要です`);
  } else {
    try {
      await client.request("POST", `/v1/betaGroups/${group.id}/relationships/builds`, {
        data: [{ type: "builds", id: found.id }],
      });
    } catch (e) {
      // 割当て済みを再実行したときの重複は成功として扱う（再実行を安全にする）
      if (!/HTTP 409/.test(String(e.message))) throw e;
    }
    console.log(`  グループ「${group.attributes.name}」へ割り当てました`);
  }

  const state = await waitFor(
    "内部テストでの利用開始",
    async () => {
      const d = (await client.request("GET", `/v1/builds/${found.id}/buildBetaDetail`)).data;
      const s = d?.attributes?.internalBuildState;
      if (s === "IN_BETA_TESTING" || s === "READY_FOR_BETA_TESTING") return { done: true, value: s };
      if (s === "MISSING_EXPORT_COMPLIANCE") {
        throw new Error("輸出コンプライアンス（暗号化）の回答が要ります。Info.plist の ITSAppUsesNonExemptEncryption を確認してください（ios/README.md）");
      }
      if (s === "PROCESSING_EXCEPTION" || s === "BETA_REJECTED" || s === "EXPIRED") {
        throw new Error(`内部テストの状態が ${s} です。TestFlight の画面で確認してください`);
      }
      return { done: false, note: `内部テストの状態: ${s ?? "不明"}` };
    },
    { timeoutMs: 15 * 60_000 }
  );
  console.log(`  内部テストで利用可能（${state}）`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) opts[rest[i].replace(/^--/, "")] = rest[i + 1];
  return { command, opts };
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  if (!opts.version || !opts.build) {
    throw new Error("--version と --build が要ります");
  }
  const client = new AscClient(process.env);
  const bundleId = process.env.BUNDLE_ID || "com.gucchii.kurashio";
  if (command === "build-exists") {
    const app = await findApp(client, bundleId);
    const b = await findBuild(client, app.id, opts.version, opts.build);
    console.log(b ? `build ${opts.build} は既にあります（${b.attributes.processingState}）` : "未アップロード");
    process.exit(b ? 0 : 10);
  } else if (command === "wait-and-assign") {
    await waitAndAssign(client, {
      version: opts.version,
      build: opts.build,
      bundleId,
      groupName: process.env.TESTFLIGHT_GROUP || "",
    });
  } else {
    throw new Error(`知らないコマンド: ${command}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`::error::${e.message}`);
    process.exit(e.code === "TIMEOUT" ? 2 : 1);
  });
}
