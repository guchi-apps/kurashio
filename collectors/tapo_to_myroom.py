#!/usr/bin/env python3
"""Tapo スマートプラグ（P110系）の消費電力を読んで MyRoom の `/api/energy` へ送る。

**計測のみ。ON/OFF の制御は行わない。**

サブPCの systemd user timer から5分ごとに実行する想定
（`collectors/systemd/myroom-tapo-energy.timer`）。`/api/energy` は同じ
`(date, source)` を上書きするため、当日ぶんを何度送っても二重計上しない。

置き場所と実行環境
------------------
ラズパイではなくサブPCで動かす。`python-kasa` が Python 3.11 以上と `cryptography` を
要求し、armv6 の Pi Zero W では導入が現実的でないため。プラグと同じ LAN にいれば
どこからでも読める（KLAP・TCP 80、ディスカバリーは UDP 20002）。

**このディレクトリの他の収集スクリプトと違い、依存が要る。** `python-kasa` はサブPCの
システムPythonに入っていないので、専用の venv を作って使う（`collectors/requirements-tapo.txt`）。

    python3 -m venv collectors/.venv-tapo
    collectors/.venv-tapo/bin/pip install -r collectors/requirements-tapo.txt

なぜ毎回ディスカバリーを投げるのか
----------------------------------
**停電やブレーカー断のあと、Tapo のローカル API はディスカバリー通信を受け取るまで
応答しない。** 遅延初期化のため、放っておくと数分〜場合によっては復活しない。
ホストを直接叩く前に必ずブロードキャストのディスカバリー（UDP/20002）を1回投げ、
その後で各機器へ接続する。1回あたり数百ミリ秒で済むので、毎回投げてよい。

ブロードキャストで見つからないとき
----------------------------------
**ディスカバリーの応答はホスト側のファイアウォールに落とされることがある。** ブロードキャスト
宛（255.255.255.255）に送った問い合わせへの応答は、送信元がプラグ個々の IP になるため
conntrack の ESTABLISHED に一致しない。サブPCのように ufw が `deny incoming` だと、
プラグは応答しているのに `[UFW BLOCK] ... SPT=20002` として捨てられ、0台に見える（#199）。

**ユニキャストなら通る。** そのため `--list-devices` はブロードキャストで0台だったときに
同じサブネットを1台ずつ当たり直す（`--scan` で範囲を指定できる）。収集本体は最初から
ユニキャストなので、この状態でも読み取りには影響しない。

プラグの追加は自動で反映する（#660）
------------------------------------
**`TAPO_HOSTS` は任意。** 収集のたびに LAN 上の Tapo 機器を探し（結果は
`collectors/.tapo-hosts.json` に `HOSTS_CACHE_TTL_SECONDS` だけ覚える）、計測できる機器を
自動で読む。Tapo アプリで足したプラグは、次の定期実行から消費電力に出る。
`TAPO_HOSTS` に書いた行は「名前の固定」と「探索で見つからない機器の指定」に使う。
同じ名前の機器を探索で見つけたときは、DHCP で変わった IP を探索結果へ置き換える。
到達不能な手書き IP があっても警告を残して探索を続け、ほかの機器の送信を止めない。
今すぐ反映したいときは `--rediscover`（キャッシュを捨てて探し直す）。

過去ぶんはプラグ本体から取る
--------------------------
**P110 系は日別の使用量をプラグ自身が覚えている。** `get_energy_data`（`interval=1440`）で
月初起点の 92 日ぶんが Wh の配列として返るため、収集を始める前の日や、収集が止まっていた
あいだの日も後から埋められる（#208）。当日ぶんだけを送っていた頃は、スクリプトを動かし
始めた日より前がグラフから抜けていた。

既定は当日を含めて `DEFAULT_DAYS` 日ぶん。**過去1か月ぶんの取り込みは `--days 31` を1度だけ
流す。** 5分ごとの定期実行で毎回30行を書き直すのは重いので、既定にはしない。

使い方:
  collectors/.venv-tapo/bin/python collectors/tapo_to_myroom.py
  collectors/.venv-tapo/bin/python collectors/tapo_to_myroom.py --days 31
  collectors/.venv-tapo/bin/python collectors/tapo_to_myroom.py --rediscover
  collectors/.venv-tapo/bin/python collectors/tapo_to_myroom.py --list-devices
  collectors/.venv-tapo/bin/python collectors/tapo_to_myroom.py --list-devices --scan 192.168.2.0/24
  collectors/.venv-tapo/bin/python collectors/tapo_to_myroom.py --dry-run -v
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import ipaddress
import json
import logging
import os
import socket
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import os.path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

try:
    from kasa import Credentials, Discover
except ImportError:  # pragma: no cover - サブPCの実行環境にだけ必要
    # **import 時には落とさない。** python-kasa が入っているのはサブPCの収集用 venv
    # だけで、バックエンドのテスト環境には無い。ここで SystemExit すると
    # `pytest tests/` がこのモジュールを収集した時点で失敗する。
    Credentials = None  # type: ignore[assignment]
    Discover = None  # type: ignore[assignment]


LOGGER = logging.getLogger("tapo_to_myroom")

#: `daily_energy.source` の前置き。エアコン（`aircon`）と同じテーブルに混ぜるための名前空間
SOURCE_PREFIX = "tapo:"

#: 送り先。`collectors/aircon_energy_to_myroom.py` と同じ環境変数名で上書きできる
DEFAULT_API_URL = "https://myroom.gucchii.com/api/energy"

#: JST。MyRoom の集計は JST の暦日で区切る（backend/main.py の `get_now_jst()` と同じ）
JST = datetime.timezone(datetime.timedelta(hours=9))

DISCOVERY_TIMEOUT = 5
CONNECT_TIMEOUT = 10
POST_TIMEOUT = 15

#: ユニキャスト走査で1台に待つ秒数。LAN内なので応答は数十msで返る
SCAN_TIMEOUT = 3
#: ユニキャスト走査の同時実行数。/24 を SCAN_TIMEOUT=3 で約12秒
SCAN_CONCURRENCY = 64
#: 走査を受け付ける最大アドレス数（/20）。家庭のLANでこれを超える指定は打ち間違い
SCAN_MAX_HOSTS = 4096

#: 既定で送り直す日数（当日を含む）。当日ぶんは1日のあいだ増えていくので、直近の確定値も
#: 一緒に送り直して最終値へ寄せる。`collectors/aircon_energy_to_myroom.py` の
#: `DEFAULT_DAYS` と同じ考え方。
DEFAULT_DAYS = 3

#: `--days` の上限。プラグが返す日別履歴が月初起点の92日ぶんまでのため、これより
#: 大きい指定は受け付けても意味が無い。
MAX_DAYS = 92

#: `get_energy_data` の `interval`（分）。1440 = 1日ごと。
DAILY_INTERVAL_MINUTES = 1440


#: 探索結果（IP と名前）を覚えておく秒数。5分ごとの実行で毎回 /24 を走査しないため。
HOSTS_CACHE_TTL_SECONDS = 3600

#: 探索結果の置き場。`collectors/.env` と同じ場所（.gitignore 済み）
HOSTS_CACHE_FILENAME = ".tapo-hosts.json"


class ConfigError(Exception):
    """環境変数が足りない・壊れている。"""


# ---------------------------------------------------------------- 設定


def load_env_file(path: str) -> Dict[str, str]:
    """`KEY=value` 形式を読む簡易パーサ。

    `python-dotenv` はサブPCのシステムPythonに入っていない。ここで要るのは数行の
    `KEY=value` だけなので、依存を増やさず自前で読む。
    （`collectors/aircon_energy_to_myroom.py` にも同じものがある。片方だけの都合で
    直さないこと。）
    """
    values: Dict[str, str] = {}
    if not os.path.isfile(path) or not os.access(path, os.R_OK):
        return values

    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export ") :].strip()
            key, sep, value = line.partition("=")
            if not sep:
                continue
            key = key.strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]
            if key:
                values[key] = value
    return values


def apply_env_files(paths: Sequence[str]) -> None:
    """先に挙げたファイルを優先して環境変数へ載せる（既存の環境変数は上書きしない）。"""
    for path in paths:
        for key, value in load_env_file(path).items():
            os.environ.setdefault(key, value)


def _require_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ConfigError(f"環境変数 {name} が設定されていません")
    return value


def parse_hosts(raw: str) -> List[Tuple[str, Optional[str]]]:
    """`TAPO_HOSTS` を (IP, 表示名) の並びへ。

    `192.168.1.21=冷蔵庫,192.168.1.22` のように書く。`=表示名` を省いた場合は
    プラグ自身に設定されている名前（alias）を使う。
    """
    hosts: List[Tuple[str, Optional[str]]] = []
    for chunk in raw.split(","):
        entry = chunk.strip()
        if not entry:
            continue
        host, sep, name = entry.partition("=")
        host = host.strip()
        if not host:
            raise ConfigError(f"TAPO_HOSTS の書式が不正です: {entry!r}")
        hosts.append((host, name.strip() if sep and name.strip() else None))
    if not hosts:
        raise ConfigError("TAPO_HOSTS にプラグが1つも書かれていません")
    return hosts


def load_config(require_hosts: bool = True) -> Dict[str, Any]:
    """設定を環境変数から組み立てる。

    **`TAPO_HOSTS` は任意**（#660）。無ければ探索だけで機器を決める。書いてあるのに
    壊れているときは、収集では設定ミスとして落とし、`--list-devices`（`require_hosts=False`）
    では警告だけで探索を続ける（IP を調べる機能なので、そこで止めない）。
    """
    raw_hosts = os.getenv("TAPO_HOSTS", "").strip()
    hosts: List[Tuple[str, Optional[str]]] = []
    if raw_hosts:
        try:
            hosts = parse_hosts(raw_hosts)
        except ConfigError as exc:
            if require_hosts:
                raise
            LOGGER.warning("TAPO_HOSTS を読めませんでした（探索には影響しません）: %s", exc)

    return {
        "username": _require_env("TAPO_USERNAME"),
        "password": _require_env("TAPO_PASSWORD"),
        "hosts": hosts,
        "api_url": os.getenv("MYROOM_ENERGY_API_URL", DEFAULT_API_URL).strip(),
    }


def merge_hosts(
    manual: Sequence[Tuple[str, Optional[str]]],
    discovered: Sequence[Tuple[str, Optional[str]]],
) -> List[Tuple[str, Optional[str]]]:
    """`TAPO_HOSTS`（手書き）と探索結果を1つの並びへ。

    手書きの表示名と探索した alias が一致すれば、表示名を保ったまま探索側の
    IP を使う。DHCP により IP が変わっても、表示名を `daily_energy.source` として
    継続させるためである。名前で一致しない手書き IP は、探索で見つからない機器を
    読むために残す。
    """
    discovered_name_counts: Dict[str, int] = {}
    for _, name in discovered:
        if name is not None:
            discovered_name_counts[name] = discovered_name_counts.get(name, 0) + 1
    discovered_by_name = {
        name: host
        for host, name in discovered
        if name is not None and discovered_name_counts[name] == 1
    }
    merged = [
        (discovered_by_name.get(name, host), name)
        for host, name in manual
    ]
    seen = {host for host, _ in merged}
    for host, name in discovered:
        if host in seen:
            continue
        seen.add(host)
        merged.append((host, name))
    return merged


def load_hosts_cache(
    path: str, now: float, ttl: int = HOSTS_CACHE_TTL_SECONDS
) -> Tuple[List[Tuple[str, Optional[str]]], bool]:
    """探索結果のキャッシュを読む。戻り値は (機器の並び, まだ新しいか)。

    壊れている・無いときは `([], False)`。期限切れでも中身は返す（探索が0台だったとき、
    前回の機器を捨てないため）。
    """
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        saved_at = float(data["saved_at"])
        hosts = [
            (str(item["host"]), item.get("name") or None) for item in data["hosts"]
        ]
    except (OSError, ValueError, KeyError, TypeError):
        return [], False
    return hosts, 0 <= now - saved_at < ttl


def save_hosts_cache(
    path: str, hosts: Sequence[Tuple[str, Optional[str]]], now: float
) -> None:
    """一時ファイル＋置き換えで書く（途中で落ちても壊れたJSONを残さない）。"""
    payload = {
        "saved_at": now,
        "hosts": [{"host": host, "name": name} for host, name in hosts],
    }
    directory = os.path.dirname(path) or "."
    try:
        fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".tapo-hosts-")
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
        os.replace(tmp_path, path)
    except OSError as exc:  # キャッシュが書けなくても収集は続ける
        LOGGER.warning("探索結果を保存できませんでした: %s", exc)


# ---------------------------------------------------------------- 機器の読み取り


async def wake_up_devices(credentials: Credentials) -> Dict[str, Any]:
    """ブロードキャストのディスカバリーを1回投げる。

    戻り値は「見つかった機器」だが、**主目的は返り値ではなく、停電明けに眠っている
    ローカル API を起こすこと**。失敗しても後続の接続は試すので、例外は握りつぶす。
    """
    try:
        found = await Discover.discover(
            credentials=credentials, discovery_timeout=DISCOVERY_TIMEOUT
        )
    except Exception as exc:  # noqa: BLE001 - 起こすのが目的で、結果は使わなくてよい
        LOGGER.warning("ディスカバリーに失敗しました（接続は続行します）: %s", exc)
        return {}
    LOGGER.debug("ディスカバリーで %d 台見つかりました", len(found))
    return found


async def close_device(device: Any) -> None:
    """機器との接続を閉じる。

    閉じないと python-kasa が握っている aiohttp のセッションが解放時に
    `Unclosed client session` を **ERROR で** 吐く。実際には成功しているのに
    `journalctl` では失敗に見えるため、読み終えたら必ず閉じる。
    """
    try:
        await device.disconnect()
    except Exception as exc:  # noqa: BLE001 - 後片付けの失敗は本筋に影響しない
        LOGGER.debug("切断に失敗しました: %s", exc)


def parse_scan_target(raw: str) -> ipaddress.IPv4Network:
    """`--scan` の CIDR を検証して返す。

    1アドレスずつ当たるので、広すぎる指定は事故になる（`/8` は1600万アドレス）。
    家庭のLANで想定するのは `/24`〜`/20` まで。
    """
    try:
        network = ipaddress.ip_network(raw, strict=False)
    except ValueError as exc:
        raise ConfigError(f"--scan の指定が不正です（{raw}）: {exc}") from exc
    if not isinstance(network, ipaddress.IPv4Network):
        raise ConfigError(f"--scan は IPv4 のみ対応しています: {raw}")
    if network.num_addresses > SCAN_MAX_HOSTS:
        raise ConfigError(
            f"--scan の範囲が広すぎます（{network} = {network.num_addresses} アドレス）。"
            f"{SCAN_MAX_HOSTS} アドレス以内で指定してください"
        )
    return network


def local_subnet() -> Optional[ipaddress.IPv4Network]:
    """既定の経路が出ていくインターフェースの IP から、走査するサブネット（/24）を推定する。

    UDP ソケットの `connect()` はパケットを送らず、カーネルの経路表を引くだけ。相手へ
    到達できなくても、既定経路のインターフェースのアドレスが取れる。Tailscale の
    アドレスは /32 で既定経路を持たないため、ここには出てこない。

    **/24 決め打ち。** それ以外のLANでは `--scan` で明示すること。
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("192.0.2.1", 9))  # TEST-NET-1。実際には送らない
        address = sock.getsockname()[0]
    except OSError as exc:
        LOGGER.warning("自ホストの IP を取得できませんでした: %s", exc)
        return None
    finally:
        sock.close()

    try:
        return ipaddress.ip_network(f"{address}/24", strict=False)
    except ValueError as exc:  # pragma: no cover - getsockname が壊れた値を返した場合
        LOGGER.warning("サブネットを決められませんでした（%s）: %s", address, exc)
        return None


