"""Tapo 収集スクリプト（collectors/tapo_to_myroom.py）の、機器に繋がない部分のテスト。

`collectors/` はパッケージではないため、ファイルパスから直接読み込む。
`python-kasa` はサブPCの収集用 venv にしか入っていないので、**入っていなくても
import できること自体**もここで担保する。
"""

import asyncio
import datetime
import importlib.util
import ipaddress
import json
import pathlib
import time

import pytest

MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "collectors" / "tapo_to_myroom.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("tapo_to_myroom", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tapo = _load_module()


class TestParseHosts:
    def test_ip_only_uses_device_alias(self):
        assert tapo.parse_hosts("192.168.1.21") == [("192.168.1.21", None)]

    def test_name_override(self):
        assert tapo.parse_hosts("192.168.1.21=冷蔵庫") == [("192.168.1.21", "冷蔵庫")]

    def test_multiple_entries_and_whitespace(self):
        raw = " 192.168.1.21=冷蔵庫 , 192.168.1.22=テレビ ,192.168.1.23 "
        assert tapo.parse_hosts(raw) == [
            ("192.168.1.21", "冷蔵庫"),
            ("192.168.1.22", "テレビ"),
            ("192.168.1.23", None),
        ]

    def test_trailing_comma_is_ignored(self):
        assert tapo.parse_hosts("192.168.1.21,") == [("192.168.1.21", None)]

    def test_empty_name_falls_back_to_alias(self):
        assert tapo.parse_hosts("192.168.1.21=") == [("192.168.1.21", None)]

    def test_empty_raises(self):
        with pytest.raises(tapo.ConfigError):
            tapo.parse_hosts("  ,  ")

    def test_missing_host_raises(self):
        with pytest.raises(tapo.ConfigError):
            tapo.parse_hosts("=冷蔵庫")


class TestBuildPayload:
    def test_source_is_namespaced(self):
        readings = [{"name": "冷蔵庫", "kwh_today": 0.86, "power_w": 38.2}]
        payload = tapo.build_payload(readings, datetime.date(2026, 8, 22))
        assert payload == {
            "records": [
                {
                    "date": "2026-08-22",
                    "source": "tapo:冷蔵庫",
                    "kwh": 0.86,
                    "power_w": 38.2,
                }
            ]
        }

    def test_reading_without_total_is_dropped(self):
        """瞬時値しか取れなかった機器は送らない。日別テーブルに入れる値が無いため。"""
        readings = [
            {"name": "冷蔵庫", "kwh_today": 0.86, "power_w": 38.2},
            {"name": "テレビ", "kwh_today": None, "power_w": 72.0},
        ]
        payload = tapo.build_payload(readings, datetime.date(2026, 8, 22))
        assert [r["source"] for r in payload["records"]] == ["tapo:冷蔵庫"]

    def test_zero_kwh_is_kept(self):
        """0 kWh は「使っていない」という記録なので、欠測とは区別して送る。"""
        readings = [{"name": "デスク", "kwh_today": 0.0, "power_w": 0.0}]
        payload = tapo.build_payload(readings, datetime.date(2026, 8, 22))
        assert payload["records"][0]["kwh"] == 0.0

    def test_history_comes_before_today(self):
        """過去ぶんは古い順に並べ、瞬時電力は当日ぶんにだけ付ける。"""
        readings = [
            {
                "name": "乾燥機",
                "kwh_today": 2.1,
                "power_w": 480.0,
                "history": [
                    (datetime.date(2026, 8, 20), 1.75),
                    (datetime.date(2026, 8, 21), 0.0),
                ],
            }
        ]
        payload = tapo.build_payload(readings, datetime.date(2026, 8, 22))
        assert payload == {
            "records": [
                {
                    "date": "2026-08-20",
                    "source": "tapo:乾燥機",
                    "kwh": 1.75,
                    "power_w": None,
                },
                {
                    "date": "2026-08-21",
                    "source": "tapo:乾燥機",
                    "kwh": 0.0,
                    "power_w": None,
                },
                {
                    "date": "2026-08-22",
                    "source": "tapo:乾燥機",
                    "kwh": 2.1,
                    "power_w": 480.0,
                },
            ]
        }

    def test_history_is_sent_even_without_today(self):
        """当日ぶんが読めなくても、過去ぶんは送る。"""
        readings = [
            {
                "name": "乾燥機",
                "kwh_today": None,
                "power_w": None,
                "history": [(datetime.date(2026, 8, 21), 1.2)],
            }
        ]
        payload = tapo.build_payload(readings, datetime.date(2026, 8, 22))
        assert [r["date"] for r in payload["records"]] == ["2026-08-21"]


