import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from sqlalchemy.orm import Session

from . import database

CONFIG_PATH = Path(__file__).resolve().parent.parent / "data" / "ui_settings.json"

SETTING_DISPLAY_ORDER = "display_order"
SETTING_LIFE_CARD_ORDER = "life_card_order"
SETTING_CHART_COLORS = "chart_colors"
SETTING_HIDDEN_DEVICES = "hidden_devices"
SETTING_STALE_ALERT_EXCLUDED = "stale_alert_excluded_devices"
SETTING_PRESSURE_OFFSETS = "pressure_offsets"
SETTING_LIGHT_THRESHOLDS = "light_thresholds"
#: デバイスID -> その場所の照明の判定元（#368）。しきい値と違い「どこから読むか」を持つ
SETTING_LIGHT_SOURCES = "light_sources"
SETTING_ENERGY_UNIT_PRICE = "energy_unit_price"
#: 消費電力の取得元に付けた表示名の上書き（#335）。{"tapo:冷蔵庫": "キッチンの冷蔵庫"}
SETTING_ENERGY_SOURCE_NAMES = "energy_source_names"
SETTING_REMOTE_BUTTONS = "remote_buttons"
SETTING_REMOTE_BUTTON_DEFS = "remote_button_defs"
SETTING_REMOTE_CATALOG = "remote_catalog"
#: ゴミの日の前日通知のPush通知を送るか（#293）
SETTING_GARBAGE_NOTIFY_ENABLED = "garbage_notify_enabled"
#: 前日通知の時刻（"HH:MM"）。未設定（None）は data/garbage.json の notify_hour を使う
SETTING_GARBAGE_NOTIFY_TIME = "garbage_notify_time"
#: ゴミの日の当日通知を送るか（#347）。前日通知（上記2つ）とは独立に設定できる
SETTING_GARBAGE_NOTIFY_SAME_DAY_ENABLED = "garbage_notify_same_day_enabled"
#: 当日通知の時刻（"HH:MM"）。未設定（None）は garbage_notify.DEFAULT_SAME_DAY_NOTIFY_HOUR を使う
SETTING_GARBAGE_NOTIFY_SAME_DAY_TIME = "garbage_notify_same_day_time"
#: 品目ごとに前日・当日どちらのタイミングで通知するか（#347）。
#: {category_id: ["before", "same_day"]} のように、両方を指定することもできる。
#: キーが無い品目は ["before"]（#293からの既定動作を維持）
SETTING_GARBAGE_NOTIFY_CATEGORY_TIMING = "garbage_notify_category_timing"
#: 室温・湿度の異常をPush通知するか（#293）
SETTING_ROOM_ANOMALY_NOTIFY_ENABLED = "room_anomaly_notify_enabled"
#: 指標ごとの上限・下限。{"temperature": {"min": 16.0, "max": 30.0}, "humidity": {...}}
SETTING_ROOM_ANOMALY_THRESHOLDS = "room_anomaly_thresholds"
#: 同じ異常が続く間の再通知間隔（分）
SETTING_ROOM_ANOMALY_REMINDER_MINUTES = "room_anomaly_reminder_minutes"
#: 部屋の3Dビュー（#399）で、3D上の場所とセンサー・エアコンを結ぶ対応表。
#: {"zones": [{"key": "ldk", "device_id": 1, "ac_id": 1}, ...]}
SETTING_ROOM_LAYOUT = "room_layout"

DEFAULT_DISPLAY_ORDER = ["device:1", "device:2", "outdoor", "aircon"]

DEFAULT_GARBAGE_NOTIFY_ENABLED = True
DEFAULT_GARBAGE_NOTIFY_SAME_DAY_ENABLED = False
#: 前日・当日の指定に使える値。品目ごとの既定は ["before"]（前日通知のみ、現行動作維持）
GARBAGE_NOTIFY_TIMINGS = ("before", "same_day")
DEFAULT_GARBAGE_NOTIFY_CATEGORY_TIMINGS: List[str] = ["before"]
DEFAULT_ROOM_ANOMALY_NOTIFY_ENABLED = False
#: 温湿度の異常判定に使う既定の上限・下限。画面で変えるまではこの値を使う
DEFAULT_ROOM_ANOMALY_THRESHOLDS: Dict[str, Dict[str, float]] = {
    "temperature": {"min": 16.0, "max": 30.0},
    "humidity": {"min": 30.0, "max": 70.0},
}
DEFAULT_ROOM_ANOMALY_REMINDER_MINUTES = 60
MIN_ROOM_ANOMALY_REMINDER_MINUTES = 5
MAX_ROOM_ANOMALY_REMINDER_MINUTES = 1440
#: 異常とみなす指標。ここに無いキーは _normalize_room_anomaly_thresholds が捨てる
ROOM_ANOMALY_METRICS = ("temperature", "humidity")

