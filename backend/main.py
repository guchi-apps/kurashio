from fastapi import BackgroundTasks, FastAPI, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import asyncio
import contextlib
import json
import logging
import os
from sqlalchemy.orm import Session
from typing import Any, Dict, List, Optional
import datetime
import random
from dotenv import load_dotenv
from . import database, weather, outdoor_config, device_config, aircon_config, aircon_control, apns_notify, apns_subscriptions, bambu, bills, cleaning, cleaning_notion, energy, filament, garbage, garbage_notify, garbage_notion, kepco_import, light_history, login_notify, push_notify, push_subscriptions, remote, signaly_notify, sensor_monitor, ui_settings
from .auth import get_current_user
from .internal_auth import require_internal_control_token, require_internal_token
from pydantic import BaseModel, ConfigDict, model_validator

load_dotenv()

logger = logging.getLogger(__name__)

# JST Timezone
JST = datetime.timezone(datetime.timedelta(hours=9))

def get_now_jst():
    return datetime.datetime.now(JST).replace(tzinfo=None) # Use naive JST to match DB


def _to_jst_iso(value: Any) -> Optional[str]:
    """DB・外部APIの日時を、オフセット付きのISO8601（JST）にする。

    DBもアプリ内部もJSTのnaiveなdatetimeで揃えているが、**本番VPSのタイムゾーンはUTC**。
    オフセットを付けずに渡すと、受け取った側がUTCとして読んで9時間ずれる。
    """
    if value is None:
        return None

    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            value = datetime.datetime.strptime(text, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            try:
                value = datetime.datetime.fromisoformat(text)
            except ValueError:
                return None

    if not isinstance(value, datetime.datetime):
        return None

    if value.tzinfo is None:
        value = value.replace(tzinfo=JST)
    return value.astimezone(JST).isoformat()


def _age_minutes(measured_at: Optional[str], now: datetime.datetime) -> Optional[float]:
    if measured_at is None:
        return None
    try:
        parsed = datetime.datetime.fromisoformat(measured_at)
    except ValueError:
        return None
    return round((now - parsed).total_seconds() / 60.0, 1)


#: ゴミの日通知の確認間隔。garbage_notify 側が「通知する時刻か」「送信済みか」を見るため、
#: ここは取りこぼさない程度に細かければよい。
GARBAGE_NOTIFY_INTERVAL_SECONDS = 300


async def _garbage_notify_loop() -> None:
    """ゴミの日の前日通知。本番のデプロイは PM2 でこのプロセスだけを動かすため、
    systemd タイマーではなくバックエンド内で回す（別途の手作業が要らない）。"""
    while True:
        try:
            await asyncio.to_thread(garbage_notify.run_notify)
        except Exception:  # 通知の失敗で API を落とさない
            logger.exception("Garbage notification check failed")
        await asyncio.sleep(GARBAGE_NOTIFY_INTERVAL_SECONDS)


#: Notion への収集日の書き出し間隔。garbage_notion 側が「今日はもう同期したか」
#: 「data/garbage.json が変わっていないか」を見るため、ここは粗くてよい。
GARBAGE_NOTION_SYNC_INTERVAL_SECONDS = 3600


async def _garbage_notion_sync_loop() -> None:
    """収集日を Notion へ書き出す。通知と同じくバックエンド内で回す。"""
    while True:
        try:
            await asyncio.to_thread(garbage_notion.run_sync)
        except Exception:  # Notion 側の障害で API を落とさない
            logger.exception("Garbage Notion sync failed")
        await asyncio.sleep(GARBAGE_NOTION_SYNC_INTERVAL_SECONDS)


#: 次の掃除の Notion への書き出し間隔。掃除は画面からいつでも足せるので、
#: 「今日はもう同期したか」では間引かずに毎回差分を取る（書き込みは差分があるときだけ）。
CLEANING_NOTION_SYNC_INTERVAL_SECONDS = 3600


async def _cleaning_notion_sync_loop() -> None:
    """次の掃除を Notion のタスクへ書き出し、完了になったものを読み戻す。"""
    while True:
        try:
            await asyncio.to_thread(cleaning_notion.run_sync)
        except Exception:  # Notion 側の障害で API を落とさない
            logger.exception("Cleaning Notion sync failed")
        await asyncio.sleep(CLEANING_NOTION_SYNC_INTERVAL_SECONDS)


#: Nature Remo に登録した照明の状態を読む間隔（#368）。レート制限は30回/5分なので、
#: 5分に1回なら十分に余裕がある。**この間隔がそのまま「いつ点けたか」の粒度になる。**
LIGHT_STATE_POLL_INTERVAL_SECONDS = 300


def _configured_light_appliance_keys(db: Session) -> List[str]:
    """`light_sources` で Nature Remo の機器を指している紐付けのキー。"""
    sources = ui_settings.get_settings(db).get(ui_settings.SETTING_LIGHT_SOURCES) or {}
    return sorted(
        {
            str(entry["appliance_key"])
            for entry in sources.values()
            if isinstance(entry, dict)
            and entry.get("kind") == ui_settings.LIGHT_SOURCE_REMO
            and entry.get("appliance_key")
        }
    )


def _last_known_light_states(db: Session, keys: List[str]) -> Dict[str, str]:
    """機器ごとに、最後に記録した状態。無ければキーごと入れない。"""
    states: Dict[str, str] = {}
    for key in keys:
        row = (
            db.query(database.LightEventRecord)
            .filter(database.LightEventRecord.appliance_key == key)
            .order_by(database.LightEventRecord.recorded_at.desc())
            .first()
        )
        if row is not None:
            states[key] = row.power
    return states


def _poll_light_states_once() -> None:
    """紐付け済みの照明の状態を1回読み、変わっていれば記録する。

    **紐付けが1つも無ければ Nature Remo を叩かない。** 照明を設定していない環境で、
    5分ごとに外部APIを呼ぶ理由が無い。
    """
    if database.SessionLocal is None:
        return

    db = database.SessionLocal()
    try:
        keys = _configured_light_appliance_keys(db)
        if not keys:
            return
        states = remote.fetch_light_states(keys)
        if not states:
            return
        changes = light_history.detect_changes(
            states, _last_known_light_states(db, keys), get_now_jst().replace(microsecond=0)
        )
        if not changes:
            return
        for key, at, power in changes:
            db.merge(
                database.LightEventRecord(recorded_at=at, appliance_key=key, power=power)
            )
        db.commit()
    finally:
        db.close()


async def _light_state_poll_loop() -> None:
    """照明の状態を読んで履歴へ書き足す。通知と同じくバックエンド内で回す。

    **「電気の操作」カードの設計（状態を持たない・#106）は変えない。** ここが読むのは
    履歴のためだけで、カードは今までどおり押したら飛ぶだけのボタンのまま。
    """
    while True:
        try:
            await asyncio.to_thread(_poll_light_states_once)
        except Exception:  # Nature Remo 側の障害で API を落とさない
            logger.exception("Light state poll failed")
        await asyncio.sleep(LIGHT_STATE_POLL_INTERVAL_SECONDS)


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI):
    tasks = []
    if not database.DB_MOCK:
        tasks.append(asyncio.create_task(_garbage_notify_loop()))
        tasks.append(asyncio.create_task(_garbage_notion_sync_loop()))
        tasks.append(asyncio.create_task(_cleaning_notion_sync_loop()))
        tasks.append(asyncio.create_task(_light_state_poll_loop()))
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


app = FastAPI(title="kurashio API", lifespan=lifespan)

# --- Models ---
class SensorData(BaseModel):
    datetime: str
    temperature: Optional[float] = None
    temperature_dht11: Optional[float] = None
    humidity: Optional[float] = None
    pressure: Optional[float] = None
    co2: Optional[int] = None
    illuminance: Optional[float] = None

    @model_validator(mode="after")
    def at_least_one_measurement(self):
        if all(
            v is None
            for v in (
                self.temperature,
                self.temperature_dht11,
                self.humidity,
                self.pressure,
                self.co2,
                self.illuminance,
            )
        ):
            raise ValueError(
                "At least one of temperature, temperature_dht11, humidity, pressure, co2, or illuminance is required"
            )
        return self

class OutdoorLocation(BaseModel):
    latitude: float
    longitude: float
    name: str


class OutdoorLocationInput(BaseModel):
    name: str
    latitude: float
    longitude: float

class DeviceNameUpdate(BaseModel):
    name: str
    inherits_from: Optional[int] = None

class AirconNameUpdate(BaseModel):
    name: str


class AirconControlCommand(BaseModel):
    """画面からの運転指示。**指定した項目だけを変える。**

    省略した項目はエアコンの現在値をそのまま使う（`backend/aircon_control.py`）。
    """

    power: Optional[str] = None
    mode: Optional[str] = None
    target_temperature: Optional[float] = None
    fan_speed: Optional[str] = None
    fan_swing: Optional[str] = None


class InternalAirconControlCommand(BaseModel):
    """サーバー間（AIDE）からのエアコンの運転指示。

    受け取るのは電源・モード・設定温度・風量の4つだけ。**風向（`fan_swing`）は受けない。**
    黙って捨てると「送れたのに変わらない」に見えるので、余計な項目は 422 で返す（#439）。
    """

    model_config = ConfigDict(extra="forbid")

    power: Optional[str] = None
    mode: Optional[str] = None
    target_temperature: Optional[float] = None
    fan_speed: Optional[str] = None


class BulkDeleteRecordsRequest(BaseModel):
    device: int
    datetimes: List[str]

class UiSettingsUpdate(BaseModel):
    display_order: Optional[List[str]] = None
    #: 「暮らし」のカードを並べる順。中身は lib/dashboard-sections.ts の LIFE_CARDS のキー
    life_card_order: Optional[List[str]] = None
    chart_colors: Optional[Dict[str, str]] = None
    hidden_devices: Optional[List[str]] = None
    stale_alert_excluded_devices: Optional[List[str]] = None
    pressure_offsets: Optional[Dict[str, float]] = None
    #: デバイスID -> 照明の点灯とみなす照度（lx）。入っていないデバイスは判定しない
    light_thresholds: Optional[Dict[str, float]] = None
    #: デバイスID -> その場所の照明をどこから判定するか（#368）。
    #: {"kind": "illuminance"} か {"kind": "remo", "appliance_key": "d-…"}。
    #: 入っていないデバイスは照明を紐付けていない（詳細パネルの見た目は変わらない）
    light_sources: Optional[Dict[str, Dict[str, Any]]] = None
    energy_unit_price: Optional[float] = None
    #: 消費電力の取得元（`tapo:冷蔵庫` など） -> 画面に出す別名。空文字を送ると既定へ戻る
    energy_source_names: Optional[Dict[str, str]] = None
    #: 「電気の操作」のボタンID -> {"label": 付けた名前, "hidden": 隠すか}
    remote_buttons: Optional[Dict[str, Dict[str, Any]]] = None
    #: ゴミの日の前日通知のPush通知を送るか
    garbage_notify_enabled: Optional[bool] = None
    #: ゴミの日の前日通知の時刻（"HH:MM"）。null を送ると「未設定」に戻す
    garbage_notify_time: Optional[str] = None
    #: ゴミの日の当日通知のPush通知を送るか（#347）
    garbage_notify_same_day_enabled: Optional[bool] = None
    #: ゴミの日の当日通知の時刻（"HH:MM"）。null を送ると「未設定」に戻す
    garbage_notify_same_day_time: Optional[str] = None
    #: 品目ごとの通知タイミング。{category_id: ["before"|"same_day", ...]}
    garbage_notify_category_timing: Optional[Dict[str, List[str]]] = None
    #: 室温・湿度の異常をPush通知するか
    room_anomaly_notify_enabled: Optional[bool] = None
    #: 指標ごとの上限・下限。{"temperature": {"min": ..., "max": ...}, "humidity": {...}}
    room_anomaly_thresholds: Optional[Dict[str, Dict[str, float]]] = None
    #: 同じ異常が続く間の再通知間隔（分）
    room_anomaly_reminder_minutes: Optional[int] = None
    #: 部屋の3Dビュー（#399）の、3D上の場所とセンサー・エアコン・掃除タスクの対応表。
    #: {"zones": [{"key": "ldk", "device_id": 1, "ac_id": 1, "cleaning_task_ids": [...]}]}
    #: どのゾーンが存在するかはフロント（lib/room-layout.ts）が正で、ここは素通しする
    room_layout: Optional[Dict[str, Any]] = None


