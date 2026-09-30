// asc-api.mjs の純関数のテスト（`node --test ios/scripts/*.test.mjs`）。ネットワークは使わない。

import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { describe, it } from "node:test";

import { createJwt, pickInternalGroup } from "./asc-api.mjs";

const g = (name, isInternalGroup) => ({ id: name, attributes: { name, isInternalGroup } });

describe("createJwt", () => {
  it("ES256の3部構成で、署名が公開鍵で検証できる", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const jwt = createJwt({ keyId: "KID", issuerId: "ISS", privateKeyPem: pem, now: 1_000_000 });
    const [h, p, s] = jwt.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "ES256", kid: "KID", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(p, "base64url"));
    assert.equal(payload.iss, "ISS");
    assert.equal(payload.aud, "appstoreconnect-v1");
    assert.equal(payload.exp - payload.iat, 600);
    assert.ok(
      verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))
    );
  });
});

describe("pickInternalGroup", () => {
  it("名前指定があれば内部グループからその名前を選ぶ（外部グループは選ばない）", () => {
    assert.equal(pickInternalGroup([g("A", false), g("A", true), g("B", true)], "A").attributes.isInternalGroup, true);
  });
  it("名前が無くても内部グループが1つなら選べる", () => {
    assert.equal(pickInternalGroup([g("外部", false), g("自分", true)], "").id, "自分");
  });
  it("内部グループが複数で名前が無いと失敗する", () => {
    assert.throws(() => pickInternalGroup([g("A", true), g("B", true)], ""), /1つに決められません/);
  });
  it("指定した名前が無いと失敗する", () => {
    assert.throws(() => pickInternalGroup([g("A", true)], "Z"), /見つかりません/);
  });
});