# 電気料金の単価（円/kWh）。取得元は使用量しか返さないため、金額はこの単価から計算する。
# 既定値は関西電力の従量電灯Aの第2段階あたりの目安。
DEFAULT_ENERGY_UNIT_PRICE = 31.0
MAX_ENERGY_UNIT_PRICE = 1000.0

# 「電気の操作」のボタンに付けられる名前の長さ。カードは3列で、長い名前は truncate されて
# 読めなくなるだけなので、入り口で切っておく
MAX_REMOTE_LABEL_LENGTH = 20

# 消費電力の取得元に付けられる表示名の長さ。カードの名前欄は固定幅で、長い名前は
# truncate されるだけなので、こちらも入り口で切っておく
MAX_ENERGY_SOURCE_NAME_LENGTH = 20

# 照明の点灯とみなす照度（lx）の上限。直射日光でも10万lx程度なので、これを超える値は
# 打ち間違いとみなして捨てる。0以下は「判定しない」の意味なので同じく保存しない
MAX_LIGHT_THRESHOLD_LUX = 100000.0

DEFAULT_CHART_COLORS: Dict[str, str] = {
    "device:1": "#3498db",
    "device:2": "#e67e22",
    "device:3": "#1abc9c",
    "outdoor": "#adb5bd",
    "airconTarget": "#9b59b6",
}


def _default_settings() -> Dict[str, Any]:
    return {
        SETTING_DISPLAY_ORDER: list(DEFAULT_DISPLAY_ORDER),
        # 空 = まだ並べ替えていない。どのカードがあるかはフロント側の LIFE_CARDS が正なので、
        # ここに既定の並びは持たない（#283）
        SETTING_LIFE_CARD_ORDER: [],
        SETTING_CHART_COLORS: dict(DEFAULT_CHART_COLORS),
        SETTING_HIDDEN_DEVICES: [],
        SETTING_STALE_ALERT_EXCLUDED: [],
        SETTING_PRESSURE_OFFSETS: {},
        # 空 = どのデバイスでも照明の判定を行わない。部屋の作りで妥当な照度が変わるため、
        # 既定のしきい値は置かず、画面から設定するまで表示を増やさない
        SETTING_LIGHT_THRESHOLDS: {},
        # 空 = どの場所にも照明を紐付けていない。紐付けるまで詳細パネルの見た目は変わらない
        SETTING_LIGHT_SOURCES: {},
        SETTING_ENERGY_UNIT_PRICE: DEFAULT_ENERGY_UNIT_PRICE,
        # 空 = どの取得元にも別名を付けていない。既定の名前は `daily_energy.source`
        # （Tapoアプリで付けた名前）が持っているので、ここに既定値は置かない
        SETTING_ENERGY_SOURCE_NAMES: {},
        SETTING_REMOTE_BUTTONS: {},
        # None は「まだ画面から一度も保存していない」。空の groups（1つも登録していない）
        # と区別する必要があるため、既定値を {} にはしない（#262）
        SETTING_REMOTE_BUTTON_DEFS: None,
        SETTING_REMOTE_CATALOG: None,
        SETTING_GARBAGE_NOTIFY_ENABLED: DEFAULT_GARBAGE_NOTIFY_ENABLED,
        SETTING_GARBAGE_NOTIFY_TIME: None,
        SETTING_GARBAGE_NOTIFY_SAME_DAY_ENABLED: DEFAULT_GARBAGE_NOTIFY_SAME_DAY_ENABLED,
        SETTING_GARBAGE_NOTIFY_SAME_DAY_TIME: None,
        SETTING_GARBAGE_NOTIFY_CATEGORY_TIMING: {},
        SETTING_ROOM_ANOMALY_NOTIFY_ENABLED: DEFAULT_ROOM_ANOMALY_NOTIFY_ENABLED,
        SETTING_ROOM_ANOMALY_THRESHOLDS: {
            metric: dict(values) for metric, values in DEFAULT_ROOM_ANOMALY_THRESHOLDS.items()
        },
        SETTING_ROOM_ANOMALY_REMINDER_MINUTES: DEFAULT_ROOM_ANOMALY_REMINDER_MINUTES,
        # 空 = まだ紐付けを保存していない。どのゾーンが存在するかを知っているのは
        # フロント側の `lib/room-layout.ts` の ROOM_ZONE_DEFS なので、既定の紐付けは
        # ここに持たない（`life_card_order` と同じ分担・#283）
        SETTING_ROOM_LAYOUT: {"zones": []},
    }