class PushSubscriptionKeys(BaseModel):
    p256dh: str
    auth: str


class PushSubscriptionBody(BaseModel):
    endpoint: str
    keys: PushSubscriptionKeys
    expirationTime: Optional[int] = None


class PushUnsubscribeRequest(BaseModel):
    endpoint: str


class ApnsRegisterBody(BaseModel):
    """iOSアプリ（#526）が取得したAPNsデバイストークン。"""

    token: str


class ApnsUnregisterRequest(BaseModel):
    token: str


class CleaningTaskUpdate(BaseModel):
    """掃除の予定1件。画面から送られる定義（実施履歴はサーバー側で引き継ぐ）。"""

    id: Optional[str] = None
    name: str
    interval_days: int
    steps: List[str] = []


class CleaningTasksUpdate(BaseModel):
    tasks: List[CleaningTaskUpdate]


class CleaningDoneRequest(BaseModel):
    #: 実施日（YYYY-MM-DD）。省略時は今日（JST）
    date: Optional[str] = None


class FilamentSpoolCreate(BaseModel):
    """スプールを1本足す（#445）。重さの範囲や日付の検証は `filament.add_spool()` が行う。"""

    name: str
    material: str = "PLA"
    color: Optional[str] = None
    purchased_on: Optional[str] = None
    #: 初期フィラメント量（g）。省略時は1000
    net_g: Optional[float] = None
    #: 空スプールの重さ（g）。計量に必要
    tare_g: Optional[float] = None
    #: 使いかけを登録するときの、いまの全体重量（g）。最初の計量として記録する
    current_gross_g: Optional[float] = None


class FilamentSpoolUpdate(BaseModel):
    """送られた項目だけを直す（`exclude_unset`）。`tare_g: null` は空スプールの重さを外す。"""

    name: Optional[str] = None
    material: Optional[str] = None
    color: Optional[str] = None
    purchased_on: Optional[str] = None
    net_g: Optional[float] = None
    tare_g: Optional[float] = None
    archived: Optional[bool] = None


class FilamentActiveRequest(BaseModel):
    spool_id: Optional[str] = None


class FilamentWeighRequest(BaseModel):
    gross_g: float
    #: 計量した日（YYYY-MM-DD）。省略時は今日（JST）
    date: Optional[str] = None


class FilamentUsageRequest(BaseModel):
    grams: float
    #: 印刷した日（YYYY-MM-DD）。省略時は今日（JST）
    date: Optional[str] = None
    note: Optional[str] = None


class RemoteConfigButton(BaseModel):
    """登録するボタン1つ。**IDだけ受け取る。**

    送り先（signal ID・appliance ID）は画面へ返していないので、画面から送り返せない。
    サーバー側で今の定義と最後に取得した候補一覧から引く（`remote.resolve_config()`）。
    """

    id: str


class RemoteConfigGroup(BaseModel):
    #: 省くと並び順から採番される。画面は候補一覧の機器IDをそのまま送る
    id: Optional[str] = None
    name: str
    buttons: List[RemoteConfigButton] = []


class RemoteConfigUpdate(BaseModel):
    """「電気の操作」に並べるボタンの登録内容（#262）。

    付けた名前・隠す指定（#260）も同じ本文で受け取り、1回の保存でまとめて書く。
    別々のAPIにすると、片方だけ通ったときに画面と保存内容が食い違う。
    """

    groups: List[RemoteConfigGroup] = []
    #: ボタンID -> {"label": 付けた名前, "hidden": 隠すか}。省くと今の設定を保つ
    buttons: Optional[Dict[str, Dict[str, Any]]] = None


class DailyEnergyItem(BaseModel):
    date: str
    source: Optional[str] = None
    kwh: Optional[float] = None
    cost_yen: Optional[float] = None
    #: いまの消費電力（W）。スマートプラグだけが返す。集計には使わず、
    #: カードに「動いているか」を出すためだけに最後の値を持つ。
    power_w: Optional[float] = None

    @model_validator(mode="after")
    def at_least_one_value(self):
        if self.kwh is None and self.cost_yen is None:
            raise ValueError("At least one of kwh or cost_yen is required")
        return self


class DailyEnergyPayload(BaseModel):
    """収集側が1日ぶんだけ送る場合と、まとめて送る場合の両方を受ける。"""

    source: Optional[str] = None
    records: List[DailyEnergyItem]


class UtilityBillItem(BaseModel):
    """月ごとの確定請求1件。はぴeみる電のお知らせメール1通ぶん。"""

    #: `2026-08` か `2026-08-01`
    billing_month: str
    #: `electricity` / `gas`
    kind: str
    #: お客さま番号のハッシュ先頭12文字。引越しの月に契約を区別するためだけに使う
    contract_key: Optional[str] = None
    plan_name: Optional[str] = None
    amount_yen: int
    usage_value: Optional[float] = None
    #: 電気は `kWh`、ガスは `m3`
    usage_unit: Optional[str] = None
    received_at: Optional[datetime.datetime] = None

    @model_validator(mode="after")
    def check_month_and_kind(self):
        """請求月と種別はここで弾く。

        保存の直前（`bills.upsert_records`）でも同じ検証をしているが、`DB_MOCK` では
        そこまで行かずに返す。モックの開発サーバー相手に収集スクリプトを試したときに
        書式の誤りが素通りすると、本番へ向けた瞬間に落ちる。
        """
        bills.parse_billing_month(self.billing_month)
        bills.normalize_kind(self.kind)
        return self


class UtilityBillPayload(BaseModel):
    records: List[UtilityBillItem]


class BambuStatePayload(BaseModel):
    """`collectors/bambu_to_myroom.py` からの送信（#428）。

    `report` は差分で届く MQTT の `print` を収集側でマージした全状態。プリンターに繋がって
    いないあいだは `report` を省き、`connected: false` だけを送る（保存済みの状態は残る）。
    """

    connected: bool
    last_message_at: Optional[str] = None
    report: Optional[Dict[str, Any]] = None
    #: 収集がプリンターSDの3mfから読んだ、いまのジョブの使用量（#454）。読めていないときは省く
    job_filament: Optional[Dict[str, Any]] = None

    @model_validator(mode="after")
    def report_is_not_oversized(self):
        if self.report is not None and len(json.dumps(self.report)) > bambu.MAX_REPORT_BYTES:
            raise ValueError("report is too large")
        if self.job_filament is not None and len(json.dumps(self.job_filament)) > 20_000:
            raise ValueError("job_filament is too large")
        return self

class AirconData(BaseModel):
    datetime: str
    ac_id: Optional[int] = 1
    name: Optional[str] = None
    room_temperature: Optional[float] = None
    target_temperature: Optional[float] = None
    humidity: Optional[int] = None
    mode: Optional[str] = None
    power: Optional[str] = None
    fan_speed: Optional[str] = None
    fan_swing: Optional[str] = None
    online: Optional[bool] = None
    model: Optional[str] = None

# AirCloud Home は自動運転時、設定温度そのものではなく室温からのシフト量
# （-3.0〜+3.0 程度、0 はシフトなし）を返す。固定の設定温度は 16〜32℃ の
# 範囲にしかならないため、この閾値で切り分ける。
AIRCON_AUTO_TARGET_OFFSET_LIMIT = 5.0


def _is_aircon_auto_target(value) -> bool:
    """設定温度がシフト量（自動運転）かどうか。0℃ の設定温度ではない。"""
    if value is None:
        return False
    try:
        return abs(float(value)) <= AIRCON_AUTO_TARGET_OFFSET_LIMIT
    except (TypeError, ValueError):
        return False


def _fetch_latest_aircon_record(
    db: Session, ac_id: Optional[int] = None
) -> Optional[database.AirconRecord]:
    if ac_id is not None:
        record = (
            db.query(database.AirconRecord)
            .filter(database.AirconRecord.ac_id == ac_id)
            .order_by(database.AirconRecord.datetime.desc())
            .first()
        )
        if record:
            return record

    return (
        db.query(database.AirconRecord)
        .order_by(database.AirconRecord.datetime.desc())
        .first()
    )


def _build_aircon_payload(
    record: Optional[database.AirconRecord],
    db: Optional[Session] = None,
) -> dict:
    if record is None:
        return {}

    return {
        "ac_id": record.ac_id,
        "datetime": record.datetime,
        "name": aircon_config.get_display_name(record.ac_id, record.name, db=db),
        "source_name": record.name,
        "room_temperature": record.room_temperature,
        "target_temperature": record.target_temperature,
        "humidity": record.humidity,
        "mode": record.mode,
        "power": record.power,
        "fan_speed": record.fan_speed,
        "fan_swing": record.fan_swing,
        "online": bool(record.online) if record.online is not None else None,
        "model": record.model,
    }

def _discover_device_ids(db: Optional[Session]) -> List[int]:
    if database.DB_MOCK or db is None:
        return []
    rows = db.query(database.SensorRecord.device_id).distinct().all()
    return sorted({row[0] for row in rows if row[0] is not None})


def _discover_ac_ids(db: Optional[Session]) -> List[int]:
    if database.DB_MOCK or db is None:
        return []
    rows = db.query(database.AirconRecord.ac_id).distinct().all()
    return sorted({row[0] for row in rows if row[0] is not None})


def _outdoor_only_day_records(
    outdoor_map: Dict[datetime.datetime, Dict[str, Any]],
    start_time: datetime.datetime,
    end_time: datetime.datetime,
) -> List[dict]:
    records: List[dict] = []
    for hour_dt, out_data in sorted(outdoor_map.items()):
        if hour_dt < start_time or hour_dt > end_time:
            continue
        if not any(out_data.get(key) is not None for key in ("temp", "humid", "press")):
            continue
        records.append(
            {
                "datetime": hour_dt,
                "outdoor_temperature": out_data.get("temp"),
                "outdoor_humidity": out_data.get("humid"),
                "outdoor_pressure": out_data.get("press"),
            }
        )
    return records


def _outdoor_only_year_records(
    outdoor_map: Dict[datetime.datetime, Dict[str, Any]],
    start_time: datetime.datetime,
    end_time: datetime.datetime,
) -> List[dict]:
    daily_outdoor: Dict[str, Dict[str, List[float]]] = {}
    for hour_dt, out_data in outdoor_map.items():
        if hour_dt < start_time or hour_dt > end_time:
            continue
        date_str = hour_dt.strftime("%Y-%m-%d")
        bucket = daily_outdoor.setdefault(
            date_str, {"temps": [], "humids": [], "pressures": []}
        )
        if out_data.get("temp") is not None:
            bucket["temps"].append(out_data["temp"])
        if out_data.get("humid") is not None:
            bucket["humids"].append(out_data["humid"])
        if out_data.get("press") is not None:
            bucket["pressures"].append(out_data["press"])

    aggregated: List[dict] = []
    for date_str, values in daily_outdoor.items():
        if not any(values.values()):
            continue
        dt = datetime.datetime.strptime(date_str, "%Y-%m-%d").replace(hour=12)
        entry: Dict[str, Any] = {"datetime": dt}
        if values["temps"]:
            entry["outdoor_temperature"] = round(
                sum(values["temps"]) / len(values["temps"]), 1
            )
            entry["outdoor_temperature_min"] = min(values["temps"])
            entry["outdoor_temperature_max"] = max(values["temps"])
        if values["humids"]:
            entry["outdoor_humidity"] = round(
                sum(values["humids"]) / len(values["humids"]), 1
            )
            entry["outdoor_humidity_min"] = min(values["humids"])
            entry["outdoor_humidity_max"] = max(values["humids"])
        if values["pressures"]:
            entry["outdoor_pressure"] = round(
                sum(values["pressures"]) / len(values["pressures"]), 1
            )
            entry["outdoor_pressure_min"] = min(values["pressures"])
            entry["outdoor_pressure_max"] = max(values["pressures"])
        aggregated.append(entry)

    aggregated.sort(key=lambda row: row["datetime"])
    return aggregated