async def _probe_host(
    host: str, credentials: Credentials, semaphore: asyncio.Semaphore
) -> Optional[Any]:
    async with semaphore:
        try:
            return await asyncio.wait_for(
                Discover.discover_single(host, credentials=credentials),
                timeout=SCAN_TIMEOUT,
            )
        except Exception:  # noqa: BLE001 - 大半は「Tapo 機器ではない」だけなので黙る
            return None


async def scan_subnet(
    network: ipaddress.IPv4Network, credentials: Credentials
) -> Dict[str, Any]:
    """サブネットの各アドレスへ**ユニキャストで**ディスカバリーを投げて機器を探す。

    ブロードキャストの応答がファイアウォールに落とされる環境（モジュール冒頭の説明を
    参照）向けのフォールバック。/24 なら十数秒で終わる。
    """
    hosts = [str(host) for host in network.hosts()]
    LOGGER.info("%s を1台ずつ探します（%d アドレス）…", network, len(hosts))
    semaphore = asyncio.Semaphore(SCAN_CONCURRENCY)
    devices = await asyncio.gather(
        *(_probe_host(host, credentials, semaphore) for host in hosts)
    )
    return {
        host: device for host, device in zip(hosts, devices) if device is not None
    }


def _energy_module(device: Any) -> Optional[Any]:
    """python-kasa 0.7 以降の Energy モジュールを返す。古い版・非対応機器では None。"""
    try:
        from kasa import Module  # 遅延 import（古い版には Module が無い）

        return device.modules.get(Module.Energy)
    except Exception:  # noqa: BLE001 - 古い版へのフォールバックに落とす
        return None