def _normalize_display_order(raw: Any) -> List[str]:
    if not isinstance(raw, list):
        return list(DEFAULT_DISPLAY_ORDER)

    normalized: List[str] = []
    seen: Set[str] = set()
    for entry in raw:
        if not isinstance(entry, str):
            continue
        key = entry.strip()
        if not key or key in seen:
            continue
        seen.add(key)
        normalized.append(key)

    for key in DEFAULT_DISPLAY_ORDER:
        if key not in seen:
            normalized.append(key)

    return normalized


def _normalize_life_card_order(raw: Any) -> List[str]:
    """「暮らし」のカードを並べる順（#283）。

    `display_order` と違い、**ここに既定の並びを足さない。** どのカードが存在するかを
    知っているのはフロント側の `lib/dashboard-sections.ts` の `LIFE_CARDS` で、
    バックエンドへ同じ一覧を写すとカードを増やしたときに片方だけ古くなる。
    保存されていないキー・消えたキーの補完は `lib/life-card-order.ts` が行うため、
    ここでは形（文字列・重複なし）だけを整える。
    """
    if not isinstance(raw, list):
        return []

    order: List[str] = []
    seen: Set[str] = set()
    for entry in raw:
        if not isinstance(entry, str):
            continue
        key = entry.strip()
        if not key or key in seen:
            continue
        seen.add(key)
        order.append(key)
    return order


def _normalize_chart_colors(raw: Any) -> Dict[str, str]:
    defaults = dict(DEFAULT_CHART_COLORS)
    if not isinstance(raw, dict):
        return defaults

    for key, value in raw.items():
        if isinstance(key, str) and isinstance(value, str) and value.strip():
            defaults[key] = value.strip()
    return defaults


def _normalize_hidden_devices(raw: Any) -> List[str]:
    if not isinstance(raw, list):
        return []

    hidden: List[str] = []
    seen: Set[str] = set()
    for entry in raw:
        if not isinstance(entry, str):
            continue
        key = entry.strip()
        if not key or key in seen:
            continue
        seen.add(key)
        hidden.append(key)
    return hidden


def _normalize_stale_alert_excluded(raw: Any) -> List[str]:
    if not isinstance(raw, list):
        return []

    excluded: List[str] = []
    seen: Set[str] = set()
    for entry in raw:
        if not isinstance(entry, str):
            continue
        key = entry.strip()
        if not key or key in seen:
            continue
        seen.add(key)
        excluded.append(key)
    return excluded


def _normalize_pressure_offsets(raw: Any) -> Dict[str, float]:
    if not isinstance(raw, dict):
        return {}

    offsets: Dict[str, float] = {}
    for key, value in raw.items():
        try:
            device_id = str(int(key))
            offset = float(value)
        except (TypeError, ValueError):
            continue
        if offset != 0:
            offsets[device_id] = offset
    return offsets


def _normalize_light_thresholds(raw: Any) -> Dict[str, float]:
    """デバイスID -> 照明の点灯とみなす照度（lx）。

    キーが無いデバイスは「判定しない」。0以下・上限超え・数値でない値は、判定を止める
    指定（＝キーを消す）として扱う。画面の入力欄を空にしたときもここへ落ちてくる。
    """
    if not isinstance(raw, dict):
        return {}

    thresholds: Dict[str, float] = {}
    for key, value in raw.items():
        try:
            device_id = str(int(key))
            threshold = float(value)
        except (TypeError, ValueError):
            continue
        if threshold <= 0 or threshold > MAX_LIGHT_THRESHOLD_LUX:
            continue
        thresholds[device_id] = round(threshold, 1)
    return thresholds


#: 照明の点灯・消灯を「照度としきい値」から復元する（`light_thresholds` が要る）
LIGHT_SOURCE_ILLUMINANCE = "illuminance"
#: Nature Remo が持っている照明の状態を読む。`appliance_key` は remote.appliance_key() のハッシュ
LIGHT_SOURCE_REMO = "remo"
LIGHT_SOURCE_KINDS = (LIGHT_SOURCE_ILLUMINANCE, LIGHT_SOURCE_REMO)