def _build_outdoor_map(
    start_time: datetime.datetime,
    end_time: datetime.datetime,
    db: Optional[Session],
    location_id: Optional[str] = None,
) -> Dict[datetime.datetime, Dict[str, Any]]:
    outdoor_hist = weather.get_outdoor_history(
        start_time.strftime("%Y-%m-%d"),
        end_time.strftime("%Y-%m-%d"),
        db,
        location_id=location_id,
    )
    outdoor_map: Dict[datetime.datetime, Dict[str, Any]] = {}
    if not outdoor_hist:
        return outdoor_map

    for i, t_str in enumerate(outdoor_hist["time"]):
        try:
            dt_key = datetime.datetime.fromisoformat(t_str)
            outdoor_map[dt_key.replace(tzinfo=None)] = {
                "temp": outdoor_hist["temperature"][i],
                "humid": outdoor_hist["humidity"][i],
                "press": outdoor_hist["pressure"][i],
            }
        except Exception:
            pass
    return outdoor_map


def _build_outdoor_history_records(
    start_time: datetime.datetime,
    end_time: datetime.datetime,
    effective_range: Optional[str],
    db: Optional[Session],
    location_id: Optional[str] = None,
) -> List[dict]:
    outdoor_map = _build_outdoor_map(start_time, end_time, db, location_id)
    if effective_range == "year":
        return _outdoor_only_year_records(outdoor_map, start_time, end_time)
    return _outdoor_only_day_records(outdoor_map, start_time, end_time)


def _build_latest_payload(device: int, db: Optional[Session]) -> dict:
    if database.DB_MOCK:
        outdoor = weather.get_outdoor_weather(db)
        offset = (device - 1) * 0.4
        payload = {
            "device_id": device,
            "datetime": get_now_jst(),
            "temperature": round(23.5 + offset + random.uniform(-0.5, 0.5), 1),
            "humidity": round(45.0 - offset + random.uniform(-1, 1), 1),
            "outdoor_temperature": outdoor["temperature"] if outdoor else None,
            "outdoor_humidity": outdoor["humidity"] if outdoor else None,
            "outdoor_pressure": outdoor["pressure"] if outdoor else None,
            "outdoor_weather_code": outdoor["weather_code"] if outdoor else None,
            "outdoor_weather_label": outdoor["weather_label"] if outdoor else None,
            "outdoor_weather_icon": outdoor["weather_icon"] if outdoor else None,
        }
        if device == 1:
            payload["pressure"] = round(
                1013.0 + random.uniform(-1, 1) + _get_pressure_offset(device, db), 1
            )
            payload["illuminance"] = round(450.0 + random.uniform(-80, 80), 1)
        else:
            payload["co2"] = round(530 + random.uniform(-20, 20))
        return payload

    record = (
        db.query(database.SensorRecord)
        .filter(database.SensorRecord.device_id == device)
        .order_by(database.SensorRecord.datetime.desc())
        .first()
    )
    outdoor = weather.get_outdoor_weather(db)
    if not record:
        return {
            "device_id": device,
            "outdoor_temperature": outdoor["temperature"] if outdoor else None,
            "outdoor_humidity": outdoor["humidity"] if outdoor else None,
            "outdoor_pressure": outdoor["pressure"] if outdoor else None,
            "outdoor_weather_code": outdoor["weather_code"] if outdoor else None,
            "outdoor_weather_label": outdoor["weather_label"] if outdoor else None,
            "outdoor_weather_icon": outdoor["weather_icon"] if outdoor else None,
        }

    return {
        "device_id": device,
        "datetime": record.datetime,
        "temperature": record.temperature,
        "temperature_dht11": record.temperature_dht11,
        "humidity": record.humidity,
        "pressure": _normalize_pressure_hpa(record.pressure, _get_pressure_offset(device, db)),
        "co2": record.co2,
        "illuminance": record.illuminance,
        "outdoor_temperature": outdoor["temperature"] if outdoor else None,
        "outdoor_humidity": outdoor["humidity"] if outdoor else None,
        "outdoor_pressure": outdoor["pressure"] if outdoor else None,
        "outdoor_weather_code": outdoor["weather_code"] if outdoor else None,
        "outdoor_weather_label": outdoor["weather_label"] if outdoor else None,
        "outdoor_weather_icon": outdoor["weather_icon"] if outdoor else None,
    }

def _fetch_latest_aircon_record_for_unit(
    db: Optional[Session], ac_id: int
) -> Optional[database.AirconRecord]:
    """指定した室外機の最新記録。無ければ None。

    `_fetch_latest_aircon_record()` は ac_id に記録が無いと**別の室外機の記録**へ
    フォールバックする（画面が1台ぶんだけ表示する用途のため）。台数ぶん並べる
    内部APIでそれをやると他室の値が混ざるので、ここではフォールバックしない。
    """
    if database.DB_MOCK or db is None:
        return None
    return (
        db.query(database.AirconRecord)
        .filter(database.AirconRecord.ac_id == ac_id)
        .order_by(database.AirconRecord.datetime.desc())
        .first()
    )


def _build_room_state_sensors(db: Optional[Session]) -> List[dict]:
    """センサーごとの最新値。鮮度判定は sensor_monitor のものをそのまま載せる。"""
    statuses = sensor_monitor.collect_sensor_statuses(db)
    # 表示名は DB 側の設定が正。collect_sensor_statuses() は db を渡さずに名前を引くため、
    # DB に保存した名前ではなく data/devices.json 側の名前になることがある。
    names = {
        device["id"]: device["name"]
        for device in device_config.list_devices(_discover_device_ids(db), db=db)
    }

    sensors: List[dict] = []
    for status in statuses:
        device_id = status["device_id"]
        latest = _build_latest_payload(device_id, db) if status["has_data"] else {}
        sensors.append(
            {
                "deviceId": device_id,
                "name": names.get(device_id, status["name"]),
                # 1件も記録が無ければ null。行自体は返して「まだ記録が無い」と分かるようにする。
                "measuredAt": _to_jst_iso(latest.get("datetime")),
                "ageMinutes": status["age_minutes"],
                "stale": status["stale"],
                "temperature": latest.get("temperature"),
                "humidity": latest.get("humidity"),
                # 気圧オフセット適用後の hPa（_build_latest_payload が正規化済み）。
                "pressure": latest.get("pressure"),
                "co2": latest.get("co2"),
                "illuminance": latest.get("illuminance"),
            }
        )
    return sensors


def _build_room_state_aircons(db: Optional[Session], now: datetime.datetime) -> List[dict]:
    """エアコンごとの最新の状態。"""
    aircons: List[dict] = []
    for unit in aircon_config.list_units(_discover_ac_ids(db), db=db):
        ac_id = unit["ac_id"]
        if database.DB_MOCK:
            payload = database.generate_mock_aircon_latest(ac_id)
            payload["name"] = aircon_config.get_display_name(
                ac_id, payload.get("source_name"), db=db
            )
        else:
            record = _fetch_latest_aircon_record_for_unit(db, ac_id)
            payload = _build_aircon_payload(record, db=db)

        measured_at = _to_jst_iso(payload.get("datetime"))
        aircons.append(
            {
                "acId": ac_id,
                "name": payload.get("name") or unit["name"],
                "measuredAt": measured_at,
                "ageMinutes": _age_minutes(measured_at, now),
                "power": payload.get("power"),
                "mode": payload.get("mode"),
                "targetTemperature": payload.get("target_temperature"),
                "roomTemperature": payload.get("room_temperature"),
                "humidity": payload.get("humidity"),
                "fanSpeed": payload.get("fan_speed"),
                "online": payload.get("online"),
            }
        )
    return aircons


def _build_room_state_payload(db: Optional[Session]) -> dict:
    """`GET /api/internal/room-state` の応答を組み立てる。

    AIDE が「いま部屋は暑いか」「換気したほうがよいか」に答えるための一枚。
    複数回叩かせないため室内・屋外・エアコンを1回にまとめ、鮮度の判定も
    こちらで済ませて渡す（向こうで再実装するとしきい値が必ずズレる）。
    """
    now = datetime.datetime.now(JST)
    outdoor = weather.get_outdoor_weather(db)

    return {
        "fetchedAt": now.isoformat(),
        "staleThresholdMinutes": sensor_monitor.stale_threshold_minutes(),
        "sensors": _build_room_state_sensors(db),
        "outdoor": {
            "temperature": outdoor.get("temperature"),
            "humidity": outdoor.get("humidity"),
            "pressure": outdoor.get("pressure"),
            "observedAt": _to_jst_iso(outdoor.get("observed_at")),
        }
        if outdoor
        else None,
        "aircons": _build_room_state_aircons(db, now),
    }


# --- Endpoints ---

@app.get("/api/health")
@app.head("/api/health")
async def health_check():
    return {"status": "ok", "db_mock": database.DB_MOCK}