class TestWindowStart:
    def test_one_day_is_today_only(self):
        assert tapo.window_start(datetime.date(2026, 8, 22), 1) == datetime.date(2026, 8, 22)

    def test_counts_today_in_the_span(self):
        assert tapo.window_start(datetime.date(2026, 8, 22), 3) == datetime.date(2026, 8, 20)

    def test_rejects_zero(self):
        with pytest.raises(ValueError):
            tapo.window_start(datetime.date(2026, 8, 22), 0)


class TestExtractDailyHistory:
    """`get_energy_data` の応答（Wh の配列）を切り出す部分。

    プラグは起点を月初へ丸め、92日ぶんをまとめて返す。実機（P110M）の応答をもとにしている。
    """

    JST = datetime.timezone(datetime.timedelta(hours=9))
    START = datetime.datetime(2026, 8, 1, tzinfo=JST)

    def _response(self, values):
        return {
            "get_energy_data": {
                "data": list(values),
                "start_timestamp": int(self.START.timestamp()),
                "interval": 1440,
            }
        }

    def test_converts_wh_to_kwh_and_skips_today(self):
        # 8/1 から 0,0,1234,0,567（8/5 が当日）
        response = self._response([0, 0, 1234, 0, 567] + [0] * 87)
        history = tapo.extract_daily_history(
            response, datetime.date(2026, 8, 5), datetime.date(2026, 8, 1)
        )
        assert history == [
            (datetime.date(2026, 8, 3), 1.234),
            (datetime.date(2026, 8, 4), 0.0),
        ]

    def test_drops_days_before_the_first_measurement(self):
        """計測前の日も 0 で返るため、最初に0でなかった日より前は送らない。"""
        response = self._response([0] * 13 + [267, 324] + [0] * 77)
        history = tapo.extract_daily_history(
            response, datetime.date(2026, 8, 16), datetime.date(2026, 8, 1)
        )
        assert history == [
            (datetime.date(2026, 8, 14), 0.267),
            (datetime.date(2026, 8, 15), 0.324),
        ]

    def test_trims_to_the_requested_window(self):
        """月初へ丸められて返るぶんは、要求した期間まで切り詰める。"""
        response = self._response([100, 200, 300, 400, 500] + [0] * 87)
        history = tapo.extract_daily_history(
            response, datetime.date(2026, 8, 5), datetime.date(2026, 8, 4)
        )
        assert history == [(datetime.date(2026, 8, 4), 0.4)]

    def test_all_zero_returns_nothing(self):
        """一度も計測していないプラグは、0 で埋めずに何も送らない。"""
        response = self._response([0] * 92)
        assert (
            tapo.extract_daily_history(
                response, datetime.date(2026, 8, 5), datetime.date(2026, 8, 1)
            )
            == []
        )

    def test_accepts_unwrapped_payload(self):
        response = self._response([0, 0, 1234])["get_energy_data"]
        history = tapo.extract_daily_history(
            response, datetime.date(2026, 8, 4), datetime.date(2026, 8, 1)
        )
        assert history == [(datetime.date(2026, 8, 3), 1.234)]

    @pytest.mark.parametrize("response", [None, {}, {"data": [1, 2]}, {"start_timestamp": 0}])
    def test_broken_response_raises(self, response):
        with pytest.raises(ValueError):
            tapo.extract_daily_history(
                response, datetime.date(2026, 8, 5), datetime.date(2026, 8, 1)
            )