def _normalize_light_sources(raw: Any) -> Dict[str, Dict[str, str]]:
    """デバイスID -> その場所の照明を「どこから判定するか」（#368）。

    `light_thresholds` が「いくつを超えたら点灯とみなすか」なのに対し、こちらは判定の
    出どころを持つ。2つを1つのキーにまとめないのは、照度のしきい値が #258 から
    独立して意味を持ち（詳細パネルのいまの状態表示）、照明を紐付けていない場所でも
    そのまま効いているため。

        {"1": {"kind": "illuminance"}}
        {"2": {"kind": "remo", "appliance_key": "a-1f2e3d4c5b"}}

    キーが無いデバイスは「照明を紐付けていない」。読めない値・`appliance_key` の無い
    remo は、紐付けを外す指定（＝キーを消す）として扱う。画面で「使わない」を選んだ
    ときもここへ落ちてくる。
    """
    if not isinstance(raw, dict):
        return {}

    sources: Dict[str, Dict[str, str]] = {}
    for key, value in raw.items():
        try:
            device_id = str(int(key))
        except (TypeError, ValueError):
            continue
        if not isinstance(value, dict):
            continue
        kind = str(value.get("kind") or "").strip()
        if kind not in LIGHT_SOURCE_KINDS:
            continue
        if kind == LIGHT_SOURCE_ILLUMINANCE:
            sources[device_id] = {"kind": LIGHT_SOURCE_ILLUMINANCE}
            continue
        appliance_key = str(value.get("appliance_key") or "").strip()
        if not appliance_key:
            continue
        sources[device_id] = {"kind": LIGHT_SOURCE_REMO, "appliance_key": appliance_key}
    return sources


def _normalize_energy_unit_price(raw: Any) -> float:
    """円/kWh。負の値や桁違いの入力は既定値へ落とす。"""
    try:
        price = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_ENERGY_UNIT_PRICE
    if price <= 0 or price > MAX_ENERGY_UNIT_PRICE:
        return DEFAULT_ENERGY_UNIT_PRICE
    return round(price, 2)


def _normalize_energy_source_names(raw: Any) -> Dict[str, str]:
    """消費電力の取得元に付けた別名（#335）。`{"tapo:冷蔵庫": "キッチンの冷蔵庫"}`。

    **キーは `daily_energy.source` そのもので、名前を変えても source は変えない。**
    source を書き換えると `(date, source)` が別物になり、過去の使用量と切れる。

    値が空文字なら「上書きなし」なので保存しない。取得元が入れ替わったときに
    古いキーのゴミを残さないための決まりで、`remote_buttons` と同じ考え方。
    """
    if not isinstance(raw, dict):
        return {}

    normalized: Dict[str, str] = {}
    for key, value in raw.items():
        if not isinstance(key, str):
            continue
        source = key.strip()
        if not source:
            continue
        if not isinstance(value, str):
            continue
        name = value.strip()[:MAX_ENERGY_SOURCE_NAME_LENGTH]
        if not name:
            continue
        normalized[source] = name
    return normalized


def _normalize_remote_buttons(raw: Any) -> Dict[str, Dict[str, Any]]:
    """「電気の操作」のボタンごとに付けた名前と、ダッシュボードから隠す指定。

    ボタン定義そのもの（signal ID・機器ID）は data/remote.json が正で、ここには持たない。
    **既定と変わらない項目は保存しない。** 名前が空でダッシュボードにも出すなら
    remote.json のままなので、持っておく意味が無いうえ、remote.json のボタンを
    入れ替えたときに古いIDのゴミが残り続ける。

    `default_label` は「保存した時点で remote.json に書かれていた名前」。ボタンIDは
    remote.json 側で `id` を省くと並び順から採番されるため、あとからボタンを挿すと
    設定が別のボタンへずれる。ずれを見つける手掛かりとして一緒に持つ（照合は
    `backend/remote.py` の `_override_for()` が行う）。
    """
    if not isinstance(raw, dict):
        return {}

    normalized: Dict[str, Dict[str, Any]] = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not isinstance(value, dict):
            continue
        button_id = key.strip()
        if not button_id:
            continue

        label = str(value.get("label") or "").strip()[:MAX_REMOTE_LABEL_LENGTH]
        hidden = bool(value.get("hidden"))
        if not label and not hidden:
            continue

        entry: Dict[str, Any] = {}
        if label:
            entry["label"] = label
        if hidden:
            entry["hidden"] = True

        default_label = str(value.get("default_label") or "").strip()
        if default_label:
            entry["default_label"] = default_label
        normalized[button_id] = entry
    return normalized


