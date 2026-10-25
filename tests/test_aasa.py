"""`/.well-known/apple-app-site-association`（#843）。iOSアプリのUniversal Links。"""


def test_aasa_returns_json_with_app_id_and_root(client):
    response = client.get("/.well-known/apple-app-site-association", follow_redirects=False)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    detail = response.json()["applinks"]["details"][0]
    assert detail["appIDs"] == ["6AA3WFTR94.com.gucchii.kurashio"]
    assert {"/": "/"} in detail["components"]