class TestLoadConfig:
    def test_requires_credentials(self, monkeypatch):
        monkeypatch.delenv("TAPO_USERNAME", raising=False)
        monkeypatch.setenv("TAPO_PASSWORD", "x")
        monkeypatch.setenv("TAPO_HOSTS", "192.168.1.21")
        with pytest.raises(tapo.ConfigError):
            tapo.load_config()

    def test_api_url_is_overridable(self, monkeypatch):
        monkeypatch.setenv("TAPO_USERNAME", "user@example.com")
        monkeypatch.setenv("TAPO_PASSWORD", "x")
        monkeypatch.setenv("TAPO_HOSTS", "192.168.1.21=冷蔵庫")
        monkeypatch.setenv("MYROOM_ENERGY_API_URL", "http://localhost:8000/api/energy")
        config = tapo.load_config()
        assert config["api_url"] == "http://localhost:8000/api/energy"
        assert config["hosts"] == [("192.168.1.21", "冷蔵庫")]

    def test_api_url_defaults_to_production(self, monkeypatch):
        monkeypatch.setenv("TAPO_USERNAME", "user@example.com")
        monkeypatch.setenv("TAPO_PASSWORD", "x")
        monkeypatch.setenv("TAPO_HOSTS", "192.168.1.21")
        monkeypatch.delenv("MYROOM_ENERGY_API_URL", raising=False)
        assert tapo.load_config()["api_url"] == tapo.DEFAULT_API_URL


    def test_hosts_optional_for_listing(self, monkeypatch):
        """`--list-devices` は IP を調べる機能なので TAPO_HOSTS 無しでも通す。"""
        monkeypatch.setenv("TAPO_USERNAME", "user@example.com")
        monkeypatch.setenv("TAPO_PASSWORD", "x")
        monkeypatch.delenv("TAPO_HOSTS", raising=False)
        assert tapo.load_config(require_hosts=False)["hosts"] == []

    def test_broken_hosts_do_not_block_listing(self, monkeypatch):
        monkeypatch.setenv("TAPO_USERNAME", "user@example.com")
        monkeypatch.setenv("TAPO_PASSWORD", "x")
        monkeypatch.setenv("TAPO_HOSTS", "=冷蔵庫")
        assert tapo.load_config(require_hosts=False)["hosts"] == []

    def test_credentials_are_still_required_for_listing(self, monkeypatch):
        """認証情報はディスカバリーにも要るので、こちらは必須のまま。"""
        monkeypatch.delenv("TAPO_USERNAME", raising=False)
        monkeypatch.setenv("TAPO_PASSWORD", "x")
        with pytest.raises(tapo.ConfigError):
            tapo.load_config(require_hosts=False)


class TestEnvFiles:
    def test_reads_key_value_pairs_and_ignores_comments(self, tmp_path):
        path = tmp_path / ".env"
        path.write_text(
            "# コメント\n"
            "export TAPO_HOSTS=\"192.168.1.21=冷蔵庫\"\n"
            "\n"
            "TAPO_USERNAME = user@example.com \n"
            "壊れた行\n",
            encoding="utf-8",
        )
        assert tapo.load_env_file(str(path)) == {
            "TAPO_HOSTS": "192.168.1.21=冷蔵庫",
            "TAPO_USERNAME": "user@example.com",
        }

    def test_missing_file_is_not_an_error(self, tmp_path):
        assert tapo.load_env_file(str(tmp_path / "nope.env")) == {}

    def test_existing_environment_wins(self, tmp_path, monkeypatch):
        """systemd や op run で渡した値を .env が上書きしないこと。"""
        path = tmp_path / ".env"
        path.write_text("TAPO_USERNAME=from-file\n", encoding="utf-8")
        monkeypatch.setenv("TAPO_USERNAME", "from-env")
        tapo.apply_env_files([str(path)])
        import os

        assert os.environ["TAPO_USERNAME"] == "from-env"