def _normalize_remote_button_defs(raw: Any) -> Optional[Dict[str, Any]]:
    """「電気の操作」に並べるボタンの定義そのもの（#262）。

    以前は `data/remote.json` を手で書くのが唯一の入り口だったが、デプロイの rsync が
    リポジトリの空ファイルで本番を上書きするため、画面から書いても次のデプロイで消えた。
    そこで正をこちらへ移し、`remote.json` は「まだ一度も保存していないとき」に読む
    初期値だけにした。**その区別のために None を残す。** 全部消して保存した状態は
    `{"groups": []}` で、`remote.json` へは戻らない。

    中身（signal ID・押し方）の検証は `backend/remote.py` が読み込み時に行う。
    ここで呼ぶと相互 import になるため、ここでは形だけ見る。
    """
    if not isinstance(raw, dict):
        return None
    groups = raw.get("groups")
    if not isinstance(groups, list):
        return None
    return {"groups": [group for group in groups if isinstance(group, dict)]}


def _normalize_remote_catalog(raw: Any) -> Optional[Dict[str, Any]]:
    """Nature Remo から最後に取ってきた「登録できる操作」の一覧（#262）。

    設定でも表示でもなく取得結果の控えだが、DDL 権限の要らない書き込み先が
    `app_settings` しか無いためここに置く。**画面を開くたびに Nature Remo を
    叩かないため**の控えで、無くても「読み込み直す」を押せば作り直せる
    （Cloud API の上限は 30回/5分）。
    """
    if not isinstance(raw, dict):
        return None
    devices = raw.get("devices")
    if not isinstance(devices, list):
        return None
    return {
        "fetched_at": str(raw.get("fetched_at") or ""),
        "devices": [device for device in devices if isinstance(device, dict)],
    }


def _normalize_bool(raw: Any, default: bool) -> bool:
    if isinstance(raw, bool):
        return raw
    return default


def _normalize_time_hhmm(raw: Any) -> Optional[str]:
    """"HH:MM" を検証して "%02d:%02d" へ正規化する。空・壊れた値は None（未設定）。

    None は「画面でまだ設定していない」の意味で、呼び出し側（garbage_notify）は
    data/garbage.json の notify_hour へフォールバックする。
    """
    if not isinstance(raw, str) or not raw.strip():
        return None
    parts = raw.strip().split(":")
    if len(parts) < 2:
        return None
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return f"{hour:02d}:{minute:02d}"


def _normalize_garbage_notify_category_timing(raw: Any) -> Dict[str, List[str]]:
    """品目ごとの通知タイミング（#347）。{category_id: ["before", "same_day"]}。

    前日・当日は排他ではないため、両方を含む配列も受ける。品目IDの実在チェックは行わない
    （light_thresholds・pressure_offsets と同じく、garbage.py への依存を作らないため）。
    既定（["before"]）と同じ内容の配列は「未指定」と区別が付かないので保存しない。
    """
    if not isinstance(raw, dict):
        return {}

    normalized: Dict[str, List[str]] = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not isinstance(value, list):
            continue
        category_id = key.strip()
        if not category_id:
            continue

        timings: List[str] = []
        for entry in value:
            if entry in GARBAGE_NOTIFY_TIMINGS and entry not in timings:
                timings.append(entry)
        # 既定（前日のみ）と同じ内容は「未指定」と区別が付かないので保存しない。
        # 空配列（前日・当日どちらも外した = 通知しない）は既定と異なるため保存する
        if sorted(timings) == sorted(DEFAULT_GARBAGE_NOTIFY_CATEGORY_TIMINGS):
            continue
        normalized[category_id] = timings
    return normalized


def _normalize_room_anomaly_thresholds(raw: Any) -> Dict[str, Dict[str, float]]:
    """指標ごとの上限・下限。min >= max や数値でない値は既定へ落とす。"""
    if not isinstance(raw, dict):
        return {metric: dict(values) for metric, values in DEFAULT_ROOM_ANOMALY_THRESHOLDS.items()}

    normalized: Dict[str, Dict[str, float]] = {}
    for metric in ROOM_ANOMALY_METRICS:
        entry = raw.get(metric)
        default = DEFAULT_ROOM_ANOMALY_THRESHOLDS[metric]
        if not isinstance(entry, dict):
            normalized[metric] = dict(default)
            continue
        try:
            min_value = float(entry.get("min", default["min"]))
            max_value = float(entry.get("max", default["max"]))
        except (TypeError, ValueError):
            normalized[metric] = dict(default)
            continue
        if min_value >= max_value:
            normalized[metric] = dict(default)
            continue
        normalized[metric] = {"min": round(min_value, 1), "max": round(max_value, 1)}
    return normalized


def _normalize_room_anomaly_reminder_minutes(raw: Any) -> int:
    try:
        minutes = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_ROOM_ANOMALY_REMINDER_MINUTES
    return max(
        MIN_ROOM_ANOMALY_REMINDER_MINUTES, min(MAX_ROOM_ANOMALY_REMINDER_MINUTES, minutes)
    )