def _read_energy(device: Any) -> Dict[str, Optional[float]]:
    """python-kasa のバージョン差を吸収して、瞬時値と当日積算を取り出す。

    0.7 以降は `device.modules[Module.Energy]`、それ以前は `device.emeter_realtime`。
    どちらも無ければ「エネルギー計測に対応していない機器」として None を返す。
    """
    power_w: Optional[float] = None
    kwh_today: Optional[float] = None

    module = _energy_module(device)

    if module is not None:
        power_w = getattr(module, "current_consumption", None)
        kwh_today = getattr(module, "consumption_today", None)
    else:
        realtime = getattr(device, "emeter_realtime", None)
        if realtime is not None:
            power_w = getattr(realtime, "power", None)
        kwh_today = getattr(device, "emeter_today", None)

    return {
        "power_w": float(power_w) if power_w is not None else None,
        "kwh_today": float(kwh_today) if kwh_today is not None else None,
    }


def window_start(today: datetime.date, days: int) -> datetime.date:
    """送り直す期間の先頭。`days=1` なら当日のみ（従来の挙動）。"""
    if days < 1:
        raise ValueError("days must be >= 1")
    return today - datetime.timedelta(days=days - 1)


def _day_start_timestamp(date: datetime.date) -> int:
    return int(datetime.datetime.combine(date, datetime.time(), JST).timestamp())