class TestReadEnergy:
    def test_falls_back_to_legacy_attributes(self):
        """`python-kasa` が古く Module.Energy を持たない場合でも読めること。"""

        class LegacyRealtime:
            power = 41.5

        class LegacyDevice:
            emeter_realtime = LegacyRealtime()
            emeter_today = 1.23
            modules = {}

        assert tapo._read_energy(LegacyDevice()) == {"power_w": 41.5, "kwh_today": 1.23}

    def test_device_without_energy_support(self):
        class PlainDevice:
            modules = {}

        assert tapo._read_energy(PlainDevice()) == {"power_w": None, "kwh_today": None}


class TestParseScanTarget:
    """`--scan` は1アドレスずつ当たるので、広すぎる指定を弾く。"""

    def test_accepts_slash_24(self):
        assert tapo.parse_scan_target("192.168.2.0/24") == ipaddress.ip_network(
            "192.168.2.0/24"
        )

    def test_host_bits_are_tolerated(self):
        """`192.168.2.167/24` のように自分の IP をそのまま貼っても通す。"""
        assert tapo.parse_scan_target("192.168.2.167/24") == ipaddress.ip_network(
            "192.168.2.0/24"
        )

    def test_invalid_cidr_raises(self):
        with pytest.raises(tapo.ConfigError):
            tapo.parse_scan_target("bogus")

    def test_too_wide_raises(self):
        with pytest.raises(tapo.ConfigError):
            tapo.parse_scan_target("10.0.0.0/8")

    def test_ipv6_raises(self):
        with pytest.raises(tapo.ConfigError):
            tapo.parse_scan_target("fd00::/64")


class TestLocalSubnet:
    """ユニキャスト走査の既定範囲。実際の経路表に依存しないよう socket を差し替える。"""

    def _fake_socket(self, monkeypatch, *, address=None, error=None):
        closed = []

        class FakeSocket:
            def connect(self, target):
                if error is not None:
                    raise error

            def getsockname(self):
                return (address, 12345)

            def close(self):
                closed.append(True)

        monkeypatch.setattr(tapo.socket, "socket", lambda *a, **kw: FakeSocket())
        return closed

    def test_derives_slash_24_from_own_address(self, monkeypatch):
        closed = self._fake_socket(monkeypatch, address="192.168.2.167")
        assert tapo.local_subnet() == ipaddress.ip_network("192.168.2.0/24")
        assert closed, "ソケットを閉じていない"

    def test_returns_none_when_route_lookup_fails(self, monkeypatch):
        closed = self._fake_socket(monkeypatch, error=OSError("no route"))
        assert tapo.local_subnet() is None
        assert closed, "失敗時もソケットを閉じること"


class TestCloseDevice:
    """`Unclosed client session` を出さないための後片付け（#199）。"""

    def test_disconnects_the_device(self):
        calls = []

        class Device:
            async def disconnect(self):
                calls.append(True)

        asyncio.run(tapo.close_device(Device()))
        assert calls == [True]

    def test_failure_is_swallowed(self):
        """切断できなくても本筋（読み取り・送信）は止めない。"""

        class Device:
            async def disconnect(self):
                raise RuntimeError("already gone")

        asyncio.run(tapo.close_device(Device()))


class TestHostsOptional:
    """#660: TAPO_HOSTS が無くても収集の設定は組める（探索で補う）。"""

    def test_collect_config_without_hosts(self, monkeypatch):
        monkeypatch.setenv("TAPO_USERNAME", "user@example.com")
        monkeypatch.setenv("TAPO_PASSWORD", "x")
        monkeypatch.delenv("TAPO_HOSTS", raising=False)
        assert tapo.load_config()["hosts"] == []

    def test_broken_hosts_still_fail_collect(self, monkeypatch):
        monkeypatch.setenv("TAPO_USERNAME", "user@example.com")
        monkeypatch.setenv("TAPO_PASSWORD", "x")
        monkeypatch.setenv("TAPO_HOSTS", "=冷蔵庫")
        with pytest.raises(tapo.ConfigError):
            tapo.load_config()