def _optional_id(raw: Any) -> Optional[int]:
    """device_id / ac_id 用。null・読めない値・負の数はすべて「紐付けなし」の None。"""
    if raw is None:
        return None
    try:
        number = int(raw)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def _normalize_room_layout(raw: Any) -> Dict[str, Any]:
    """3D上の場所と、センサー・エアコン・Tapoスマートプラグの対応表（#399・#410）。

    **どのゾーンが存在するかはここでは判断しない。** ゾーンの一覧・寸法を持っているのは
    フロント側の `lib/room-layout.ts` の `ROOM_ZONE_DEFS` で、同じ一覧をここへ写すと
    間取りを直したときに片方だけ古くなる。知らないキーを落として足りないキーを補うのは
    `normalizeRoomLayout()` の仕事なので、ここでは形（キーは文字列・IDは整数か null・
    Tapoの `source` は重複の無い文字列の配列）だけを整える。
    `_normalize_life_card_order()` と同じ考え方。
    """
    if not isinstance(raw, dict):
        return {"zones": []}

    entries = raw.get("zones")
    if not isinstance(entries, list):
        return {"zones": []}

    zones: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        key = str(entry.get("key") or "").strip()
        if not key or key in seen:
            continue
        seen.add(key)

        tapo_sources = _string_list(entry.get("tapo_sources"))

        zones.append(
            {
                "key": key,
                "device_id": _optional_id(entry.get("device_id")),
                "ac_id": _optional_id(entry.get("ac_id")),
                "tapo_sources": tapo_sources,
            }
        )
    return {"zones": zones}


def _string_list(raw: Any) -> List[str]:
    """重複の無い文字列配列へ整える。Tapoの `source`（#410）で使う。"""
    values: List[str] = []
    if not isinstance(raw, list):
        return values
    for item in raw:
        if not isinstance(item, str):
            continue
        value = item.strip()
        if not value or value in values:
            continue
        values.append(value)
    return values