def extract_daily_history(
    response: Any, today: datetime.date, start: datetime.date
) -> List[Tuple[datetime.date, float]]:
    """`get_energy_data` の応答を `(日付, kWh)` の並びへ。古い順。

    応答の `data` は **Wh の配列**で、`start_timestamp` の日から1日ずつ並ぶ。要求した
    期間より広く返る（プラグ側が起点を月初へ丸め、92日ぶん返す）ため、こちらで切り詰める。

    **計測を始める前の日も `0` が返る。** 「まだ計測していない日」と「本当に0だった日」は
    区別できないので、**配列全体で最初に0でなかった日より前は捨てる**（プラグを付ける前の
    日が0で埋まり、グラフが平らに伸びるのを防ぐ）。その日以降の0は「使わなかった日」
    として残す。

    当日ぶんは瞬時電力と一緒に別途送るため、ここには含めない。
    """
    payload = response.get("get_energy_data", response) if isinstance(response, dict) else None
    if not isinstance(payload, dict):
        raise ValueError("get_energy_data の応答が辞書ではありません")

    data = payload.get("data")
    start_timestamp = payload.get("start_timestamp")
    if not isinstance(data, list) or start_timestamp is None:
        raise ValueError("get_energy_data の応答に data / start_timestamp がありません")

    first_day = datetime.datetime.fromtimestamp(int(start_timestamp), JST).date()
    first_measured = next((index for index, value in enumerate(data) if value), None)
    if first_measured is None:
        return []

    history: List[Tuple[datetime.date, float]] = []
    for index in range(first_measured, len(data)):
        date = first_day + datetime.timedelta(days=index)
        if date < start or date >= today:
            continue
        value = data[index]
        if value is None:
            continue
        history.append((date, round(float(value) / 1000.0, 3)))
    return history