class TestMergeHosts:
    def test_manual_wins_for_same_ip(self):
        merged = tapo.merge_hosts(
            [("192.168.2.21", "冷蔵庫")],
            [("192.168.2.21", "Tapo P110"), ("192.168.2.30", "新しいプラグ")],
        )
        assert merged == [("192.168.2.21", "冷蔵庫"), ("192.168.2.30", "新しいプラグ")]

    def test_manual_only_device_is_kept(self):
        assert tapo.merge_hosts([("192.168.2.9", None)], []) == [("192.168.2.9", None)]

    def test_manual_name_uses_discovered_ip_after_dhcp_change(self):
        merged = tapo.merge_hosts(
            [("192.168.2.21", "冷蔵庫")],
            [("192.168.2.30", "冷蔵庫")],
        )
        assert merged == [("192.168.2.30", "冷蔵庫")]

    def test_manual_name_does_not_replace_different_discovered_device(self):
        merged = tapo.merge_hosts(
            [("192.168.2.21", "冷蔵庫")],
            [("192.168.2.30", "テレビ")],
        )
        assert merged == [("192.168.2.21", "冷蔵庫"), ("192.168.2.30", "テレビ")]

    def test_duplicate_discovered_name_does_not_replace_manual_ip(self):
        merged = tapo.merge_hosts(
            [("192.168.2.21", "冷蔵庫")],
            [("192.168.2.30", "冷蔵庫"), ("192.168.2.31", "冷蔵庫")],
        )
        assert merged == [
            ("192.168.2.21", "冷蔵庫"),
            ("192.168.2.30", "冷蔵庫"),
            ("192.168.2.31", "冷蔵庫"),
        ]


class TestHostsCache:
    def test_round_trip_and_fresh(self, tmp_path):
        path = str(tmp_path / "cache.json")
        tapo.save_hosts_cache(path, [("192.168.2.30", "新しいプラグ")], now=1000.0)
        hosts, fresh = tapo.load_hosts_cache(path, now=1000.0 + 60)
        assert hosts == [("192.168.2.30", "新しいプラグ")]
        assert fresh is True

    def test_expired_keeps_hosts_but_not_fresh(self, tmp_path):
        path = str(tmp_path / "cache.json")
        tapo.save_hosts_cache(path, [("192.168.2.30", None)], now=1000.0)
        hosts, fresh = tapo.load_hosts_cache(
            path, now=1000.0 + tapo.HOSTS_CACHE_TTL_SECONDS + 1
        )
        assert hosts == [("192.168.2.30", None)]
        assert fresh is False

    def test_missing_or_broken_file(self, tmp_path):
        assert tapo.load_hosts_cache(str(tmp_path / "none.json"), now=0) == ([], False)
        broken = tmp_path / "broken.json"
        broken.write_text("{not json", encoding="utf-8")
        assert tapo.load_hosts_cache(str(broken), now=0) == ([], False)
        wrong = tmp_path / "wrong.json"
        wrong.write_text(json.dumps({"saved_at": 1}), encoding="utf-8")
        assert tapo.load_hosts_cache(str(wrong), now=0) == ([], False)