def _normalize_settings(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    defaults = _default_settings()
    if not raw:
        return defaults

    return {
        SETTING_DISPLAY_ORDER: _normalize_display_order(
            raw.get(SETTING_DISPLAY_ORDER, defaults[SETTING_DISPLAY_ORDER])
        ),
        SETTING_LIFE_CARD_ORDER: _normalize_life_card_order(
            raw.get(SETTING_LIFE_CARD_ORDER, defaults[SETTING_LIFE_CARD_ORDER])
        ),
        SETTING_CHART_COLORS: _normalize_chart_colors(
            raw.get(SETTING_CHART_COLORS, defaults[SETTING_CHART_COLORS])
        ),
        SETTING_HIDDEN_DEVICES: _normalize_hidden_devices(
            raw.get(SETTING_HIDDEN_DEVICES, defaults[SETTING_HIDDEN_DEVICES])
        ),
        SETTING_STALE_ALERT_EXCLUDED: _normalize_stale_alert_excluded(
            raw.get(SETTING_STALE_ALERT_EXCLUDED, defaults[SETTING_STALE_ALERT_EXCLUDED])
        ),
        SETTING_PRESSURE_OFFSETS: _normalize_pressure_offsets(
            raw.get(SETTING_PRESSURE_OFFSETS, defaults[SETTING_PRESSURE_OFFSETS])
        ),
        SETTING_LIGHT_THRESHOLDS: _normalize_light_thresholds(
            raw.get(SETTING_LIGHT_THRESHOLDS, defaults[SETTING_LIGHT_THRESHOLDS])
        ),
        SETTING_LIGHT_SOURCES: _normalize_light_sources(
            raw.get(SETTING_LIGHT_SOURCES, defaults[SETTING_LIGHT_SOURCES])
        ),
        SETTING_ENERGY_UNIT_PRICE: _normalize_energy_unit_price(
            raw.get(SETTING_ENERGY_UNIT_PRICE, defaults[SETTING_ENERGY_UNIT_PRICE])
        ),
        SETTING_ENERGY_SOURCE_NAMES: _normalize_energy_source_names(
            raw.get(SETTING_ENERGY_SOURCE_NAMES, defaults[SETTING_ENERGY_SOURCE_NAMES])
        ),
        SETTING_REMOTE_BUTTONS: _normalize_remote_buttons(
            raw.get(SETTING_REMOTE_BUTTONS, defaults[SETTING_REMOTE_BUTTONS])
        ),
        SETTING_REMOTE_BUTTON_DEFS: _normalize_remote_button_defs(
            raw.get(SETTING_REMOTE_BUTTON_DEFS)
        ),
        SETTING_REMOTE_CATALOG: _normalize_remote_catalog(raw.get(SETTING_REMOTE_CATALOG)),
        SETTING_GARBAGE_NOTIFY_ENABLED: _normalize_bool(
            raw.get(SETTING_GARBAGE_NOTIFY_ENABLED), DEFAULT_GARBAGE_NOTIFY_ENABLED
        ),
        SETTING_GARBAGE_NOTIFY_TIME: _normalize_time_hhmm(raw.get(SETTING_GARBAGE_NOTIFY_TIME)),
        SETTING_GARBAGE_NOTIFY_SAME_DAY_ENABLED: _normalize_bool(
            raw.get(SETTING_GARBAGE_NOTIFY_SAME_DAY_ENABLED),
            DEFAULT_GARBAGE_NOTIFY_SAME_DAY_ENABLED,
        ),
        SETTING_GARBAGE_NOTIFY_SAME_DAY_TIME: _normalize_time_hhmm(
            raw.get(SETTING_GARBAGE_NOTIFY_SAME_DAY_TIME)
        ),
        SETTING_GARBAGE_NOTIFY_CATEGORY_TIMING: _normalize_garbage_notify_category_timing(
            raw.get(SETTING_GARBAGE_NOTIFY_CATEGORY_TIMING)
        ),
        SETTING_ROOM_ANOMALY_NOTIFY_ENABLED: _normalize_bool(
            raw.get(SETTING_ROOM_ANOMALY_NOTIFY_ENABLED), DEFAULT_ROOM_ANOMALY_NOTIFY_ENABLED
        ),
        SETTING_ROOM_ANOMALY_THRESHOLDS: _normalize_room_anomaly_thresholds(
            raw.get(SETTING_ROOM_ANOMALY_THRESHOLDS)
        ),
        SETTING_ROOM_ANOMALY_REMINDER_MINUTES: _normalize_room_anomaly_reminder_minutes(
            raw.get(SETTING_ROOM_ANOMALY_REMINDER_MINUTES)
        ),
        SETTING_ROOM_LAYOUT: _normalize_room_layout(
            raw.get(SETTING_ROOM_LAYOUT, defaults[SETTING_ROOM_LAYOUT])
        ),
    }


def _load_file_settings() -> Dict[str, Any]:
    if not CONFIG_PATH.exists():
        return _default_settings()

    try:
        with CONFIG_PATH.open(encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return _normalize_settings(data)
    except (TypeError, ValueError, json.JSONDecodeError):
        pass
    return _default_settings()


def _write_file_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    normalized = _normalize_settings(settings)
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with CONFIG_PATH.open("w", encoding="utf-8") as f:
        json.dump(normalized, f, ensure_ascii=False, indent=2)
    return normalized


def _load_db_settings(db: Session) -> Dict[str, Any]:
    rows = db.query(database.AppSetting).all()
    if not rows:
        migrated = _normalize_settings(_load_file_settings())
        for key, value in migrated.items():
            db.add(database.AppSetting(setting_key=key, setting_value=json.dumps(value)))
        db.commit()
        return migrated

    raw: Dict[str, Any] = {}
    for row in rows:
        try:
            raw[row.setting_key] = json.loads(row.setting_value)
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
    return _normalize_settings(raw)


def _save_db_setting(db: Session, key: str, value: Any) -> None:
    serialized = json.dumps(value, ensure_ascii=False)
    row = db.query(database.AppSetting).filter(database.AppSetting.setting_key == key).first()
    if row is None:
        db.add(database.AppSetting(setting_key=key, setting_value=serialized))
    else:
        row.setting_value = serialized
    db.commit()


def get_settings(db: Optional[Session] = None) -> Dict[str, Any]:
    if database.DB_MOCK or db is None:
        return _load_file_settings()
    return _load_db_settings(db)


def save_settings(
    updates: Dict[str, Any],
    db: Optional[Session] = None,
) -> Dict[str, Any]:
    current = get_settings(db)
    merged = {
        SETTING_DISPLAY_ORDER: updates.get(SETTING_DISPLAY_ORDER, current[SETTING_DISPLAY_ORDER]),
        SETTING_LIFE_CARD_ORDER: updates.get(
            SETTING_LIFE_CARD_ORDER, current.get(SETTING_LIFE_CARD_ORDER, [])
        ),
        SETTING_CHART_COLORS: updates.get(SETTING_CHART_COLORS, current[SETTING_CHART_COLORS]),
        SETTING_HIDDEN_DEVICES: updates.get(
            SETTING_HIDDEN_DEVICES, current[SETTING_HIDDEN_DEVICES]
        ),
        SETTING_STALE_ALERT_EXCLUDED: updates.get(
            SETTING_STALE_ALERT_EXCLUDED, current.get(SETTING_STALE_ALERT_EXCLUDED, [])
        ),
        SETTING_PRESSURE_OFFSETS: updates.get(
            SETTING_PRESSURE_OFFSETS, current.get(SETTING_PRESSURE_OFFSETS, {})
        ),
        SETTING_LIGHT_THRESHOLDS: updates.get(
            SETTING_LIGHT_THRESHOLDS, current.get(SETTING_LIGHT_THRESHOLDS, {})
        ),
        SETTING_LIGHT_SOURCES: updates.get(
            SETTING_LIGHT_SOURCES, current.get(SETTING_LIGHT_SOURCES, {})
        ),
        SETTING_ENERGY_UNIT_PRICE: updates.get(
            SETTING_ENERGY_UNIT_PRICE,
            current.get(SETTING_ENERGY_UNIT_PRICE, DEFAULT_ENERGY_UNIT_PRICE),
        ),
        SETTING_ENERGY_SOURCE_NAMES: updates.get(
            SETTING_ENERGY_SOURCE_NAMES, current.get(SETTING_ENERGY_SOURCE_NAMES, {})
        ),
        SETTING_REMOTE_BUTTONS: updates.get(
            SETTING_REMOTE_BUTTONS, current.get(SETTING_REMOTE_BUTTONS, {})
        ),
        SETTING_REMOTE_BUTTON_DEFS: updates.get(
            SETTING_REMOTE_BUTTON_DEFS, current.get(SETTING_REMOTE_BUTTON_DEFS)
        ),
        SETTING_REMOTE_CATALOG: updates.get(
            SETTING_REMOTE_CATALOG, current.get(SETTING_REMOTE_CATALOG)
        ),
        SETTING_GARBAGE_NOTIFY_ENABLED: updates.get(
            SETTING_GARBAGE_NOTIFY_ENABLED,
            current.get(SETTING_GARBAGE_NOTIFY_ENABLED, DEFAULT_GARBAGE_NOTIFY_ENABLED),
        ),
        SETTING_GARBAGE_NOTIFY_TIME: updates.get(
            SETTING_GARBAGE_NOTIFY_TIME, current.get(SETTING_GARBAGE_NOTIFY_TIME)
        ),
        SETTING_GARBAGE_NOTIFY_SAME_DAY_ENABLED: updates.get(
            SETTING_GARBAGE_NOTIFY_SAME_DAY_ENABLED,
            current.get(
                SETTING_GARBAGE_NOTIFY_SAME_DAY_ENABLED,
                DEFAULT_GARBAGE_NOTIFY_SAME_DAY_ENABLED,
            ),
        ),
        SETTING_GARBAGE_NOTIFY_SAME_DAY_TIME: updates.get(
            SETTING_GARBAGE_NOTIFY_SAME_DAY_TIME,
            current.get(SETTING_GARBAGE_NOTIFY_SAME_DAY_TIME),
        ),
        SETTING_GARBAGE_NOTIFY_CATEGORY_TIMING: updates.get(
            SETTING_GARBAGE_NOTIFY_CATEGORY_TIMING,
            current.get(SETTING_GARBAGE_NOTIFY_CATEGORY_TIMING, {}),
        ),
        SETTING_ROOM_ANOMALY_NOTIFY_ENABLED: updates.get(
            SETTING_ROOM_ANOMALY_NOTIFY_ENABLED,
            current.get(
                SETTING_ROOM_ANOMALY_NOTIFY_ENABLED, DEFAULT_ROOM_ANOMALY_NOTIFY_ENABLED
            ),
        ),
        SETTING_ROOM_ANOMALY_THRESHOLDS: updates.get(
            SETTING_ROOM_ANOMALY_THRESHOLDS,
            current.get(SETTING_ROOM_ANOMALY_THRESHOLDS, DEFAULT_ROOM_ANOMALY_THRESHOLDS),
        ),
        SETTING_ROOM_ANOMALY_REMINDER_MINUTES: updates.get(
            SETTING_ROOM_ANOMALY_REMINDER_MINUTES,
            current.get(
                SETTING_ROOM_ANOMALY_REMINDER_MINUTES, DEFAULT_ROOM_ANOMALY_REMINDER_MINUTES
            ),
        ),
        SETTING_ROOM_LAYOUT: updates.get(
            SETTING_ROOM_LAYOUT, current.get(SETTING_ROOM_LAYOUT, {"zones": []})
        ),
    }
    normalized = _normalize_settings(merged)

    if database.DB_MOCK or db is None:
        return _write_file_settings(normalized)

    for key, value in normalized.items():
        _save_db_setting(db, key, value)
    return normalized