async def read_daily_history(
    device: Any, today: datetime.date, start: datetime.date
) -> Optional[List[Tuple[datetime.date, float]]]:
    """プラグ本体が持つ日別履歴を読む。読めなければ None（当日ぶんの送信は止めない）。

    履歴を持たない機器は空。None は「取れなかった」ことを呼び出し側へ伝えるためで、
    再取得（#711）では過去分を送れていないのに完了にしないために使う。"""
    module = _energy_module(device)
    if module is None:
        return []

    params = {
        # プラグは起点を月初へ丸めるので、こちらも月初で渡して素直に受け取る
        "start_timestamp": _day_start_timestamp(start.replace(day=1)),
        "end_timestamp": _day_start_timestamp(today + datetime.timedelta(days=1)),
        "interval": DAILY_INTERVAL_MINUTES,
    }
    try:
        response = await asyncio.wait_for(
            module.call("get_energy_data", params), timeout=CONNECT_TIMEOUT
        )
    except Exception as exc:  # noqa: BLE001 - 過去ぶんが取れなくても当日ぶんは送る
        LOGGER.warning("日別履歴を取得できませんでした: %s", exc)
        return None

    try:
        return extract_daily_history(response, today, start)
    except (ValueError, TypeError, OverflowError, OSError) as exc:
        LOGGER.warning("日別履歴を解釈できませんでした: %s", exc)
        return None


async def read_device(
    host: str,
    name_override: Optional[str],
    credentials: Credentials,
    today: datetime.date,
    start: datetime.date,
) -> Optional[Dict[str, Any]]:
    """1台ぶんを読む。読めなければ None（他の機器の送信は止めない）。"""
    device = None
    try:
        device = await asyncio.wait_for(
            Discover.discover_single(host, credentials=credentials),
            timeout=CONNECT_TIMEOUT,
        )
        await asyncio.wait_for(device.update(), timeout=CONNECT_TIMEOUT)
    except Exception as exc:  # noqa: BLE001 - 1台の不調で全体を落とさない
        LOGGER.warning("%s へ接続できませんでした: %s", host, exc)
        if device is not None:
            await close_device(device)
        return None

    try:
        energy = _read_energy(device)
        if energy["kwh_today"] is None and energy["power_w"] is None:
            LOGGER.warning("%s はエネルギー計測に対応していないようです", host)
            return None

        history = (
            await read_daily_history(device, today, start) if start < today else []
        )
        history_failed = history is None

        return {
            "host": host,
            "name": name_override or getattr(device, "alias", None) or host,
            "model": getattr(device, "model", None),
            "history": history or [],
            "history_failed": history_failed,
            **energy,
        }
    finally:
        await close_device(device)


async def collect(
    config: Dict[str, Any],
    hosts: Sequence[Tuple[str, Optional[str]]],
    today: datetime.date,
    start: datetime.date,
) -> List[Dict[str, Any]]:
    credentials = Credentials(config["username"], config["password"])
    for device in (await wake_up_devices(credentials)).values():
        await close_device(device)

    results = await asyncio.gather(
        *(
            read_device(host, name, credentials, today, start)
            for host, name in hosts
        )
    )
    return [item for item in results if item is not None]


# ---------------------------------------------------------------- 送信


def build_payload(
    readings: List[Dict[str, Any]], today: datetime.date
) -> Dict[str, Any]:
    """`POST /api/energy` の本文を作る。古い日付から順に並べる。

    同じ (date, source) は API 側で上書きされる。当日の積算は1日のあいだ増えていくため、
    追記ではなく上書きでないと二重計上になる。

    **瞬時電力（`power_w`）が付くのは当日ぶんだけ。** 過去ぶんはプラグの日別履歴から
    取っており、その日の瞬時値は残っていない。
    """
    records: List[Dict[str, Any]] = []
    for item in readings:
        source = f"{SOURCE_PREFIX}{item['name']}"
        for date, kwh in item.get("history") or ():
            records.append(
                {
                    "date": date.isoformat(),
                    "source": source,
                    "kwh": kwh,
                    "power_w": None,
                }
            )
        if item["kwh_today"] is not None:
            records.append(
                {
                    "date": today.isoformat(),
                    "source": source,
                    "kwh": item["kwh_today"],
                    "power_w": item["power_w"],
                }
            )
    return {"records": records}


def post_payload(
    api_url: str, payload: Dict[str, Any], bearer: Optional[str] = None
) -> Dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    request = urllib.request.Request(api_url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=POST_TIMEOUT) as response:
        return json.loads(response.read().decode("utf-8"))


# ---------------------------------------------------------------- CLI


NOT_FOUND_HINT = """LAN 上に Tapo 機器が見つかりませんでした。次を確認してください。

  1. プラグがこのホストと同じ LAN・同じ VLAN にあり、ping が通ること
  2. ホストのファイアウォールがディスカバリーの応答を落としていないこと
     （ufw が deny incoming だとブロードキャストの応答は捨てられます）

       journalctl -k --since '-5min' | grep 'UFW BLOCK' | grep 'SPT=20002'

     ここに行が出ていれば、プラグは応答しているのに捨てられています。
     IP が分かっているなら TAPO_HOSTS に直接書けば収集は動きます（収集は
     ユニキャストのため、この状態でも読めます）。
  3. サブネットが /24 でない場合は --scan で範囲を指定すること
     （例: --scan 192.168.2.0/23）"""


async def find_devices(
    credentials: Credentials, scan: Optional[str]
) -> Dict[str, Any]:
    """LAN 上の Tapo 機器を探す。ブロードキャストが空ならユニキャスト走査へ落とす。

    ブロードキャストの応答はファイアウォールに落とされることがある（#199）。
    `--scan` の指定が不正なら `ConfigError`。
    """
    found = await wake_up_devices(credentials)
    if found:
        return found

    LOGGER.info(
        "ブロードキャストでは見つかりませんでした。"
        "ユニキャストで探し直します（応答がファイアウォールに落とされている可能性）。"
    )
    network = parse_scan_target(scan) if scan else local_subnet()
    if network is None:
        return {}
    return await scan_subnet(network, credentials)