class TestResolveHosts:
    CONFIG = {"username": "u", "password": "p", "hosts": [("192.168.2.21", "冷蔵庫")]}

    @pytest.fixture(autouse=True)
    def _fake_credentials(self, monkeypatch):
        monkeypatch.setattr(tapo, "Credentials", lambda *_: object())

    def _patch_discover(self, monkeypatch, result):
        calls = []

        async def fake(credentials, scan=None):
            calls.append(1)
            return result

        monkeypatch.setattr(tapo, "discover_hosts", fake)
        return calls

    def test_discovers_and_caches(self, monkeypatch, tmp_path):
        calls = self._patch_discover(monkeypatch, [("192.168.2.30", "新しいプラグ")])
        path = str(tmp_path / "c.json")
        hosts, discovered = asyncio.run(
            tapo.resolve_hosts(self.CONFIG, path, rediscover=False, now=1000.0)
        )
        assert discovered is True
        assert hosts == [("192.168.2.21", "冷蔵庫"), ("192.168.2.30", "新しいプラグ")]
        # 2回目はキャッシュが新しいので探索しない
        hosts2, discovered2 = asyncio.run(
            tapo.resolve_hosts(self.CONFIG, path, rediscover=False, now=1100.0)
        )
        assert discovered2 is False and hosts2 == hosts
        assert len(calls) == 1

    def test_rediscover_ignores_fresh_cache(self, monkeypatch, tmp_path):
        calls = self._patch_discover(monkeypatch, [("192.168.2.31", "もう1台")])
        path = str(tmp_path / "c.json")
        tapo.save_hosts_cache(path, [("192.168.2.30", "古い")], now=1000.0)
        hosts, discovered = asyncio.run(
            tapo.resolve_hosts(self.CONFIG, path, rediscover=True, now=1010.0)
        )
        assert discovered is True and len(calls) == 1
        assert ("192.168.2.31", "もう1台") in hosts
        assert ("192.168.2.30", "古い") not in hosts

    def test_empty_discovery_keeps_previous_cache(self, monkeypatch, tmp_path):
        self._patch_discover(monkeypatch, [])
        path = str(tmp_path / "c.json")
        tapo.save_hosts_cache(path, [("192.168.2.30", "前回")], now=0.0)
        hosts, _ = asyncio.run(
            tapo.resolve_hosts(self.CONFIG, path, rediscover=False, now=10_000.0)
        )
        assert ("192.168.2.30", "前回") in hosts

    def test_empty_discovery_is_remembered(self, monkeypatch, tmp_path):
        """0台のまま5分ごとに /24 を走査し直さない。"""
        calls = self._patch_discover(monkeypatch, [])
        path = str(tmp_path / "c.json")
        asyncio.run(tapo.resolve_hosts(self.CONFIG, path, False, now=1000.0))
        asyncio.run(tapo.resolve_hosts(self.CONFIG, path, False, now=1300.0))
        assert len(calls) == 1


class TestRunCollect:
    CONFIG = {
        "username": "u",
        "password": "p",
        "hosts": [("192.168.2.21", "冷蔵庫")],
        "api_url": "https://example.test/api/energy",
    }

    @staticmethod
    def _reading(host="192.168.2.30"):
        return {
            "host": host,
            "name": "新しいプラグ",
            "kwh_today": 1.2,
            "power_w": 42.0,
            "history": [],
        }

    def test_partial_failure_with_successful_post_exits_zero(self, monkeypatch, caplog):
        async def fake_resolve(*_args, **_kwargs):
            return [("192.168.2.21", "冷蔵庫"), ("192.168.2.30", None)], True

        async def fake_collect(*_args, **_kwargs):
            return [self._reading()]

        posted = []
        monkeypatch.setattr(tapo, "resolve_hosts", fake_resolve)
        monkeypatch.setattr(tapo, "collect", fake_collect)
        monkeypatch.setattr(tapo, "post_payload", lambda url, payload: posted.append((url, payload)))

        assert asyncio.run(tapo.run_collect(self.CONFIG, dry_run=False, days=1)) == 0
        assert posted[0][0] == self.CONFIG["api_url"]
        assert "TAPO_HOSTS の 192.168.2.21 を読み取れませんでした" in caplog.text

    def test_all_devices_unreadable_exits_nonzero(self, monkeypatch):
        async def fake_resolve(*_args, **_kwargs):
            return [("192.168.2.21", "冷蔵庫")], True

        async def fake_collect(*_args, **_kwargs):
            return []

        monkeypatch.setattr(tapo, "resolve_hosts", fake_resolve)
        monkeypatch.setattr(tapo, "collect", fake_collect)

        assert asyncio.run(tapo.run_collect(self.CONFIG, dry_run=False, days=1)) == 1

    def test_post_failure_exits_nonzero(self, monkeypatch):
        async def fake_resolve(*_args, **_kwargs):
            return [("192.168.2.30", None)], True

        async def fake_collect(*_args, **_kwargs):
            return [self._reading()]

        monkeypatch.setattr(tapo, "resolve_hosts", fake_resolve)
        monkeypatch.setattr(tapo, "collect", fake_collect)
        monkeypatch.setattr(tapo, "post_payload", lambda *_args: (_ for _ in ()).throw(OSError("offline")))

        assert asyncio.run(tapo.run_collect(self.CONFIG, dry_run=False, days=1)) == 1


