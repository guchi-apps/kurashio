from backend import apns_subscriptions


def _set_path(monkeypatch, tmp_path):
    monkeypatch.setattr(apns_subscriptions, "TOKENS_PATH", tmp_path / "apns_tokens.json")


def test_upsert_and_list(monkeypatch, tmp_path):
    _set_path(monkeypatch, tmp_path)
    apns_subscriptions.upsert_token("token-a")
    assert apns_subscriptions.list_tokens() == ["token-a"]


def test_upsert_updates_existing_token_without_duplicating(monkeypatch, tmp_path):
    _set_path(monkeypatch, tmp_path)
    apns_subscriptions.upsert_token("token-a", user_agent="first")
    apns_subscriptions.upsert_token("token-a", user_agent="second")
    assert apns_subscriptions.list_tokens() == ["token-a"]


def test_upsert_rejects_empty_token(monkeypatch, tmp_path):
    _set_path(monkeypatch, tmp_path)
    try:
        apns_subscriptions.upsert_token("")
        assert False, "should have raised"
    except ValueError:
        pass


def test_remove_token(monkeypatch, tmp_path):
    _set_path(monkeypatch, tmp_path)
    apns_subscriptions.upsert_token("token-a")
    assert apns_subscriptions.remove_token("token-a") is True
    assert apns_subscriptions.list_tokens() == []
    assert apns_subscriptions.remove_token("token-a") is False


def test_remove_tokens_bulk(monkeypatch, tmp_path):
    _set_path(monkeypatch, tmp_path)
    apns_subscriptions.upsert_token("token-a")
    apns_subscriptions.upsert_token("token-b")
    apns_subscriptions.remove_tokens(["token-a", "token-missing"])
    assert apns_subscriptions.list_tokens() == ["token-b"]