async def discover_candidates(
    credentials: Credentials, scan: Optional[str] = None
) -> List[Dict[str, Any]]:
    """探索して、見つかった Tapo 機器を全部返す（#692）。計測できない機器も含める。

    画面の「Tapoの候補」に出すため。`measurable` が偽の機器（P100 など）は読み取り対象にしない。
    """
    found = await find_devices(credentials, scan)
    candidates: List[Dict[str, Any]] = []
    for host, device in found.items():
        try:
            await asyncio.wait_for(device.update(), timeout=CONNECT_TIMEOUT)
            energy = _read_energy(device)
            measurable = not (energy["kwh_today"] is None and energy["power_w"] is None)
            if not measurable:
                LOGGER.info("%s は計測に対応していないので対象外にします", host)
            candidates.append(
                {
                    "host": host,
                    "name": getattr(device, "alias", None) or None,
                    "model": getattr(device, "model", None),
                    "measurable": measurable,
                }
            )
        except Exception as exc:  # noqa: BLE001 - 1台の不調で探索全体を止めない
            LOGGER.warning("%s を確認できませんでした: %s", host, exc)
        finally:
            await close_device(device)
    return candidates


def measurable_hosts(
    candidates: Sequence[Dict[str, Any]],
) -> List[Tuple[str, Optional[str]]]:
    return [(c["host"], c["name"]) for c in candidates if c["measurable"]]


async def discover_hosts(
    credentials: Credentials, scan: Optional[str] = None
) -> List[Tuple[str, Optional[str]]]:
    """探索して、エネルギー計測できる機器を (IP, alias) で返す（#660）。"""
    return measurable_hosts(await discover_candidates(credentials, scan))


def candidates_url(api_url: str) -> str:
    """候補の受け口。`/api/energy` の下にある（#692）。"""
    return api_url.rstrip("/") + "/tapo-candidates"


#: 再取得の依頼（#711）で `/api/energy/refetch/request` へ名乗る収集の名前
REFETCH_KIND = "tapo"


def refetch_url(api_url: str) -> str:
    """再取得の受け口。`/api/energy` の下にある（#711）。"""
    return api_url.rstrip("/") + "/refetch"


def collector_api_key() -> Optional[str]:
    """再取得の2口へ送る収集専用トークン（`COLLECTOR_API_KEY`・#714）。未設定なら None。"""
    return os.getenv("COLLECTOR_API_KEY", "").strip() or None