class TestRefreshRequest:
    """画面の「候補を更新」への応え方（#692）。"""

    CONFIG = {
        "username": "u",
        "password": "p",
        "hosts": [],
        "api_url": "https://example.test/api/energy",
    }

    @pytest.fixture(autouse=True)
    def _fake_credentials(self, monkeypatch):
        monkeypatch.setattr(tapo, "Credentials", lambda *_: object())

    def test_candidates_url_is_under_energy(self):
        assert (
            tapo.candidates_url("https://example.test/api/energy/")
            == "https://example.test/api/energy/tapo-candidates"
        )

    def test_measurable_hosts_skips_unmeasurable(self):
        candidates = [
            {"host": "a", "name": "冷蔵庫", "model": "P110", "measurable": True},
            {"host": "b", "name": "ライト", "model": "P100", "measurable": False},
        ]
        assert tapo.measurable_hosts(candidates) == [("a", "冷蔵庫")]

    def test_answer_posts_all_candidates_and_caches_measurable(self, monkeypatch, tmp_path):
        candidates = [
            {"host": "a", "name": "冷蔵庫", "model": "P110", "measurable": True},
            {"host": "b", "name": "ライト", "model": "P100", "measurable": False},
        ]
        posted = []

        async def fake_discover(credentials, scan=None):
            return candidates

        monkeypatch.setattr(tapo, "discover_candidates", fake_discover)
        monkeypatch.setattr(tapo, "post_payload", lambda url, payload: posted.append((url, payload)))
        path = str(tmp_path / "c.json")

        asyncio.run(tapo.answer_refresh_request(self.CONFIG, path, now=1000.0))

        assert posted == [("https://example.test/api/energy/tapo-candidates", {"devices": candidates})]
        assert tapo.load_hosts_cache(path, now=1001.0) == ([("a", "冷蔵庫")], True)

    def test_zero_devices_still_posts_and_keeps_the_old_cache(self, monkeypatch, tmp_path):
        posted = []

        async def fake_discover(credentials, scan=None):
            return []

        monkeypatch.setattr(tapo, "discover_candidates", fake_discover)
        monkeypatch.setattr(tapo, "post_payload", lambda url, payload: posted.append(payload))
        path = str(tmp_path / "c.json")
        tapo.save_hosts_cache(path, [("a", "冷蔵庫")], 900.0)

        asyncio.run(tapo.answer_refresh_request(self.CONFIG, path, now=1000.0))

        assert posted == [{"devices": []}]
        assert tapo.load_hosts_cache(path, now=1001.0)[0] == [("a", "冷蔵庫")]

    def test_discovery_failure_still_answers_and_keeps_the_old_cache(self, monkeypatch, tmp_path):
        posted = []

        async def fail_discovery(credentials, scan=None):
            raise TimeoutError("discovery timed out")

        monkeypatch.setattr(tapo, "discover_candidates", fail_discovery)
        monkeypatch.setattr(tapo, "post_payload", lambda url, payload: posted.append(payload))
        path = str(tmp_path / "c.json")
        tapo.save_hosts_cache(path, [("a", "冷蔵庫")], 900.0)

        asyncio.run(tapo.answer_refresh_request(self.CONFIG, path, now=1000.0))

        assert posted == [{"devices": []}]
        assert tapo.load_hosts_cache(path, now=1001.0)[0] == [("a", "冷蔵庫")]


