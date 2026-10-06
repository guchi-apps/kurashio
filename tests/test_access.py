"""StatusHub 共通アクセス設定の判定クライアント（#718）。"""

import pytest

from backend import access

SUBJECT = access.AccessSubject(sub="sub-1", email="User@Example.com", email_verified=True)


def _response(allowed=True, version=3, ttl=30, stale=300, reason=None):
    return access.AccessResponse(
        version, ttl, stale, access.AccessDecision(allowed, ["member"] if allowed else [], reason)
    )


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def _client(fetch, clock=None):
    return access.AccessClient(fetch, clock or Clock())


def test_許可を返す():
    assert _client(lambda body: _response()).decide(SUBJECT).allowed is True


def test_ttlの間は問い合わせない():
    calls = []
    clock = Clock()
    client = _client(lambda body: calls.append(body) or _response(), clock)
    client.decide(SUBJECT)
    clock.t += 29
    client.decide(SUBJECT)
    assert len(calls) == 1
    clock.t += 2
    client.decide(SUBJECT)
    assert len(calls) == 2
    # 2回目からは適用中の版を申告する
    assert "appliedVersion" not in calls[0]
    assert calls[1]["appliedVersion"] == 3


def test_取消はttl後に効く():
    answers = [_response(True), _response(False, reason="revoked")]
    clock = Clock()
    client = _client(lambda body: answers.pop(0), clock)
    assert client.decide(SUBJECT).allowed
    clock.t += 31
    d = client.decide(SUBJECT)
    assert d.allowed is False and d.reason == "revoked"


def _boom(body):
    raise RuntimeError("down")


def test_失敗時は直前の判定をmaxStaleまで使い_超えたら拒否():
    clock = Clock()
    state = {"fail": False}

    def fetch(body):
        if state["fail"]:
            raise RuntimeError("down")
        return _response()

    client = _client(fetch, clock)
    assert client.decide(SUBJECT).allowed
    state["fail"] = True
    clock.t += 60
    assert client.decide(SUBJECT).allowed
    clock.t += 300
    assert client.decide(SUBJECT).allowed is False


def test_一度も判定できていなければ拒否():
    assert _client(_boom).decide(SUBJECT).allowed is False


def test_検証済みでないIDは問い合わせず拒否():
    client = _client(lambda body: pytest.fail("呼んではいけない"))
    for subject in (
        access.AccessSubject("s", "a@example.com", False),
        access.AccessSubject("", "a@example.com", True),
        access.AccessSubject("s", "", True),
    ):
        d = client.decide(subject)
        assert d.allowed is False and d.reason == "unverified_identity"


def test_判定が欠けた応答は失敗として拒否():
    client = _client(lambda body: access.AccessResponse(1, 30, 300, None))
    assert client.decide(SUBJECT).allowed is False


def test_ハートビートは判定なしで版を更新する():
    calls = []
    client = _client(lambda body: calls.append(body) or _response(version=7))
    assert client.heartbeat() is True
    assert client.heartbeat() is True
    assert calls == [{}, {"appliedVersion": 7}]


def test_ハートビート失敗はFalse():
    assert _client(_boom).heartbeat() is False


def test_応答の形を確かめる():
    ok = {"appVersion": 1, "ttlSeconds": 30, "maxStaleSeconds": 300,
          "decision": {"allowed": False, "permissions": ["x"], "reason": "no_grant"}}
    parsed = access.parse_response(ok, True)
    assert parsed.decision.allowed is False and parsed.decision.permissions == []
    for bad in (None, {}, {**ok, "ttlSeconds": "30"}, {**ok, "decision": {}}):
        with pytest.raises(access.AccessResponseError):
            access.parse_response(bad, True)


def test_トークンが無ければ通信せず失敗(monkeypatch):
    monkeypatch.setattr(access, "_get_token", lambda: None)
    monkeypatch.setattr(access.requests, "post", lambda *a, **k: pytest.fail("通信してはいけない"))
    with pytest.raises(access.AccessResponseError):
        access._http_fetch({})


class _Resp:
    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


def test_401ならトークンを読み直して1回だけ再試行(monkeypatch):
    tokens = iter(["old", "new"])
    monkeypatch.setattr(access, "_get_token", lambda: next(tokens))
    forgotten = []
    monkeypatch.setattr(access, "_forget_token", lambda: forgotten.append(1))
    used = []
    good = {"appVersion": 1, "ttlSeconds": 30, "maxStaleSeconds": 300}

    def post(base, token, body):
        used.append(token)
        return _Resp(401) if token == "old" else _Resp(200, good)

    monkeypatch.setattr(access, "_post", post)
    assert access._http_fetch({}).app_version == 1
    assert used == ["old", "new"] and forgotten == [1]