def fetch_refetch_request(api_url: str) -> Optional[Dict[str, Any]]:
    """画面から「指定日以降を再取得」が依頼されていれば、その内容を返す。

    読めなければ None（定期実行そのものは止めない）。
    """
    key = collector_api_key()
    if not key:
        # 無認証では送らない（サーバーは 503/401 で断る）。通常の収集は続ける
        LOGGER.warning("COLLECTOR_API_KEY が未設定のため、再取得の依頼は確認しません")
        return None
    try:
        query = urllib.parse.urlencode({"kind": REFETCH_KIND})
        req = urllib.request.Request(
            f"{refetch_url(api_url)}/request?{query}",
            headers={"Authorization": f"Bearer {key}"},
        )
        with urllib.request.urlopen(req, timeout=POST_TIMEOUT) as response:
            data = json.loads(response.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - 依頼を読めなくても通常の収集は続ける
        LOGGER.warning("再取得の依頼を確認できませんでした: %s", exc)
        return None
    if not data.get("pending") or not data.get("since") or not data.get("requested_at"):
        return None
    return data


def refetch_days(today: datetime.date, since: str) -> int:
    """依頼の日付から、当日を含めて何日ぶん取り直すか。プラグが持つ履歴の上限で切る。"""
    start = datetime.date.fromisoformat(since)
    return max(1, min(MAX_DAYS, (today - start).days + 1))


def report_refetch_done(api_url: str, requested_at: str) -> None:
    """取り直して送れたことを知らせる。失敗しても次回また取り直すだけなので落とさない。"""
    try:
        post_payload(
            f"{refetch_url(api_url)}/done",
            {"kind": REFETCH_KIND, "requested_at": requested_at},
            bearer=collector_api_key(),
        )
    except Exception as exc:  # noqa: BLE001
        LOGGER.warning("再取得の完了を報告できませんでした: %s", exc)


def fetch_refresh_pending(api_url: str) -> bool:
    """画面から「候補を更新」が押されて、まだ応えていないか。

    読めなければ False（定期実行そのものは止めない）。
    """
    try:
        with urllib.request.urlopen(
            candidates_url(api_url) + "/request", timeout=POST_TIMEOUT
        ) as response:
            return bool(json.loads(response.read().decode("utf-8")).get("pending"))
    except Exception as exc:  # noqa: BLE001 - 依頼を読めなくても収集は続ける
        LOGGER.warning("更新依頼を確認できませんでした: %s", exc)
        return False


async def answer_refresh_request(
    config: Dict[str, Any], cache_path: str, now: Optional[float] = None
) -> None:
    """更新依頼に応える。探索し直して候補を送り、探索結果のキャッシュも新しくする。

    **0台でも送る。** 送らないと画面が「更新中」のまま待ち続ける。0台のときはキャッシュを
    上書きしない（前回の機器を捨てない）。
    """
    now = time.time() if now is None else now
    credentials = Credentials(config["username"], config["password"])
    try:
        candidates = await discover_candidates(credentials)
    except Exception as exc:  # noqa: BLE001 - 探索失敗でも0台を返して画面の待機を終える
        LOGGER.warning("探索できませんでした: %s", exc)
        candidates = []

    hosts = measurable_hosts(candidates)
    if hosts:
        save_hosts_cache(cache_path, hosts, now)
    try:
        post_payload(candidates_url(config["api_url"]), {"devices": candidates})
    except Exception as exc:  # noqa: BLE001 - 次の定期実行でまだ依頼が残っていれば再送する
        LOGGER.error("候補の送信に失敗しました: %s", exc)
        return
    LOGGER.info("候補を送りました（%d 台・うち計測できる機器 %d 台）", len(candidates), len(hosts))


def stale_manual_hosts(
    manual: Sequence[Tuple[str, Optional[str]]],
    unread_hosts: Sequence[str],
    found: Sequence[Tuple[str, Optional[str]]],
) -> Set[str]:
    """`TAPO_HOSTS` に書かれているのに読めず、探索でも見つからなかった IP（#728）。

    プラグを Tapo アプリで改名すると、`merge_hosts()` は名前で新しい IP へ付け替えられず、
    古い IP が手書きのまま残る（「サブPC」を「PC」へ改名した実例）。これを読めない機器として
    数えると、再取得の依頼が完了しないまま期限切れになる。

    探索が1台も見つけられなかったとき（LAN 側の不調）は判断できないので空を返す。
    """
    found_ips = {host for host, _ in found}
    if not found_ips:
        return set()
    manual_ips = {host for host, _ in manual}
    return {
        host for host in unread_hosts if host in manual_ips and host not in found_ips
    }


async def resolve_hosts(
    config: Dict[str, Any],
    cache_path: str,
    rediscover: bool,
    now: Optional[float] = None,
) -> Tuple[List[Tuple[str, Optional[str]]], bool]:
    """読む機器を決める。戻り値は (機器の並び, 今回探索したか)。"""
    now = time.time() if now is None else now
    cached, fresh = load_hosts_cache(cache_path, now)
    discovered = False
    if rediscover or not fresh:
        credentials = Credentials(config["username"], config["password"])
        try:
            found = await discover_hosts(credentials)
        except ConfigError as exc:
            LOGGER.warning("探索できませんでした: %s", exc)
            found = []
        discovered = True
        if found:
            cached = found
            save_hosts_cache(cache_path, cached, now)
        else:
            LOGGER.warning("探索で機器が見つかりませんでした（前回の結果があればそれを使います）")
            if not cached:
                # 0台のまま毎回（5分ごと）走査し直さないよう、空でも探索した時刻を残す
                save_hosts_cache(cache_path, [], now)
    return merge_hosts(config["hosts"], cached), discovered


async def run_list_devices(config: Dict[str, Any], scan: Optional[str]) -> int:
    credentials = Credentials(config["username"], config["password"])
    try:
        found = await find_devices(credentials, scan)
    except ConfigError as exc:
        LOGGER.error("%s", exc)
        return 2

    if not found:
        print(NOT_FOUND_HINT)
        return 1

    print(f"{len(found)} 台見つかりました。TAPO_HOSTS にはこの IP を書きます。\n")
    for host, device in found.items():
        try:
            await device.update()
        except Exception as exc:  # noqa: BLE001 - 一覧表示なので読めない機器も出す
            print(f"  {host}  (更新できませんでした: {exc})")
            await close_device(device)
            continue
        energy = _read_energy(device)
        supported = "計測あり" if energy["kwh_today"] is not None else "計測なし"
        print(
            f"  {host:<16} {getattr(device, 'alias', '?')}"
            f"  [{getattr(device, 'model', '?')}] {supported}"
        )
        await close_device(device)
    return 0


async def run_collect(
    config: Dict[str, Any], dry_run: bool, days: int, rediscover: bool = False
) -> int:
    today = datetime.datetime.now(JST).date()
    refetch = None if dry_run else fetch_refetch_request(config["api_url"])
    if refetch:
        try:
            days = max(days, refetch_days(today, refetch["since"]))
            LOGGER.info("再取得の依頼があります（%s 以降・%d 日ぶん）", refetch["since"], days)
        except ValueError:
            LOGGER.warning("再取得の依頼の日付を読めませんでした: %r", refetch.get("since"))
            refetch = None
    start = window_start(today, days)
    cache_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), HOSTS_CACHE_FILENAME)

    if not dry_run and fetch_refresh_pending(config["api_url"]):
        # 探索結果をキャッシュへ書くので、直後の resolve_hosts は探し直さずにそれを使う
        await answer_refresh_request(config, cache_path)

    hosts, discovered = await resolve_hosts(config, cache_path, rediscover)
    if not hosts:
        LOGGER.error("読み取る機器がありません（探索でも TAPO_HOSTS でも見つかりませんでした）")
        return 1

    readings = await collect(config, hosts, today, start)
    read_hosts = {item["host"] for item in readings}
    manual_hosts = {host for host, _ in config["hosts"]}
    unread_hosts = [h for h, _ in hosts if h not in read_hosts]
    for host in unread_hosts:
        if host in manual_hosts:
            LOGGER.warning(
                "TAPO_HOSTS の %s を読み取れませんでした。IP が古い可能性があります",
                host,
            )
    if unread_hosts and not discovered:
        # DHCP 変更・撤去で既存の IP に繋がらない可能性。手書きの IP も含めて
        # 探し直し、同名なら merge_hosts() が新しい IP へ置き換える。
        LOGGER.info("読めない機器があったので探し直します")
        hosts, _ = await resolve_hosts(config, cache_path, True)
        readings = await collect(config, hosts, today, start)
        discovered = True

    stale_hosts: Set[str] = set()
    if discovered:
        found_hosts, _ = load_hosts_cache(cache_path, time.time())
        stale_hosts = stale_manual_hosts(
            config["hosts"],
            [h for h, _ in hosts if h not in {item["host"] for item in readings}],
            found_hosts,
        )
        for host in sorted(stale_hosts):
            LOGGER.warning(
                "TAPO_HOSTS の %s は探索でも見つかりません。撤去・改名したプラグなら"
                " TAPO_HOSTS から外してください（再取得の完了の判定からは外します）",
                host,
            )
    if not readings:
        LOGGER.error("どのプラグからも読み取れませんでした")
        return 1

    payload = build_payload(readings, today)

    for item in readings:
        LOGGER.info(
            "%s (%s): %s kWh / %s W（過去 %d 日ぶん）",
            item["name"],
            item["host"],
            item["kwh_today"],
            item["power_w"],
            len(item["history"]),
        )

    if not payload["records"]:
        LOGGER.error("送信できる積算値がありませんでした")
        return 1

    if dry_run:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    try:
        result = post_payload(config["api_url"], payload)
    except urllib.error.HTTPError as exc:
        LOGGER.error("POST が %s で失敗しました: %s", exc.code, exc.read().decode("utf-8", "replace"))
        return 1
    except Exception as exc:  # noqa: BLE001 - ネットワーク断は次回の実行で取り返す
        LOGGER.error("POST に失敗しました: %s", exc)
        return 1

    LOGGER.info("送信しました: %s", result)
    if refetch:
        # 読めなかった機器があるうちは完了にしない。依頼は期限まで残るので次回また取り直す
        # ただし TAPO_HOSTS に残った古い IP（探索でも見つからない）は待っても読めないので
        # 数えない。数えると依頼が期限切れまで「応答なし」で残り続ける（#728）
        missing = (
            {host for host, _ in hosts} - {item["host"] for item in readings} - stale_hosts
        )
        # 当日ぶんは読めても過去の履歴が取れなかった機器も、期間を取り直せていないので未完了
        missing |= {item["host"] for item in readings if item.get("history_failed")}
        if missing:
            LOGGER.warning(
                "再取得の依頼は未完了のままにします（読めなかった機器・履歴: %s）",
                ", ".join(sorted(missing)),
            )
        else:
            report_refetch_done(config["api_url"], refetch["requested_at"])
    # 一部の旧 IP が読めなくても、取得できたレコードの送信に成功していれば
    # systemd の service 全体は成功にする。未取得の機器は上の WARNING で追跡できる。
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Tapo スマートプラグの消費電力を MyRoom へ送る（計測のみ）"
    )
    parser.add_argument(
        "--list-devices",
        action="store_true",
        help="LAN 上の Tapo 機器を探して IP と名前を表示する（初回の設定用）",
    )
    parser.add_argument(
        "--scan",
        metavar="CIDR",
        help=(
            "--list-devices でブロードキャストが空だったときに1台ずつ当たる範囲"
            "（省略時は自ホストの IP から /24 を推定）"
        ),
    )
    parser.add_argument(
        "--days",
        type=int,
        default=DEFAULT_DAYS,
        metavar="N",
        help=(
            f"当日を含めて何日ぶん送り直すか（既定 {DEFAULT_DAYS}・最大 {MAX_DAYS}）。"
            "過去1か月ぶんの取り込みは --days 31 を1度だけ流す"
        ),
    )
    parser.add_argument(
        "--rediscover",
        action="store_true",
        help="保存済みの探索結果を捨てて、LAN の Tapo 機器を今すぐ探し直す（プラグを足したとき）",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="読み取るだけで POST しない"
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="詳細ログを出す")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    if not 1 <= args.days <= MAX_DAYS:
        LOGGER.error(
            "--days は 1〜%d で指定してください（プラグが持つ履歴は月初起点の %d 日ぶんまで）",
            MAX_DAYS,
            MAX_DAYS,
        )
        return 2

    script_dir = os.path.dirname(os.path.abspath(__file__))
    apply_env_files(
        [
            os.path.join(script_dir, ".env"),
            os.path.join(os.path.dirname(script_dir), ".env"),
        ]
    )

    if Discover is None:
        LOGGER.error(
            "python-kasa が見つかりません。"
            "`collectors/.venv-tapo/bin/pip install -r collectors/requirements-tapo.txt` "
            "を実行し、その venv の python で動かしてください。"
        )
        return 2

    try:
        # 一覧表示は IP を調べるための機能なので、TAPO_HOSTS が無くても動かす
        config = load_config(require_hosts=not args.list_devices)
    except ConfigError as exc:
        LOGGER.error("%s", exc)
        LOGGER.error("collectors/tapo.env.example を参照してください。")
        return 2

    if args.list_devices:
        return asyncio.run(run_list_devices(config, args.scan))
    return asyncio.run(run_collect(config, args.dry_run, args.days, args.rediscover))


if __name__ == "__main__":
    raise SystemExit(main())