class TestRefetch:
    """画面からの「指定日以降の再取得」依頼（#711）。"""

    def test_days_count_from_since_including_today(self):
        today = datetime.date(2026, 10, 5)
        assert tapo.refetch_days(today, "2026-10-01") == 5
        assert tapo.refetch_days(today, "2026-10-05") == 1

    def test_days_are_capped_by_the_plug_history(self):
        assert tapo.refetch_days(datetime.date(2026, 10, 5), "2026-01-01") == tapo.MAX_DAYS

    def test_request_url_sits_under_api_energy(self):
        assert tapo.refetch_url("https://x/api/energy") == "https://x/api/energy/refetch"

    def test_request_without_key_is_not_sent(self, monkeypatch):
        """COLLECTOR_API_KEY が無いときは無認証で送らず、依頼なしとして扱う（#714）。"""
        monkeypatch.delenv("COLLECTOR_API_KEY", raising=False)

        def boom(*a, **k):
            raise AssertionError("must not call the API")

        monkeypatch.setattr(tapo.urllib.request, "urlopen", boom)
        assert tapo.fetch_refetch_request("https://x/api/energy") is None

    def test_stale_manual_host_is_one_not_found_by_discovery(self):
        """改名・撤去で探索に出てこない手書きの IP だけを古い設定とみなす（#728）。"""
        manual = [("192.168.2.168", "サブPC"), ("192.168.2.143", "乾燥機")]
        found = [("192.168.2.177", "乾燥機"), ("192.168.2.178", "PC")]
        assert tapo.stale_manual_hosts(
            manual, ["192.168.2.168", "192.168.2.177"], found
        ) == {"192.168.2.168"}
        # 探索が0台なら LAN 側の不調と区別できないので判断しない
        assert tapo.stale_manual_hosts(manual, ["192.168.2.168"], []) == set()

    def _run_with_refetch(self, monkeypatch, tmp_path, found):
        config = {
            "username": "u",
            "password": "p",
            "hosts": [("192.168.2.168", "サブPC")],
            "api_url": "https://example.test/api/energy",
        }
        monkeypatch.setattr(
            tapo,
            "fetch_refetch_request",
            lambda _url: {"pending": True, "since": "2026-10-02", "requested_at": "r"},
        )
        monkeypatch.setattr(tapo, "fetch_refresh_pending", lambda _url: False)
        cache = tmp_path / "c.json"
        monkeypatch.setattr(tapo, "HOSTS_CACHE_FILENAME", str(cache))

        async def fake_resolve(_config, path, rediscover, now=None):
            tapo.save_hosts_cache(path, found, time.time())
            return [("192.168.2.168", "サブPC"), ("192.168.2.178", "PC")], True

        async def fake_collect(*_args, **_kwargs):
            return [
                {
                    "host": "192.168.2.178",
                    "name": "PC",
                    "kwh_today": 0.1,
                    "power_w": 10.0,
                    "history": [],
                }
            ]

        done = []
        monkeypatch.setattr(tapo, "resolve_hosts", fake_resolve)
        monkeypatch.setattr(tapo, "collect", fake_collect)
        monkeypatch.setattr(tapo, "post_payload", lambda url, payload: {"status": "ok"})
        monkeypatch.setattr(tapo, "report_refetch_done", lambda url, r: done.append(r))
        assert asyncio.run(tapo.run_collect(config, dry_run=False, days=2)) == 0
        return done

    def test_refetch_completes_despite_stale_manual_host(self, monkeypatch, tmp_path):
        """TAPO_HOSTS に古い IP が残っていても再取得は完了にする（#728）。"""
        done = self._run_with_refetch(monkeypatch, tmp_path, [("192.168.2.178", "PC")])
        assert done == ["r"]

    def test_refetch_stays_pending_when_discovery_found_the_unread_host(
        self, monkeypatch, tmp_path
    ):
        """探索では見えているのに読めなかった機器は、従来どおり未完了のまま（#711）。"""
        done = self._run_with_refetch(
            monkeypatch,
            tmp_path,
            [("192.168.2.168", "サブPC"), ("192.168.2.178", "PC")],
        )
        assert done == []

    def test_request_and_done_carry_bearer(self, monkeypatch):
        monkeypatch.setenv("COLLECTOR_API_KEY", "k-1")
        seen = []

        class Resp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b'{"pending": true, "since": "2026-10-01", "requested_at": "r"}'

        def fake_urlopen(req, timeout=None):
            seen.append((req.full_url, req.get_header("Authorization")))
            return Resp()

        monkeypatch.setattr(tapo.urllib.request, "urlopen", fake_urlopen)
        assert tapo.fetch_refetch_request("https://x/api/energy")["requested_at"] == "r"
        tapo.report_refetch_done("https://x/api/energy", "r")
        assert [auth for _, auth in seen] == ["Bearer k-1", "Bearer k-1"]