@app.get("/api/sensors/status")
def get_sensors_status(
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    statuses = sensor_monitor.collect_sensor_statuses(db)
    stale_devices = [item for item in statuses if item["stale"]]
    return {
        "threshold_minutes": sensor_monitor.stale_threshold_minutes(),
        "healthy": len(stale_devices) == 0,
        "devices": statuses,
    }


@app.get("/api/internal/room-state")
def get_internal_room_state(
    db: Session = Depends(database.get_db),
    _: None = Depends(require_internal_token),
):
    """いまの部屋の状態を1回で返す、サーバー間参照用の読み取りAPI。

    ログインセッションでは通らない（`INTERNAL_API_KEY` の Bearer トークン専用）。
    利用者は同じVPS上で動く AIDE の MCP サーバー（guchi-apps/aide#101）。

    **書き込み・設定変更の口はここに足さないこと。** ユーザーJWTを介さない経路なので、
    増やすほど「ログインしていない誰かが叩ける操作」が増える。操作は別のトークン
    （`INTERNAL_CONTROL_API_KEY`）で通る `/api/internal/remote/…` に限る（#419）。
    """
    return _build_room_state_payload(db)


@app.get("/api/internal/bambu/printer")
def get_internal_bambu_printer(
    db: Session = Depends(database.get_db),
    _: None = Depends(require_internal_token),
):
    """Bambu Lab A1 mini の正規化済みの状態を返す、サーバー間参照用の読み取りAPI（#428）。

    現在値（`printer`）は `online` のときだけ入る。収集が止まっている・プリンターに繋がって
    いないときは `printer` を `null` にし、最後に受け取った値は `lastKnown` へ分ける
    （古い値を「いま」の値として読ませない）。`connection` が理由で、`ageSeconds` が
    最後の受信からの経過。**印刷を操作する口はここに足さないこと**（第1段階は読み取りのみ）。
    """
    return bambu.build_response(bambu.get_record(db))


@app.get("/api/bambu/printer")
def get_bambu_printer(
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """ダッシュボードの「3Dプリンター」カード用（#436）。

    応答の形は `/api/internal/bambu/printer` と同じ（`bambu.build_response()`）。
    ユーザーJWTで守るのは、画面から読む経路をサーバー間参照用の内部APIと分けるため
    （内部APIのトークンをブラウザへ渡さない）。現在値は `online` のときだけ `printer` に入り、
    収集停止・接続なしのときは `lastKnown` に分かれる。**読み取りだけで、印刷の操作は足さない。**
    """
    return bambu.build_response(bambu.get_record(db))


@app.post("/api/bambu/printer/ack")
def acknowledge_bambu_printer(
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """「取り出した」操作（#464）。

    印刷完了・停止のまま次の印刷を始めるまでカードの表示が張り付く問題への対応。現在の状態が
    完了（finished）・停止（failed）のときだけ確認済みにし、カードの表示を待機中相当へ戻す。
    新しい印刷が始まれば `bambu.record_state()` が確認状態を自動でリセットする。対象外の状態
    （印刷中など）で呼ばれても何も変えず、現在の状態をそのまま返す。**印刷の操作ではない。**
    """
    return bambu.build_response(bambu.acknowledge_finished(db))


@app.get("/api/garbage")
def get_garbage_schedule(_: dict = Depends(get_current_user)):
    """今日・明日・この先の収集予定。data/garbage.json の定義から計算する。"""
    return garbage.build_payload()


@app.get("/api/push/vapid-public-key")
def get_push_vapid_public_key(_: dict = Depends(get_current_user)):
    """PWA Pushの購読に使う公開鍵。秘密鍵はサーバーの外へは一切返さない。"""
    public_key = push_notify.get_vapid_public_key()
    if not public_key:
        raise HTTPException(status_code=503, detail="Web Push is not configured")
    return {"publicKey": public_key, "configured": push_notify.is_configured()}


@app.post("/api/push/subscribe")
def subscribe_push(
    body: PushSubscriptionBody,
    request: Request,
    _: dict = Depends(get_current_user),
):
    """この端末のブラウザ購読を保存する。ログイン済みの操作でのみ受け付ける。"""
    if not push_notify.is_configured():
        raise HTTPException(status_code=503, detail="Web Push is not configured")
    try:
        saved = push_subscriptions.upsert_subscription(
            body.model_dump(exclude={"expirationTime"}),
            user_agent=request.headers.get("user-agent", ""),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "ok", "endpoint": saved["endpoint"]}


@app.delete("/api/push/subscribe")
def unsubscribe_push(
    body: PushUnsubscribeRequest,
    _: dict = Depends(get_current_user),
):
    """この端末の購読を削除する。以後この端末へは配信しない。"""
    removed = push_subscriptions.remove_subscription(body.endpoint)
    if not removed:
        raise HTTPException(status_code=404, detail="Subscription not found")
    return {"status": "ok"}


@app.post("/api/push/test")
def send_test_push(_: dict = Depends(get_current_user)):
    """いま保存されている購読すべてへテスト通知を送る。"""
    if not push_notify.is_configured():
        raise HTTPException(status_code=503, detail="Web Push is not configured")
    result = push_notify.send_test_push()
    return {"status": "ok", **result}


@app.get("/api/apns/status")
def get_apns_status(_: dict = Depends(get_current_user)):
    """iOSアプリ（#526）のAPNs通知がサーバー側で設定済みか。"""
    return {"configured": apns_notify.is_configured()}


@app.post("/api/apns/register")
def register_apns_token(
    body: ApnsRegisterBody,
    request: Request,
    _: dict = Depends(get_current_user),
):
    """この端末のAPNsデバイストークンを保存する。ログイン済みの操作でのみ受け付ける。"""
    if not apns_notify.is_configured():
        raise HTTPException(status_code=503, detail="APNs is not configured")
    try:
        apns_subscriptions.upsert_token(
            body.token, user_agent=request.headers.get("user-agent", "")
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "ok"}


@app.delete("/api/apns/register")
def unregister_apns_token(
    body: ApnsUnregisterRequest,
    _: dict = Depends(get_current_user),
):
    """この端末のAPNsトークンを削除する。以後この端末へは配信しない。"""
    removed = apns_subscriptions.remove_token(body.token)
    if not removed:
        raise HTTPException(status_code=404, detail="Token not found")
    return {"status": "ok"}


@app.post("/api/apns/test")
def send_test_apns(_: dict = Depends(get_current_user)):
    """いま保存されているAPNsトークンすべてへテスト通知を送る。"""
    if not apns_notify.is_configured():
        raise HTTPException(status_code=503, detail="APNs is not configured")
    result = apns_notify.send_test_push()
    return {"status": "ok", **result}


@app.get("/api/cleaning")
def get_cleaning(
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """掃除の予定と、次にやる日・残り日数。定義は app_settings に入っている。"""
    return cleaning.build_payload(cleaning.get_tasks(db))


@app.put("/api/cleaning/tasks")
def update_cleaning_tasks(
    body: CleaningTasksUpdate,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """定義をまとめて置き換える（追加・編集・削除・並べ替えを1回で受ける）。"""
    tasks = cleaning.save_tasks([item.model_dump() for item in body.tasks], db=db)
    return cleaning.build_payload(tasks)


def _parse_cleaning_done_date(value: Optional[str]) -> Optional[datetime.date]:
    """掃除した日を受ける。未指定は None（＝今日）、未来の日と読めない値は400。

    未来の日を黙って落とすと `_normalize_history` が捨てて「押したのに増えない」に
    見えるので、ここで弾いて理由を返す。
    """
    if not value:
        return None
    try:
        parsed = datetime.date.fromisoformat(value)
    except ValueError:
        raise HTTPException(
            status_code=400, detail="date は YYYY-MM-DD で指定してください"
        ) from None
    if parsed > cleaning.get_today_jst():
        raise HTTPException(status_code=400, detail="未来の日付は指定できません")
    return parsed


@app.post("/api/cleaning/tasks/{task_id}/done")
def mark_cleaning_done(
    task_id: str,
    body: Optional[CleaningDoneRequest] = None,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """掃除をやった記録を足す。次にやる日はこの日から数え直す。

    `date` は「掃除した日」で、省略すると今日（JST）。当日に押し忘れたときのために
    過去の日を受けるが、**未来の日は受けない**（#294）。登録した日時は別に記録される。
    """
    done_on = _parse_cleaning_done_date(body.date if body is not None else None)

    tasks, found = cleaning.mark_done(task_id, db, done_on=done_on)
    if not found:
        raise HTTPException(status_code=404, detail="指定された掃除が見つかりません")
    return cleaning.build_payload(tasks)


@app.delete("/api/cleaning/tasks/{task_id}/done/{done_date}")
def delete_cleaning_done(
    task_id: str,
    done_date: str,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """掃除の記録を1件取り消す。日付を間違えて登録したときの直し方（#294）。"""
    done_on = _parse_cleaning_done_date(done_date)
    if done_on is None:
        raise HTTPException(status_code=400, detail="date は YYYY-MM-DD で指定してください")

    tasks, removed = cleaning.remove_done(task_id, done_on, db)
    if not removed:
        raise HTTPException(status_code=404, detail="指定された掃除の記録が見つかりません")
    return cleaning.build_payload(tasks)


def _filament_response(action):
    """フィラメントの操作を実行し、入力の誤りは400・対象なしは404で返す。応答は常に最新の一覧。"""
    try:
        document = action()
    except filament.SpoolNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    except filament.FilamentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return filament.build_payload(document)


@app.get("/api/filament")
def get_filament(
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """フィラメントのスプール一覧と、残量（計量と使用量から計算済み）。"""
    return filament.build_payload(filament.get_document(db))


@app.post("/api/filament/spools")
def create_filament_spool(
    body: FilamentSpoolCreate,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    return _filament_response(lambda: filament.add_spool(body.model_dump(), db))


@app.put("/api/filament/spools/{spool_id}")
def update_filament_spool(
    spool_id: str,
    body: FilamentSpoolUpdate,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    return _filament_response(
        lambda: filament.update_spool(spool_id, body.model_dump(exclude_unset=True), db)
    )


@app.delete("/api/filament/spools/{spool_id}")
def delete_filament_spool(
    spool_id: str,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    return _filament_response(lambda: filament.delete_spool(spool_id, db))


@app.put("/api/filament/active")
def update_filament_active(
    body: FilamentActiveRequest,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """いま使っているスプールを選ぶ。`spool_id: null` で外す。"""
    return _filament_response(lambda: filament.set_active(body.spool_id, db))


@app.post("/api/filament/spools/{spool_id}/weigh")
def weigh_filament_spool(
    spool_id: str,
    body: FilamentWeighRequest,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """秤で量った全体重量を記録する。以後の残量はこの値が基準になる。"""
    return _filament_response(
        lambda: filament.record_weighing(spool_id, body.gross_g, db, date=body.date)
    )


@app.delete("/api/filament/spools/{spool_id}/weigh/{weighing_id}")
def delete_filament_weighing(
    spool_id: str,
    weighing_id: str,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    return _filament_response(lambda: filament.remove_weighing(spool_id, weighing_id, db))


@app.post("/api/filament/spools/{spool_id}/usage")
def record_filament_usage(
    spool_id: str,
    body: FilamentUsageRequest,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """印刷で使った量（スライサーが出すg数）を記録する。"""
    return _filament_response(
        lambda: filament.record_usage(
            spool_id, body.grams, db, date=body.date, note=body.note
        )
    )


@app.delete("/api/filament/spools/{spool_id}/usage/{usage_id}")
def delete_filament_usage(
    spool_id: str,
    usage_id: str,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    return _filament_response(lambda: filament.remove_usage(spool_id, usage_id, db))


def _remote_button_overrides(db: Session) -> Dict[str, Any]:
    """画面から付けたボタン名・隠す指定。UI設定に入っている（#260）。"""
    return ui_settings.get_settings(db).get(ui_settings.SETTING_REMOTE_BUTTONS, {})


@app.get("/api/remote/buttons")
def get_remote_buttons(
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """押せるリモコン操作の一覧。data/remote.json の定義に、画面で付けた名前を被せて返す。

    ここでは Nature Remo を叩かない。外部APIへ出るのは実際に押したときだけ（#106）。
    隠したボタンも `hidden: true` を付けて返す（設定画面が一覧に出すため）。
    """
    return remote.build_payload(_remote_button_overrides(db), db)


@app.post("/api/remote/buttons/{button_id}/send")
def send_remote_button(
    button_id: str,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """赤外線を送る。

    返せるのは「Nature Remo が送信を受け付けたか」までで、機器が実際に反応したかは
    赤外線が片方向のため分からない。
    """
    try:
        return remote.press(button_id, _remote_button_overrides(db), db)
    except remote.RemoteError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from None


@app.get("/api/internal/remote/buttons")
def get_internal_remote_buttons(
    db: Session = Depends(database.get_db),
    _: None = Depends(require_internal_control_token),
):
    """押せるリモコン操作の一覧。AIDE が「何を押せるか」を知るためのサーバー間用（#419）。

    `GET /api/remote/buttons` と同じ形を返し、Nature Remo は叩かない。
    ログインセッションでも読み取り用の `INTERNAL_API_KEY` でも通らない
    （`INTERNAL_CONTROL_API_KEY` の Bearer トークン専用）。
    """
    return remote.build_payload(_remote_button_overrides(db), db)


@app.post("/api/internal/remote/buttons/{button_id}/send")
def send_internal_remote_button(
    button_id: str,
    db: Session = Depends(database.get_db),
    _: None = Depends(require_internal_control_token),
):
    """画面で登録済みのボタンを押して赤外線を送る、サーバー間用の操作API（#419）。

    **受け取るのはボタンIDだけ。** signal ID・appliance ID を直接受ける口は作らない
    （登録していない機器へ送れてしまうため）。失敗は `remote.RemoteError` の
    status（404 未登録・429 送信回数の上限・502 Nature Remo の失敗・503 トークン未設定）と
    利用者向けの文言をそのまま返す。

    **この口で押せるのは「登録済みボタン」だけ。** ユーザーJWTを介さない書き込みの口なので、
    signal ID・appliance ID を直接受ける口は作らない。エアコンの運転指示（電源・モード・設定温度・
    風量）は別の口（`/api/internal/aircon/units/{ac_id}/control`・#439）で、範囲は
    「登録済みボタンを押す」と「エアコンの運転指示」の2つまで。それ以外の書き込みは足さないこと。
    """
    try:
        return remote.press(button_id, _remote_button_overrides(db), db)
    except remote.RemoteError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from None


@app.get("/api/remote/catalog")
def get_remote_catalog(
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """Nature Remo に登録済みの操作のうち、ボタンにできるものの一覧（#262）。

    **ここでも Nature Remo は叩かない。** 返すのは最後に取得した控えで、取り直しは
    `POST /api/remote/catalog/refresh`（Cloud API の上限は 30回/5分）。
    signal ID・appliance ID は落として返す。
    """
    return remote.catalog_payload(remote.load_catalog(db))


@app.post("/api/remote/catalog/refresh")
def refresh_remote_catalog(
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """Nature Remo へ問い合わせて一覧を取り直し、控えを更新する。"""
    try:
        catalog = remote.fetch_catalog()
    except remote.RemoteError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from None

    ui_settings.save_settings({ui_settings.SETTING_REMOTE_CATALOG: catalog}, db)
    return remote.catalog_payload(catalog)


@app.put("/api/remote/config")
def save_remote_config(
    payload: RemoteConfigUpdate,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """並べるボタンの登録内容を保存する（#262）。

    保存先は `data/remote.json` ではなく DB。ファイルはデプロイの rsync で
    リポジトリの中身に戻るため、画面から書いても次のデプロイで消える。
    """
    config = remote.resolve_config(payload.model_dump(), db)

    updates: Dict[str, Any] = {ui_settings.SETTING_REMOTE_BUTTON_DEFS: config}
    if payload.buttons is not None:
        # 登録から外したボタンの設定は道連れに消す（残すとゴミが溜まり続ける）
        updates[ui_settings.SETTING_REMOTE_BUTTONS] = remote.prune_overrides(
            payload.buttons, config
        )
    ui_settings.save_settings(updates, db)

    return remote.build_payload(_remote_button_overrides(db), db)


@app.get("/api/auth/me")
async def auth_me(user: dict = Depends(get_current_user)):
    return {"email": user.get("email")}


@app.post("/api/auth/login-notify", status_code=204)
def notify_login(
    request: Request,
    background_tasks: BackgroundTasks,
    user: dict = Depends(get_current_user),
):
    """ログイン成功を Signaly へ通知する（#240）。

    Supabase Auth ではコールバックが Supabase 側にあるため、バックエンドには
    「ログインした瞬間」が通らない。フロントエンドの `/auth/callback` が
    OAuth のコード交換を終えた直後に1回だけ叩く。

    **通知の送信はレスポンスを返した後に回す。** Webhook が詰まっている間
    ログイン後の画面遷移を待たせないため。送信の成否は呼び出し元へ返さない。
    """
    payload = login_notify.build_login_notification(
        str(user.get("email") or ""),
        request,
    )
    background_tasks.add_task(login_notify.send_login_notification, payload)


@app.get("/api/outdoor-location")
def get_outdoor_location(db: Session = Depends(database.get_db), _: dict = Depends(get_current_user)):
    return outdoor_config.get_location(db)


@app.put("/api/outdoor-location")
def update_outdoor_location(
    location: OutdoorLocation,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    try:
        return outdoor_config.save_location(
            location.latitude,
            location.longitude,
            location.name,
            db,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.get("/api/outdoor-location/search")
def search_outdoor_locations(
    q: str = "",
    limit: int = 8,
    _: dict = Depends(get_current_user),
):
    if limit < 1 or limit > 20:
        limit = 8
    return {"results": weather.search_locations(q, count=limit)}


@app.get("/api/outdoor-locations")
def list_outdoor_locations(
    db: Session = Depends(database.get_db), _: dict = Depends(get_current_user)
):
    return {"locations": outdoor_config.list_locations(db)}


def _outdoor_location_weather_payload(loc: dict, db: Session) -> dict:
    data = weather.get_outdoor_weather(db, location_id=loc["id"])
    return {
        "id": loc["id"],
        "name": loc["name"],
        "temperature": data["temperature"] if data else None,
        "humidity": data["humidity"] if data else None,
        "pressure": data["pressure"] if data else None,
        "weather_code": data["weather_code"] if data else None,
        "weather_label": data["weather_label"] if data else None,
        "weather_icon": data["weather_icon"] if data else None,
        "observed_at": data["observed_at"] if data else None,
    }


@app.get("/api/outdoor-locations/weather")
def list_outdoor_locations_weather(
    db: Session = Depends(database.get_db), _: dict = Depends(get_current_user)
):
    """全地点の「いまの天気」をまとめて返す（#321）。

    ダッシュボードは地点ごとに1枚のカードを出すため、地点の数だけ
    `/api/outdoor-locations/{id}/weather` を叩くと往復が増える。取得そのものは
    `weather.get_outdoor_weather()` の座標ごとのキャッシュ（5分）に乗るので、
    まとめて返すだけで外部APIの呼び出しは増えない。
    """
    locations = outdoor_config.list_locations(db)
    return {
        "locations": [_outdoor_location_weather_payload(loc, db) for loc in locations]
    }


@app.post("/api/outdoor-locations")
def create_outdoor_location(
    location: OutdoorLocationInput,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    try:
        return outdoor_config.add_location(
            location.name, location.latitude, location.longitude, db
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.put("/api/outdoor-locations/{location_id}")
def update_outdoor_location_by_id(
    location_id: str,
    location: OutdoorLocationInput,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    try:
        return outdoor_config.update_location(
            location_id, location.name, location.latitude, location.longitude, db
        )
    except ValueError as e:
        status_code = 404 if str(e) == "location not found" else 400
        raise HTTPException(status_code=status_code, detail=str(e)) from e


@app.delete("/api/outdoor-locations/{location_id}")
def delete_outdoor_location(
    location_id: str,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    try:
        outdoor_config.delete_location(location_id, db)
    except ValueError as e:
        status_code = 404 if str(e) == "location not found" else 400
        raise HTTPException(status_code=status_code, detail=str(e)) from e
    return {"ok": True}


@app.put("/api/outdoor-locations/{location_id}/primary")
def set_primary_outdoor_location(
    location_id: str,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    try:
        return outdoor_config.set_primary_location(location_id, db)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@app.get("/api/outdoor-locations/{location_id}/weather")
def get_outdoor_location_weather(
    location_id: str,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    loc = outdoor_config.get_location_by_id(location_id, db)
    if loc is None:
        raise HTTPException(status_code=404, detail="location not found")
    return _outdoor_location_weather_payload(loc, db)


@app.get("/api/outdoor-history")
def get_outdoor_history(
    date: Optional[str] = None,
    range: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    location_id: Optional[str] = None,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    start_time, end_time, effective_range = _resolve_history_window(date, range, start, end)
    return _build_outdoor_history_records(start_time, end_time, effective_range, db, location_id)


@app.get("/api/devices")
def get_devices(db: Session = Depends(database.get_db), _: dict = Depends(get_current_user)):
    return {"devices": device_config.list_devices(_discover_device_ids(db), db=db)}


@app.put("/api/devices/{device_id}")
def update_device_name(
    device_id: int,
    body: DeviceNameUpdate,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    if device_id < 1:
        raise HTTPException(status_code=400, detail="device id must be >= 1")
    try:
        inherits_kw: object = ...
        if "inherits_from" in body.model_fields_set:
            inherits_kw = body.inherits_from
        device = device_config.save_device_name(
            device_id,
            body.name,
            db=db,
            inherits_from=inherits_kw,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return device


@app.get("/api/aircon/units")
def get_aircon_units(db: Session = Depends(database.get_db), _: dict = Depends(get_current_user)):
    # `control_enabled` は「操作パネルを出してよいか」。白くまくんのログイン情報が
    # 本番の .env に入るまでは false になり、画面は表示だけになる（#213）。
    return {
        "units": aircon_config.list_units(_discover_ac_ids(db), db=db),
        "control_enabled": aircon_control.is_configured(),
    }


def _aircon_control_error(exc: aircon_control.AirconControlError) -> HTTPException:
    """操作の失敗をHTTPへ。**理由が分かる形で画面へ返す。**

    「送ったのに効かない」がいちばん困るので、つながらない・混んでいる・設定されていない
    を区別できるようにしておく。
    """
    if isinstance(exc, aircon_control.AirconControlNotConfigured):
        return HTTPException(status_code=503, detail=str(exc))
    if isinstance(exc, aircon_control.AirconControlRateLimited):
        return HTTPException(
            status_code=429,
            detail=str(exc),
            headers={"Retry-After": str(exc.retry_after_sec)},
        )
    if isinstance(exc, aircon_control.AirconUnitNotFound):
        return HTTPException(status_code=404, detail=str(exc))
    return HTTPException(status_code=502, detail=str(exc))


def _read_aircon_state(ac_id: int, db: Session) -> dict:
    """エアコンから直接読んだ状態（表示名は画面の設定を反映）。画面用と内部APIで共通。"""
    if ac_id < 1:
        raise HTTPException(status_code=400, detail="ac id must be >= 1")
    try:
        state = aircon_control.get_state(ac_id)
    except aircon_control.AirconControlError as e:
        raise _aircon_control_error(e) from e

    state["name"] = aircon_config.get_display_name(ac_id, state.get("name"), db=db)
    return state


def _apply_aircon_command(ac_id: int, command: dict, db: Session) -> dict:
    """運転指示を送り、送信後の状態を返す。検証と現在値との混合は `aircon_control` に任せる。"""
    if ac_id < 1:
        raise HTTPException(status_code=400, detail="ac id must be >= 1")

    try:
        state = aircon_control.apply_command(ac_id, command)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except aircon_control.AirconControlError as e:
        raise _aircon_control_error(e) from e

    state["name"] = aircon_config.get_display_name(ac_id, state.get("name"), db=db)
    return state


@app.get("/api/aircon/units/{ac_id}/state")
def get_aircon_control_state(
    ac_id: int,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """操作パネルが開くときの状態。

    **DBの最新記録ではなく、エアコンから直接読む。** DBへ入るのはラズパイの5分ごとの
    取り込み待ちで、操作の直後は必ず古い。
    """
    return _read_aircon_state(ac_id, db)


@app.post("/api/aircon/units/{ac_id}/control")
def control_aircon_unit(
    ac_id: int,
    body: AirconControlCommand,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """運転指示を送る。返すのは送信後の状態。"""
    return _apply_aircon_command(ac_id, body.model_dump(exclude_none=True), db)


@app.get("/api/internal/aircon/units/{ac_id}/state")
def get_internal_aircon_state(
    ac_id: int,
    db: Session = Depends(database.get_db),
    _: None = Depends(require_internal_control_token),
):
    """エアコンの今の状態。AIDE が操作の前後に読むためのサーバー間用（#439）。

    `GET /api/aircon/units/{ac_id}/state` と同じ応答（白くまくんから直接読む・表示名つき）。
    ログインセッションでも読み取り用の `INTERNAL_API_KEY` でも通らない
    （`INTERNAL_CONTROL_API_KEY` の Bearer トークン専用）。読み取りだが白くまくんのクラウドを
    叩く経路なので、操作用トークンの側に置いている。
    """
    return _read_aircon_state(ac_id, db)


@app.post("/api/internal/aircon/units/{ac_id}/control")
def control_internal_aircon_unit(
    ac_id: int,
    body: InternalAirconControlCommand,
    db: Session = Depends(database.get_db),
    _: None = Depends(require_internal_control_token),
):
    """エアコンの運転指示を送る、サーバー間用の操作API（#439）。返すのは送信後の状態。

    検証・現在値との混合（`aircon_control.merge_command`）・失敗のステータスと文言は
    画面用の `POST /api/aircon/units/{ac_id}/control` と同じ。**温度の意味（自動運転は
    シフト量）は呼ぶ側で解釈させない**——数値をそのまま渡し、ここで現在のモードと突き合わせる。
    受け取るのは `power` / `mode` / `target_temperature` / `fan_speed` の4つだけで、
    風向は受けない。範囲は「運転指示」に絞り、名前の変更・登録の変更などはここに足さないこと。
    """
    return _apply_aircon_command(ac_id, body.model_dump(exclude_none=True), db)


@app.put("/api/aircon/units/{ac_id}")
def update_aircon_unit_name(
    ac_id: int,
    body: AirconNameUpdate,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    if ac_id < 1:
        raise HTTPException(status_code=400, detail="ac id must be >= 1")
    try:
        unit = aircon_config.save_unit_name(ac_id, body.name, db=db)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return unit


@app.get("/api/ui-settings")
def get_ui_settings(db: Session = Depends(database.get_db), _: dict = Depends(get_current_user)):
    return ui_settings.get_settings(db)


@app.put("/api/ui-settings")
def update_ui_settings(
    body: UiSettingsUpdate,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    updates = body.model_dump(exclude_unset=True)
    return ui_settings.save_settings(updates, db=db)

@app.post("/api/sensor")
async def create_sensor_data(
    data: SensorData,
    device: int = 1,
    device_name: Optional[str] = Query(None, description="初回登録時の表示名（省略可）"),
    db: Session = Depends(database.get_db)
):
    """
    Receive sensor data from devices.
    """
    if database.DB_MOCK:
        return {"status": "mock_ok", "received": data}

    try:
        # Parse datetime string "YYYY-MM-DD HH:MM:00"
        try:
            dt = datetime.datetime.strptime(data.datetime, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            # Try ISO format if default fails
            dt = datetime.datetime.fromisoformat(data.datetime)
            
        # Create record
        # Note: Pressure is stored as integer (Pa?) in DB based on get_latest logic (val / 100.0)
        # Assuming input is hPa (e.g. 1013), store as 101300
        record = database.SensorRecord(
            datetime=dt,
            device_id=device,
            temperature=data.temperature,
            temperature_dht11=data.temperature_dht11,
            humidity=int(data.humidity) if data.humidity is not None else None,
            pressure=int(data.pressure) if data.pressure is not None else None,
            co2=data.co2,
            illuminance=data.illuminance,
        )
        
        db.add(record)
        db.commit()
        device_config.ensure_device(device, device_name, db=db)
        return {"status": "ok"}
    except Exception as e:
        db.rollback()
        logger.exception("sensorの保存に失敗")
        raise HTTPException(status_code=500, detail="internal error")

@app.get("/api/latest")
def get_latest(
    device: int = 1,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    if device < 1:
        raise HTTPException(status_code=400, detail="device id must be >= 1")
    return _build_latest_payload(device, db)

from sqlalchemy import func

@app.get("/api/daily-stats")
def get_daily_stats(
    device: int = 1,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    if database.DB_MOCK:
        return database.generate_mock_daily()
        
    today = datetime.date.today()
    start_date = today - datetime.timedelta(days=30)
    
    import pandas as pd
    
    # Fetch raw data for the last 7 days for specific device
    records = db.query(database.SensorRecord).filter(
        database.SensorRecord.datetime >= start_date,
        database.SensorRecord.device_id == device
    ).all()
    
    if not records:
        return []

    pressure_offset = _get_pressure_offset(device, db)
    data = [{
        "datetime": r.datetime,
        "temperature": r.temperature,
        "temperature_dht11": r.temperature_dht11,
        "humidity": r.humidity,
        "pressure": _normalize_pressure_hpa(r.pressure, pressure_offset),
        "co2": r.co2,
        "illuminance": r.illuminance,
    } for r in records]
    
    df = pd.DataFrame(data)
    df['date'] = df['datetime'].dt.date
    daily_stats = []
    
    # Check if dataframe is not empty
    if not df.empty:
        for date, group in df.groupby('date'):
            daily_stat = {"date": date}

            if group['temperature'].notna().any():
                max_temp_row = group.loc[group['temperature'].idxmax()]
                min_temp_row = group.loc[group['temperature'].idxmin()]
                daily_stat.update({
                    "temp_max": float(max_temp_row['temperature']),
                    "temp_max_time": max_temp_row['datetime'].strftime("%H:%M"),
                    "temp_min": float(min_temp_row['temperature']),
                    "temp_min_time": min_temp_row['datetime'].strftime("%H:%M"),
                })

            if group['humidity'].notna().any():
                daily_stat.update({
                    "humid_max": float(group['humidity'].max()),
                    "humid_min": float(group['humidity'].min()),
                })

            if group['pressure'].notna().any():
                daily_stat.update({
                    "pressure_max": float(group['pressure'].max()),
                    "pressure_min": float(group['pressure'].min()),
                })

            if 'co2' in group.columns and group['co2'].notna().any():
                daily_stat.update({
                    "co2_max": float(group['co2'].max()),
                    "co2_min": float(group['co2'].min()),
                })

            if 'illuminance' in group.columns and group['illuminance'].notna().any():
                daily_stat.update({
                    "illuminance_max": float(group['illuminance'].max()),
                    "illuminance_min": float(group['illuminance'].min()),
                })

            daily_stats.append(daily_stat)
    
    # Sort by date
    daily_stats.sort(key=lambda x: x['date'])
    
    return daily_stats


@app.get("/api/aircon/daily-stats")
def get_aircon_daily_stats(
    ac_id: int = 1,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    if ac_id < 1:
        raise HTTPException(status_code=400, detail="ac_id must be >= 1")
    if database.DB_MOCK:
        return database.generate_mock_aircon_daily(ac_id)

    today = datetime.date.today()
    start_date = today - datetime.timedelta(days=30)

    import pandas as pd

    records = (
        db.query(database.AirconRecord)
        .filter(
            database.AirconRecord.datetime >= start_date,
            database.AirconRecord.ac_id == ac_id,
            database.AirconRecord.room_temperature.isnot(None),
        )
        .all()
    )

    if not records:
        return []

    data = [
        {
            "datetime": record.datetime,
            "room_temperature": record.room_temperature,
        }
        for record in records
    ]

    df = pd.DataFrame(data)
    df["date"] = df["datetime"].dt.date
    daily_stats = []

    for date, group in df.groupby("date"):
        max_row = group.loc[group["room_temperature"].idxmax()]
        min_row = group.loc[group["room_temperature"].idxmin()]
        daily_stats.append(
            {
                "date": date,
                "temp_max": float(max_row["room_temperature"]),
                "temp_max_time": max_row["datetime"].strftime("%H:%M"),
                "temp_min": float(min_row["room_temperature"]),
                "temp_min_time": min_row["datetime"].strftime("%H:%M"),
            }
        )

    daily_stats.sort(key=lambda x: x["date"])
    return daily_stats

@app.post("/api/aircon")
async def create_aircon_data(
    data: AirconData,
    db: Session = Depends(database.get_db),
):
    """Receive air conditioner status from AirCloud Home collector."""
    if database.DB_MOCK:
        return {"status": "mock_ok", "received": data}

    try:
        try:
            dt = datetime.datetime.strptime(data.datetime, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            dt = datetime.datetime.fromisoformat(data.datetime)

        record = database.AirconRecord(
            datetime=dt,
            ac_id=data.ac_id or 1,
            name=data.name,
            room_temperature=data.room_temperature,
            target_temperature=data.target_temperature,
            humidity=data.humidity,
            mode=data.mode,
            power=data.power,
            fan_speed=data.fan_speed,
            fan_swing=data.fan_swing,
            online=1 if data.online else 0 if data.online is not None else None,
            model=data.model,
        )

        db.add(record)
        db.commit()
        return {"status": "ok"}
    except Exception as e:
        db.rollback()
        logger.exception("airconの保存に失敗")
        raise HTTPException(status_code=500, detail="internal error") from e


@app.post("/api/energy")
async def create_daily_energy(
    payload: DailyEnergyPayload,
    db: Session = Depends(database.get_db),
):
    """日別の電力使用量を受け取る（Raspberry Pi の収集スクリプトから）。

    同じ (date, source) は上書きする。当日ぶんは1日のあいだ増えていくため、
    追記だと二重計上になる。
    """
    if database.DB_MOCK:
        return {"status": "mock_ok", "received": len(payload.records)}

    default_source = payload.source or energy.DEFAULT_SOURCE
    try:
        records = [
            {
                "date": energy.parse_date(item.date),
                "source": item.source or default_source,
                "kwh": item.kwh,
                "cost_yen": item.cost_yen,
                "power_w": item.power_w,
            }
            for item in payload.records
        ]
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    try:
        written = energy.upsert_records(db, records, now=get_now_jst())
        return {"status": "ok", "written": written}
    except Exception as e:
        db.rollback()
        logger.exception("energyの保存に失敗")
        raise HTTPException(status_code=500, detail="internal error") from e


@app.get("/api/energy/summary")
def get_energy_summary(
    source: str = energy.DEFAULT_SOURCE,
    days: int = Query(default=energy.DEFAULT_HISTORY_DAYS, ge=1, le=400),
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """取得元を1つに絞った集計。カードは `/api/energy/breakdown` を使う。"""
    return energy.get_summary(db, get_now_jst().date(), source=source, history_days=days)


@app.get("/api/energy/breakdown")
def get_energy_breakdown(
    days: int = Query(default=energy.DEFAULT_HISTORY_DAYS, ge=1, le=400),
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """ダッシュボードの消費電力カード用。

    エアコン（`aircon`）とスマートプラグ（`tapo:*`）を取得元ごとの行に分けたうえで、
    家全体の今日・今月・先月同日までの合計と、日別の内訳を1度に返す。
    """
    return energy.get_breakdown(db, get_now_jst().date(), history_days=days)


@app.get("/api/energy/hourly")
def get_energy_hourly(
    date: str = Query(...),
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """消費電力カードの詳細パネル「時間ごと」用。指定した1日の時間帯別の内訳を返す。

    時間帯の使用量は `energy_readings`（当日累計の時系列）の差分から出すため、
    このテーブルへ記録し始めた日より前を指定すると `has_data: false` が返る。
    """
    try:
        parsed_date = energy.parse_date(date)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return energy.get_hourly(db, parsed_date)


@app.post("/api/energy/kepco/import")
async def import_kepco_hourly_csv(
    file: UploadFile = File(...),
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """KEPCO「みるでん」からダウンロードした、時間ごとの電力量CSVを取り込む（#302）。

    `kepco_hourly_usage` へ `(date, hour)` で upsert するため、期間が重なる
    CSVを何度取り込んでも二重計上しない。消費電力カードの時間ごとタブは、
    ここで取り込んだ値とエアコン・スマートプラグの実測との差分を「その他」として出す。
    """
    raw = await file.read()
    try:
        records = kepco_import.parse_csv(raw)
    except kepco_import.KepcoCsvError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    if database.DB_MOCK:
        return {"status": "mock_ok", **kepco_import.summarize(records)}

    try:
        result = kepco_import.upsert_kepco_hourly(db, records, now=get_now_jst())
        return {"status": "ok", **result}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e)) from e


def _handle_bambu_events(events: List[Any]) -> None:
    """検出した状態遷移の受け渡し先。**いまはログに出すだけで、Push配信はしない**（#428）。

    AIDE 側（guchi-apps/aide#378）との役割分担が決まったら、ここから
    `notify_events.dispatch_push_event()` へ渡す。
    """
    for event in events:
        logger.info("Bambu event: kind=%s title=%s", event.kind, event.title)


def _apply_bambu_filament_usage(usage: Dict[str, Any], db: Session) -> str:
    """造形の完了・停止で検出した使用量を、使用中のスプールへ引く（#454）。

    **状態の保存はもう済んでいるので、ここで失敗しても収集への応答は成功のまま返す**
    （収集は再送するだけで、在庫の失敗を状態の失敗にすると再送のたびに詰まる）。
    引けなかったときは手入力（既存の使用量の記録）で直せる。
    """
    try:
        result = filament.record_auto_usage(
            usage["grams"],
            usage["job_key"],
            usage["name"],
            db,
            estimated=usage["estimated"],
        )
    except Exception:
        logger.exception("Filament: 造形の使用量を記録できませんでした job=%s", usage["name"])
        return "error"
    logger.info(
        "Filament: 造形の使用量 job=%s grams=%s estimated=%s → %s",
        usage["name"],
        usage["grams"],
        usage["estimated"],
        result,
    )
    return result


@app.post("/api/bambu/state")
def create_bambu_state(
    payload: BambuStatePayload,
    db: Session = Depends(database.get_db),
):
    """Bambu Lab A1 mini の最新の状態を受け取る（サブPCの `bambu_to_myroom.py` から）。

    最新の1件だけを `app_settings` へ上書きする。履歴は持たない。

    **認証は付けていない。** `/api/sensor`・`/api/energy`・`/api/bills` と同じ収集経路の
    扱いで、付けるかどうかは収集経路全体でまとめて判断する（#249）。
    """
    try:
        _, events, usage = bambu.record_state(
            connected=payload.connected,
            report=payload.report,
            last_message_at=payload.last_message_at,
            db=db,
            job_filament=payload.job_filament,
        )
    except Exception as e:
        db.rollback()
        logger.exception("bambu stateの保存に失敗")
        raise HTTPException(status_code=500, detail="internal error") from e

    _handle_bambu_events(events)
    response: Dict[str, Any] = {"status": "ok", "events": [event.kind for event in events]}
    if usage is not None:
        response["filament"] = _apply_bambu_filament_usage(usage, db)
    return response


@app.post("/api/bills")
async def create_utility_bills(
    payload: UtilityBillPayload,
    db: Session = Depends(database.get_db),
):
    """月ごとの確定請求を受け取る（サブPCの `kepco_bill_to_myroom.py` から）。

    同じ (請求月, 種別, 契約) は上書きする。収集側は受信箱に残っているメールを
    毎回そのまま送ってよく、送り直しても件数は増えない。

    **認証は付けていない。** 収集側からのPOST（`/api/sensor`・`/api/aircon`・`/api/energy`）は
    どれも無認証で、ここだけ固定トークンを要求すると収集スクリプトの作りが揃わなくなる。
    `internal_auth` の `INTERNAL_API_KEY` は用途を「読み取り専用の内部API」と定めているので、
    書き込みへ広げるなら その方針ごと決め直す話になる（照明の操作だけは別トークンの
    `INTERNAL_CONTROL_API_KEY` で通す形にした・#419）。付けるかどうかは収集経路全体でまとめて判断する（#249）。
    """
    if database.DB_MOCK:
        return {"status": "mock_ok", "received": len(payload.records)}

    try:
        records = [
            {
                "billing_month": item.billing_month,
                "kind": item.kind,
                "contract_key": item.contract_key,
                "plan_name": item.plan_name,
                "amount_yen": item.amount_yen,
                "usage_value": item.usage_value,
                "usage_unit": item.usage_unit,
                "received_at": item.received_at,
            }
            for item in payload.records
        ]
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    try:
        written = bills.upsert_records(db, records)
        return {"status": "ok", "written": written}
    except ValueError as e:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(e)) from e
    except Exception as e:
        db.rollback()
        logger.exception("billsの保存に失敗")
        raise HTTPException(status_code=500, detail="internal error") from e


@app.get("/api/bills/summary")
def get_bills_summary(
    months: int = Query(default=bills.DEFAULT_HISTORY_MONTHS, ge=1, le=25),
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """電気・ガス料金カード用。最新の請求月・1つ前との比較・月別の推移をまとめて返す。"""
    return bills.get_summary(db, get_now_jst().date(), months=months)


@app.get("/api/aircon/latest")
def get_aircon_latest(
    ac_id: Optional[int] = None,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    if database.DB_MOCK:
        payload = database.generate_mock_aircon_latest(ac_id or 1)
        payload["name"] = aircon_config.get_display_name(
            payload["ac_id"], payload.get("source_name"), db=db
        )
        return payload

    record = _fetch_latest_aircon_record(db, ac_id)
    return _build_aircon_payload(record, db=db)


def _resolve_history_window(
    date: Optional[str] = None,
    range: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
):
    end_time = get_now_jst()
    start_time = end_time - datetime.timedelta(hours=24)
    effective_range = range

    if start and end:
        try:
            start_time = datetime.datetime.fromisoformat(start)
            end_time = datetime.datetime.fromisoformat(end)
            if not range:
                delta = end_time - start_time
                if delta.days > 7:
                    effective_range = "month"
        except ValueError:
            pass
    elif range:
        if range == "day":
            start_time = end_time - datetime.timedelta(days=1)
        elif range == "week":
            start_time = end_time - datetime.timedelta(days=7)
        elif range == "month":
            start_time = end_time - datetime.timedelta(days=30)
        elif range == "year":
            start_time = end_time - datetime.timedelta(days=365)
    elif date:
        try:
            target_date = datetime.datetime.strptime(date, "%Y-%m-%d").date()
            start_time = datetime.datetime.combine(target_date, datetime.time.min)
            end_time = datetime.datetime.combine(target_date, datetime.time.max)
        except ValueError:
            pass

    return start_time, end_time, effective_range


def _get_pressure_offset(device_id: int, db: Optional[Session]) -> float:
    offsets = ui_settings.get_settings(db).get("pressure_offsets", {})
    try:
        return float(offsets.get(str(device_id), 0) or 0)
    except (TypeError, ValueError):
        return 0.0


def _normalize_pressure_hpa(pressure: Optional[int], offset: float = 0.0) -> Optional[float]:
    if pressure is None:
        return None
    base = pressure / 100.0 if pressure > 5000 else float(pressure)
    return round(base + offset, 1)


def _format_record_row(record: database.SensorRecord, offset: float = 0.0) -> dict:
    return {
        "datetime": record.datetime.strftime("%Y-%m-%d %H:%M:%S"),
        "device_id": record.device_id,
        "temperature": record.temperature,
        "temperature_dht11": record.temperature_dht11,
        "humidity": record.humidity,
        "pressure": _normalize_pressure_hpa(record.pressure, offset),
        "co2": record.co2,
        "illuminance": record.illuminance,
    }


def _parse_record_datetime(value: str) -> datetime.datetime:
    try:
        return datetime.datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return datetime.datetime.fromisoformat(value)


@app.get("/api/records")
def get_sensor_records(
    device: int = 1,
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    if device < 1:
        raise HTTPException(status_code=400, detail="device id must be >= 1")
    if limit < 1 or limit > 500:
        limit = 100
    if offset < 0:
        offset = 0

    end_time = get_now_jst()
    use_date_filter = bool(start and end)
    if use_date_filter:
        try:
            start_time = _parse_record_datetime(start)
            end_time = _parse_record_datetime(end)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid start or end datetime") from exc
    else:
        start_time = end_time - datetime.timedelta(days=365)

    if database.DB_MOCK:
        rows = database.generate_mock_history_for_range(start_time, end_time, device)
        rows.sort(key=lambda item: item["datetime"], reverse=True)
        total = len(rows)
        page = rows[offset : offset + limit]
        pressure_offset = _get_pressure_offset(device, db)
        records = [
            {
                "datetime": row["datetime"].strftime("%Y-%m-%d %H:%M:%S"),
                "device_id": device,
                "temperature": row.get("temperature"),
                "temperature_dht11": row.get("temperature_dht11"),
                "humidity": row.get("humidity"),
                "pressure": _normalize_pressure_hpa(row.get("pressure"), pressure_offset),
                "co2": row.get("co2"),
                "illuminance": row.get("illuminance"),
            }
            for row in page
        ]
        return {"records": records, "total": total, "limit": limit, "offset": offset}

    filters = [database.SensorRecord.device_id == device]
    if use_date_filter:
        filters.extend(
            [
                database.SensorRecord.datetime >= start_time,
                database.SensorRecord.datetime <= end_time,
            ]
        )

    total = db.query(database.SensorRecord).filter(*filters).count()
    rows = (
        db.query(database.SensorRecord)
        .filter(*filters)
        .order_by(database.SensorRecord.datetime.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    pressure_offset = _get_pressure_offset(device, db)
    return {
        "records": [_format_record_row(row, pressure_offset) for row in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@app.delete("/api/records")
def delete_sensor_record(
    device: int,
    datetime_value: str = Query(..., alias="datetime"),
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    if device < 1:
        raise HTTPException(status_code=400, detail="device id must be >= 1")
    try:
        dt = _parse_record_datetime(datetime_value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="invalid datetime") from exc

    if database.DB_MOCK:
        return {"status": "mock_ok", "deleted": True}

    deleted = (
        db.query(database.SensorRecord)
        .filter(
            database.SensorRecord.device_id == device,
            database.SensorRecord.datetime == dt,
        )
        .delete(synchronize_session=False)
    )
    if deleted == 0:
        raise HTTPException(status_code=404, detail="record not found")
    db.commit()
    return {"status": "ok", "deleted": True}


@app.post("/api/records/bulk-delete")
def bulk_delete_sensor_records(
    body: BulkDeleteRecordsRequest,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    if body.device < 1:
        raise HTTPException(status_code=400, detail="device id must be >= 1")
    if not body.datetimes:
        raise HTTPException(status_code=400, detail="datetimes must not be empty")
    if len(body.datetimes) > 500:
        raise HTTPException(status_code=400, detail="too many datetimes (max 500)")

    parsed_datetimes = []
    for value in body.datetimes:
        try:
            parsed_datetimes.append(_parse_record_datetime(value))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"invalid datetime: {value}") from exc

    if database.DB_MOCK:
        return {"status": "mock_ok", "deleted_count": len(parsed_datetimes)}

    deleted = (
        db.query(database.SensorRecord)
        .filter(
            database.SensorRecord.device_id == body.device,
            database.SensorRecord.datetime.in_(parsed_datetimes),
        )
        .delete(synchronize_session=False)
    )
    db.commit()
    return {"status": "ok", "deleted_count": deleted}


@app.get("/api/history")
def get_history(
    date: Optional[str] = None,
    range: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    device: int = 1,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    start_time, end_time, effective_range = _resolve_history_window(date, range, start, end)

    if database.DB_MOCK:
        records_raw = database.generate_mock_history_for_range(start_time, end_time, device)
    else:
        records_raw_unformatted = db.query(database.SensorRecord).filter(
            database.SensorRecord.datetime >= start_time,
            database.SensorRecord.datetime <= end_time,
            database.SensorRecord.device_id == device
        ).order_by(database.SensorRecord.datetime.asc()).all()
        # Convert SQLAlchemy objects to dicts
        records_raw = []
        for r in records_raw_unformatted:
            records_raw.append({
                "datetime": r.datetime,
                "temperature": r.temperature,
                "temperature_dht11": r.temperature_dht11,
                "humidity": r.humidity,
                "pressure": r.pressure,
                "co2": r.co2,
                "illuminance": r.illuminance,
            })

    pressure_offset = _get_pressure_offset(device, db)
    for rec in records_raw:
        if rec.get("pressure") is not None:
            rec["pressure"] = _normalize_pressure_hpa(rec["pressure"], pressure_offset)

    # Fetch outdoor history
    outdoor_map = _build_outdoor_map(start_time, end_time, db)

    # 日次集計は年表示のみ。月以下は生データ（10分間隔等）を返す
    if effective_range == 'year':
        daily_map = {}
        for d in records_raw:
            date_str = d['datetime'].strftime('%Y-%m-%d')
            if date_str not in daily_map:
                daily_map[date_str] = {'temps': [], 'humids': [], 'pressures': [], 'co2s': [], 'illuminances': []}
            if d['temperature'] is not None: daily_map[date_str]['temps'].append(d['temperature'])
            if d['humidity'] is not None: daily_map[date_str]['humids'].append(d['humidity'])
            if d.get('pressure') is not None: daily_map[date_str]['pressures'].append(d['pressure'])
            if d.get('co2') is not None: daily_map[date_str]['co2s'].append(d['co2'])
            if d.get('illuminance') is not None: daily_map[date_str]['illuminances'].append(d['illuminance'])
        
        aggregated = []
        for date_str, values in daily_map.items():
            if not any([values['temps'], values['humids'], values['pressures'], values['co2s'], values['illuminances']]):
                continue
            # 日次ポイントは正午を代表時刻とする（0:00固定だとグラフ上すべて深夜に見える）
            dt = datetime.datetime.strptime(date_str, '%Y-%m-%d').replace(hour=12)
            
            out_target = dt
            out_data = outdoor_map.get(out_target, {})

            entry = {
                "datetime": dt,
                "outdoor_temperature": out_data.get("temp"),
                "outdoor_humidity": out_data.get("humid"),
                "outdoor_pressure": out_data.get("press"),
            }

            if values['temps']:
                entry.update({
                    "temperature": round(sum(values['temps']) / len(values['temps']), 1),
                    "temperature_min": min(values['temps']),
                    "temperature_max": max(values['temps']),
                })
            if values['humids']:
                entry.update({
                    "humidity": round(sum(values['humids']) / len(values['humids']), 1),
                    "humidity_min": min(values['humids']),
                    "humidity_max": max(values['humids']),
                })
            if values['pressures']:
                entry.update({
                    "pressure": round(sum(values['pressures']) / len(values['pressures']), 1),
                    "pressure_min": min(values['pressures']),
                    "pressure_max": max(values['pressures']),
                })
            if values['co2s']:
                entry.update({
                    "co2": round(sum(values['co2s']) / len(values['co2s'])),
                    "co2_min": min(values['co2s']),
                    "co2_max": max(values['co2s']),
                })
            if values['illuminances']:
                entry.update({
                    "illuminance": round(sum(values['illuminances']) / len(values['illuminances']), 1),
                    "illuminance_min": min(values['illuminances']),
                    "illuminance_max": max(values['illuminances']),
                })

            aggregated.append(entry)
        aggregated.sort(key=lambda x: x['datetime'])
        if not aggregated:
            return _outdoor_only_year_records(outdoor_map, start_time, end_time)
        return aggregated

    # For day/week, return all records with merged outdoor data
    formatted_records = []
    
    def get_outdoor(dt):
        dt_naive = dt.replace(tzinfo=None)
        if dt_naive.minute >= 30:
             hour_dt = dt_naive + datetime.timedelta(minutes=60-dt_naive.minute, seconds=-dt_naive.second)
        else:
             hour_dt = dt_naive - datetime.timedelta(minutes=dt_naive.minute, seconds=dt_naive.second)
        hour_dt = hour_dt.replace(microsecond=0)
        return outdoor_map.get(hour_dt, {})

    for r in records_raw:
        out_data = get_outdoor(r['datetime'])
        formatted_records.append({
            "datetime": r['datetime'],
            "temperature": r.get('temperature'),
            "temperature_dht11": r.get('temperature_dht11'),
            "humidity": r.get('humidity'),
            "pressure": r.get('pressure'),
            "co2": r.get('co2'),
            "illuminance": r.get('illuminance'),
            "outdoor_temperature": out_data.get("temp"),
            "outdoor_humidity": out_data.get("humid"),
            "outdoor_pressure": out_data.get("press")
        })
        
    formatted_records.sort(key=lambda x: x['datetime'])
    if not formatted_records:
        return _outdoor_only_day_records(outdoor_map, start_time, end_time)
    return formatted_records


@app.get("/api/light-sources")
def get_light_source_candidates(
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """`/devices` の「この場所の照明」に並べる候補（#368）。

    **Nature Remo は叩かない。** 最後に取得した候補一覧（`remote_catalog`）から読むだけで、
    取り直すのは「電気の操作」の編集画面の「読み込み直す」（`POST /api/remote/catalog/refresh`）。
    一度も取得していなければ空で返し、画面がそちらへ案内する。
    """
    return {
        "candidates": remote.light_appliance_candidates(db),
        "catalog_fetched_at": remote.load_catalog(db).get("fetched_at") or "",
    }


def _light_history_records(
    device: int,
    start_time: datetime.datetime,
    end_time: datetime.datetime,
    db: Session,
) -> List[Dict[str, Any]]:
    """照度からの判定に使う記録。**窓の手前も少し読む**（先頭ですでに点いていたかを知るため）。"""
    lookback = start_time - datetime.timedelta(minutes=light_history.LOOKBACK_MINUTES)
    if database.DB_MOCK:
        return database.generate_mock_history_for_range(lookback, end_time, device)

    rows = (
        db.query(database.SensorRecord)
        .filter(
            database.SensorRecord.datetime >= lookback,
            database.SensorRecord.datetime <= end_time,
            database.SensorRecord.device_id == device,
        )
        .order_by(database.SensorRecord.datetime.asc())
        .all()
    )
    return [{"datetime": row.datetime, "illuminance": row.illuminance} for row in rows]


def _light_history_events(
    appliance_key: str,
    start_time: datetime.datetime,
    end_time: datetime.datetime,
    db: Session,
) -> List[tuple]:
    """窓のあいだの記録と、**窓の手前で最後に記録された1件**（#371）。

    `light_events` は状態が変わったときだけ1行足す追記専用のテーブルなので、窓の先頭で
    すでに点いていたかは手前の1件を見ないと分からない。**だからといって下限なしで全件を
    引かない**——照度からの判定（`_light_history_records`）が `LOOKBACK_MINUTES` で下限を
    絞っているのと同じで、絞らないと運用が長くなるほど読む行が増え続ける。
    """
    if database.DB_MOCK:
        return database.generate_mock_light_events(start_time, end_time)

    base = db.query(database.LightEventRecord).filter(
        database.LightEventRecord.appliance_key == appliance_key
    )
    previous = (
        base.filter(database.LightEventRecord.recorded_at < start_time)
        .order_by(database.LightEventRecord.recorded_at.desc())
        .first()
    )
    rows = (
        base.filter(
            database.LightEventRecord.recorded_at >= start_time,
            database.LightEventRecord.recorded_at <= end_time,
        )
        .order_by(database.LightEventRecord.recorded_at.asc())
        .all()
    )
    if previous is not None:
        rows = [previous, *rows]
    return [(row.recorded_at, row.power) for row in rows]


@app.get("/api/light-history")
def get_light_history(
    device: int = 1,
    date: Optional[str] = None,
    range: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    """その場所の照明が点いていた時間帯（#368）。

    窓の指定は `/api/history` と同じ形にしてある。推移グラフと同じ時間軸へ帯を重ねるため、
    呼び出し側が同じ引数を使い回せるようにするのが狙い。

    **紐付けていない場所には `source: null` を返す**（空の履歴とは区別する）。画面は
    この場合だけ帯そのものを描かない。
    """
    start_time, end_time, _effective_range = _resolve_history_window(date, range, start, end)
    settings = ui_settings.get_settings(db)
    source = (settings.get(ui_settings.SETTING_LIGHT_SOURCES) or {}).get(str(device))

    empty = {
        "device_id": device,
        "start": start_time.isoformat(),
        "end": end_time.isoformat(),
        "source": None,
        "segments": [],
        "events": [],
        "summary": {"on_count": 0, "on_minutes": 0},
    }
    if not isinstance(source, dict):
        return empty

    kind = source.get("kind")
    if kind == ui_settings.LIGHT_SOURCE_ILLUMINANCE:
        thresholds = settings.get(ui_settings.SETTING_LIGHT_THRESHOLDS) or {}
        try:
            threshold = float(thresholds.get(str(device)) or 0)
        except (TypeError, ValueError):
            threshold = 0.0
        # しきい値を設定していなければ判定そのものができない。画面はそのまま案内を出す
        if threshold <= 0:
            empty["source"] = {"kind": kind, "name": "", "threshold": None}
            return empty
        segments = light_history.segments_from_illuminance(
            _light_history_records(device, start_time, end_time, db),
            threshold,
            start_time,
            end_time,
        )
        source_payload = {"kind": kind, "name": "", "threshold": threshold}
        daylight_flags = True
    elif kind == ui_settings.LIGHT_SOURCE_REMO:
        appliance_key = str(source.get("appliance_key") or "")
        name = next(
            (
                candidate["name"]
                for candidate in remote.light_appliance_candidates(db)
                if candidate["key"] == appliance_key
            ),
            "",
        )
        rows = _light_history_events(appliance_key, start_time, end_time, db)
        # 窓の手前で最後に記録された状態が「窓の先頭ですでに点いていたか」を決める
        initial_status = next(
            (power for at, power in reversed(rows) if at < start_time), None
        )
        segments = light_history.segments_from_events(
            [(at, power) for at, power in rows if start_time <= at <= end_time],
            start_time,
            end_time,
            initial_status,
        )
        source_payload = {"kind": kind, "name": name, "threshold": None}
        daylight_flags = False
    else:
        return empty

    return {
        "device_id": device,
        "start": start_time.isoformat(),
        "end": end_time.isoformat(),
        "source": source_payload,
        "segments": [
            light_history.segment_payload(segment, daylight_flags) for segment in segments
        ],
        "events": light_history.build_events(segments, start_time, end_time, daylight_flags),
        "summary": light_history.summarize(segments),
    }


@app.get("/api/aircon/history")
def get_aircon_history(
    date: Optional[str] = None,
    range: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    ac_id: Optional[int] = None,
    db: Session = Depends(database.get_db),
    _: dict = Depends(get_current_user),
):
    start_time, end_time, effective_range = _resolve_history_window(date, range, start, end)

    if database.DB_MOCK:
        records_raw = database.generate_mock_aircon_history_for_range(
            start_time, end_time, ac_id or 1
        )
    else:
        query = db.query(database.AirconRecord).filter(
            database.AirconRecord.datetime >= start_time,
            database.AirconRecord.datetime <= end_time,
        )
        if ac_id is not None:
            query = query.filter(database.AirconRecord.ac_id == ac_id)
        records_raw = []
        for record in query.order_by(database.AirconRecord.datetime.asc()).all():
            records_raw.append(
                {
                    "datetime": record.datetime,
                    "ac_id": record.ac_id,
                    "room_temperature": record.room_temperature,
                    "target_temperature": record.target_temperature,
                    "power": record.power,
                }
            )

    if effective_range == "year":
        daily_map = {}
        for row in records_raw:
            date_str = row["datetime"].strftime("%Y-%m-%d")
            if date_str not in daily_map:
                daily_map[date_str] = {"room_temps": [], "target_temps": []}
            if row.get("room_temperature") is not None:
                daily_map[date_str]["room_temps"].append(row["room_temperature"])
            # 自動運転のシフト量は絶対温度と平均できないため、年グラフからは外す
            if (
                row.get("target_temperature") is not None
                and not _is_aircon_auto_target(row.get("target_temperature"))
                and row.get("power") is not None
                and str(row.get("power")).upper() != "OFF"
            ):
                daily_map[date_str]["target_temps"].append(row["target_temperature"])

        aggregated = []
        for date_str, values in daily_map.items():
            if not values["room_temps"] and not values["target_temps"]:
                continue
            dt = datetime.datetime.strptime(date_str, "%Y-%m-%d").replace(hour=12)
            entry = {"datetime": dt}
            if values["room_temps"]:
                entry.update(
                    {
                        "temperature": round(
                            sum(values["room_temps"]) / len(values["room_temps"]), 1
                        ),
                        "temperature_min": min(values["room_temps"]),
                        "temperature_max": max(values["room_temps"]),
                    }
                )
            if values["target_temps"]:
                entry["target_temperature"] = round(
                    sum(values["target_temps"]) / len(values["target_temps"]), 1
                )
            aggregated.append(entry)
        aggregated.sort(key=lambda x: x["datetime"])
        return aggregated

    formatted_records = []
    for row in records_raw:
        power = row.get("power")
        formatted_records.append(
            {
                "datetime": row["datetime"],
                "temperature": row.get("room_temperature"),
                "target_temperature": (
                    row.get("target_temperature")
                    if row.get("power") is None
                    or str(row.get("power")).upper() != "OFF"
                    else None
                ),
                "power": power,
            }
        )

    formatted_records.sort(key=lambda x: x["datetime"])
    return formatted_records

def _resolve_within_directory(base_dir: str, relative_path: str) -> Optional[str]:
    """`relative_path` を `base_dir` 配下に解決できたときだけそのパスを返す（#376）。

    `relative_path` が `/` 始まりだと `os.path.join` が `base_dir` 側を捨てて配下外の
    絶対パスになり、`../` を含む相対パスも配下外へ抜けられる。`os.path.realpath` で
    シンボリックリンクや `..` を解決したうえで配下かどうかを確認する。
    """
    base_real = os.path.realpath(base_dir)
    candidate = os.path.realpath(os.path.join(base_dir, relative_path))
    if os.path.commonpath([base_real, candidate]) != base_real:
        return None
    return candidate


# Serve Next.js static export (frontend/out)
frontend_dist = os.path.join(os.path.dirname(__file__), "../frontend/out")

if os.path.exists(frontend_dist):
    next_static = os.path.join(frontend_dist, "_next")
    if os.path.isdir(next_static):
        app.mount("/_next", StaticFiles(directory=next_static), name="next_static")

    def _resolve_static_path(full_path: str) -> Optional[str]:
        return _resolve_within_directory(frontend_dist, full_path)

    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"])
    async def serve_frontend(full_path: str):
        if full_path.startswith("api/") or full_path.startswith("docs") or full_path.startswith("openapi.json"):
            raise HTTPException(status_code=404, detail="Not Found")

        requested_file = _resolve_static_path(full_path)
        if requested_file and os.path.isfile(requested_file):
            return FileResponse(requested_file)

        # Next.jsの静的エクスポートは "/auth/callback" のようなクリーンURLを
        # "auth/callback.html" として出力するため、拡張子付きでも解決を試みる。
        if requested_file:
            html_file = f"{requested_file}.html"
            if os.path.isfile(html_file):
                return FileResponse(html_file)

        return FileResponse(os.path.join(frontend_dist, "index.html"))
