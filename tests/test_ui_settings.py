from backend import ui_settings


def test_ui_settings_save_and_load(data_dir):
    saved = ui_settings.save_settings(
        {
            ui_settings.SETTING_DISPLAY_ORDER: ["device:2", "device:1", "outdoor", "aircon"],
            ui_settings.SETTING_HIDDEN_DEVICES: ["device:2"],
            ui_settings.SETTING_CHART_COLORS: {"device:1": "#3498db"},
        }
    )
    assert saved["display_order"][0] == "device:2"
    assert "device:2" in saved["hidden_devices"]

    loaded = ui_settings.get_settings()
    assert loaded["display_order"][0] == "device:2"
    assert loaded["chart_colors"]["device:1"] == "#3498db"


def test_remote_buttons_default_is_empty(data_dir):
    assert ui_settings.get_settings()[ui_settings.SETTING_REMOTE_BUTTONS] == {}


def test_remote_buttons_save_and_load(data_dir):
    saved = ui_settings.save_settings(
        {
            ui_settings.SETTING_REMOTE_BUTTONS: {
                "light-on": {"label": "あかりをつける"},
                "tv-vol-up": {"hidden": True},
            }
        }
    )
    assert saved[ui_settings.SETTING_REMOTE_BUTTONS] == {
        "light-on": {"label": "あかりをつける"},
        "tv-vol-up": {"hidden": True},
    }
    assert ui_settings.get_settings()[ui_settings.SETTING_REMOTE_BUTTONS][
        "light-on"
    ] == {"label": "あかりをつける"}


def test_remote_buttons_drop_entries_that_match_the_default(data_dir):
    """名前が空でダッシュボードにも出すなら remote.json のままなので持たない。"""
    saved = ui_settings.save_settings(
        {
            ui_settings.SETTING_REMOTE_BUTTONS: {
                "light-on": {"label": "  ", "hidden": False},
                "light-off": {},
            }
        }
    )
    assert saved[ui_settings.SETTING_REMOTE_BUTTONS] == {}


def test_remote_buttons_reject_broken_entries(data_dir):
    saved = ui_settings.save_settings(
        {
            ui_settings.SETTING_REMOTE_BUTTONS: {
                "": {"label": "IDが空"},
                "ok": {"label": "残る"},
                "broken": "辞書ではない",
            }
        }
    )
    assert saved[ui_settings.SETTING_REMOTE_BUTTONS] == {"ok": {"label": "残る"}}


def test_remote_buttons_label_is_trimmed_to_the_max_length(data_dir):
    saved = ui_settings.save_settings(
        {ui_settings.SETTING_REMOTE_BUTTONS: {"light-on": {"label": "あ" * 40}}}
    )
    label = saved[ui_settings.SETTING_REMOTE_BUTTONS]["light-on"]["label"]
    assert len(label) == ui_settings.MAX_REMOTE_LABEL_LENGTH


def test_remote_buttons_keep_the_default_label_that_was_saved(data_dir):
    """IDのずれを見つける手掛かりなので、保存時の元の名前も残す。"""
    saved = ui_settings.save_settings(
        {
            ui_settings.SETTING_REMOTE_BUTTONS: {
                "light-on": {"label": "あかりをつける", "default_label": "点ける"}
            }
        }
    )
    assert saved[ui_settings.SETTING_REMOTE_BUTTONS]["light-on"] == {
        "label": "あかりをつける",
        "default_label": "点ける",
    }


def test_remote_buttons_default_label_alone_is_not_kept(data_dir):
    """名前も付けず表示もしているなら、控えだけ残しても意味が無い。"""
    saved = ui_settings.save_settings(
        {ui_settings.SETTING_REMOTE_BUTTONS: {"light-on": {"default_label": "点ける"}}}
    )
    assert saved[ui_settings.SETTING_REMOTE_BUTTONS] == {}


def test_saving_other_settings_keeps_remote_buttons(data_dir):
    ui_settings.save_settings(
        {ui_settings.SETTING_REMOTE_BUTTONS: {"light-on": {"label": "あかり"}}}
    )
    saved = ui_settings.save_settings({ui_settings.SETTING_HIDDEN_DEVICES: ["device:2"]})
    assert saved[ui_settings.SETTING_REMOTE_BUTTONS] == {"light-on": {"label": "あかり"}}


def test_life_card_order_default_is_empty(data_dir):
    """まだ並べ替えていない状態。既定の並びはフロント側の LIFE_CARDS が持つ（#283）"""
    assert ui_settings.get_settings()[ui_settings.SETTING_LIFE_CARD_ORDER] == []


def test_life_card_order_save_and_load(data_dir):
    saved = ui_settings.save_settings(
        {ui_settings.SETTING_LIFE_CARD_ORDER: ["garbage", "remote", "electricity"]}
    )
    assert saved[ui_settings.SETTING_LIFE_CARD_ORDER] == ["garbage", "remote", "electricity"]
    assert ui_settings.get_settings()[ui_settings.SETTING_LIFE_CARD_ORDER] == [
        "garbage",
        "remote",
        "electricity",
    ]


def test_life_card_order_drops_duplicates_and_broken_entries(data_dir):
    saved = ui_settings.save_settings(
        {ui_settings.SETTING_LIFE_CARD_ORDER: ["garbage", " garbage ", "", 3, None, "remote"]}
    )
    assert saved[ui_settings.SETTING_LIFE_CARD_ORDER] == ["garbage", "remote"]


def test_saving_other_settings_keeps_life_card_order(data_dir):
    """save_settings の merged に並べたキーだけが引き継がれるため、別の設定の保存で確かめる"""
    ui_settings.save_settings(
        {ui_settings.SETTING_LIFE_CARD_ORDER: ["garbage", "remote"]}
    )
    saved = ui_settings.save_settings({ui_settings.SETTING_HIDDEN_DEVICES: ["device:2"]})
    assert saved[ui_settings.SETTING_LIFE_CARD_ORDER] == ["garbage", "remote"]

    loaded = ui_settings.get_settings()
    assert loaded[ui_settings.SETTING_LIFE_CARD_ORDER] == ["garbage", "remote"]


# --- 通知設定（#293） -----------------------------------------------------------


def test_notification_settings_defaults(data_dir):
    settings = ui_settings.get_settings()
    assert settings[ui_settings.SETTING_GARBAGE_NOTIFY_ENABLED] is True
    assert settings[ui_settings.SETTING_GARBAGE_NOTIFY_TIME] is None
    assert settings[ui_settings.SETTING_ROOM_ANOMALY_NOTIFY_ENABLED] is False
    assert settings[ui_settings.SETTING_ROOM_ANOMALY_THRESHOLDS] == {
        "temperature": {"min": 16.0, "max": 30.0},
        "humidity": {"min": 30.0, "max": 70.0},
    }
    assert settings[ui_settings.SETTING_ROOM_ANOMALY_REMINDER_MINUTES] == 60


def test_garbage_notify_time_is_normalized(data_dir):
    saved = ui_settings.save_settings({ui_settings.SETTING_GARBAGE_NOTIFY_TIME: "9:5"})
    assert saved[ui_settings.SETTING_GARBAGE_NOTIFY_TIME] == "09:05"

    saved = ui_settings.save_settings({ui_settings.SETTING_GARBAGE_NOTIFY_TIME: "not-a-time"})
    assert saved[ui_settings.SETTING_GARBAGE_NOTIFY_TIME] is None


def test_room_anomaly_thresholds_reject_min_greater_than_max(data_dir):
    saved = ui_settings.save_settings(
        {
            ui_settings.SETTING_ROOM_ANOMALY_THRESHOLDS: {
                "temperature": {"min": 30.0, "max": 16.0},
                "humidity": {"min": 40.0, "max": 60.0},
            }
        }
    )
    # 不正な指標だけ既定へ戻し、他方は保存された値を保つ
    assert saved[ui_settings.SETTING_ROOM_ANOMALY_THRESHOLDS]["temperature"] == {
        "min": 16.0,
        "max": 30.0,
    }
    assert saved[ui_settings.SETTING_ROOM_ANOMALY_THRESHOLDS]["humidity"] == {
        "min": 40.0,
        "max": 60.0,
    }


def test_room_anomaly_reminder_minutes_is_clamped(data_dir):
    saved = ui_settings.save_settings({ui_settings.SETTING_ROOM_ANOMALY_REMINDER_MINUTES: 0})
    assert saved[ui_settings.SETTING_ROOM_ANOMALY_REMINDER_MINUTES] == (
        ui_settings.MIN_ROOM_ANOMALY_REMINDER_MINUTES
    )

    saved = ui_settings.save_settings(
        {ui_settings.SETTING_ROOM_ANOMALY_REMINDER_MINUTES: 999999}
    )
    assert saved[ui_settings.SETTING_ROOM_ANOMALY_REMINDER_MINUTES] == (
        ui_settings.MAX_ROOM_ANOMALY_REMINDER_MINUTES
    )


def test_saving_other_settings_keeps_notification_settings(data_dir):
    """save_settings の merged に並べたキーだけが引き継がれるため、別の設定の保存で確かめる（#258と同種の抜け対策）"""
    ui_settings.save_settings(
        {
            ui_settings.SETTING_GARBAGE_NOTIFY_ENABLED: False,
            ui_settings.SETTING_GARBAGE_NOTIFY_TIME: "07:30",
            ui_settings.SETTING_ROOM_ANOMALY_NOTIFY_ENABLED: True,
            ui_settings.SETTING_ROOM_ANOMALY_REMINDER_MINUTES: 30,
        }
    )
    saved = ui_settings.save_settings({ui_settings.SETTING_HIDDEN_DEVICES: ["device:2"]})
    assert saved[ui_settings.SETTING_GARBAGE_NOTIFY_ENABLED] is False
    assert saved[ui_settings.SETTING_GARBAGE_NOTIFY_TIME] == "07:30"
    assert saved[ui_settings.SETTING_ROOM_ANOMALY_NOTIFY_ENABLED] is True
    assert saved[ui_settings.SETTING_ROOM_ANOMALY_REMINDER_MINUTES] == 30

    loaded = ui_settings.get_settings()
    assert loaded[ui_settings.SETTING_GARBAGE_NOTIFY_ENABLED] is False
    assert loaded[ui_settings.SETTING_GARBAGE_NOTIFY_TIME] == "07:30"


# --- ゴミの日の前日/当日・品目ごとのタイミング（#347） ----------------------------


def test_garbage_notify_same_day_defaults(data_dir):
    settings = ui_settings.get_settings()
    assert settings[ui_settings.SETTING_GARBAGE_NOTIFY_SAME_DAY_ENABLED] is False
    assert settings[ui_settings.SETTING_GARBAGE_NOTIFY_SAME_DAY_TIME] is None
    assert settings[ui_settings.SETTING_GARBAGE_NOTIFY_CATEGORY_TIMING] == {}


def test_garbage_notify_same_day_time_is_normalized(data_dir):
    saved = ui_settings.save_settings(
        {ui_settings.SETTING_GARBAGE_NOTIFY_SAME_DAY_TIME: "7:5"}
    )
    assert saved[ui_settings.SETTING_GARBAGE_NOTIFY_SAME_DAY_TIME] == "07:05"

    saved = ui_settings.save_settings(
        {ui_settings.SETTING_GARBAGE_NOTIFY_SAME_DAY_TIME: "not-a-time"}
    )
    assert saved[ui_settings.SETTING_GARBAGE_NOTIFY_SAME_DAY_TIME] is None


def test_garbage_notify_category_timing_normalizes(data_dir):
    saved = ui_settings.save_settings(
        {
            ui_settings.SETTING_GARBAGE_NOTIFY_CATEGORY_TIMING: {
                # 既定（前日のみ）と同じ内容は「未指定」と区別が付かないので保存されない
                "burnable": ["before"],
                # 前日・当日の両方を選べる
                "bulky": ["before", "same_day"],
                # 当日だけ
                "recyclable": ["same_day"],
                # 前日・当日どちらも外す（通知しない）は既定と異なるので保存される
                "incombustible": [],
                # 不正なタイミング文字列だけの配列は、無効な値を取り除いた結果として空配列になる
                # （＝そのまま「どちらも通知しない」扱い。実害はないが正しく直感的な結果になる）
                "broken": ["invalid"],
                # キー・値の型が違うものは捨てる
                123: ["before"],
                "not-a-list": "same_day",
            }
        }
    )
    timing = saved[ui_settings.SETTING_GARBAGE_NOTIFY_CATEGORY_TIMING]
    assert "burnable" not in timing
    assert timing["bulky"] == ["before", "same_day"]
    assert timing["recyclable"] == ["same_day"]
    assert timing["incombustible"] == []
    assert timing["broken"] == []
    assert 123 not in timing
    assert "not-a-list" not in timing


def test_saving_other_settings_keeps_garbage_same_day_settings(data_dir):
    """save_settings の merged に並べたキーだけが引き継がれるため、別の設定の保存で確かめる（#258と同種の抜け対策）"""
    ui_settings.save_settings(
        {
            ui_settings.SETTING_GARBAGE_NOTIFY_SAME_DAY_ENABLED: True,
            ui_settings.SETTING_GARBAGE_NOTIFY_SAME_DAY_TIME: "07:00",
            ui_settings.SETTING_GARBAGE_NOTIFY_CATEGORY_TIMING: {
                "bulky": ["before", "same_day"]
            },
        }
    )
    saved = ui_settings.save_settings({ui_settings.SETTING_HIDDEN_DEVICES: ["device:2"]})
    assert saved[ui_settings.SETTING_GARBAGE_NOTIFY_SAME_DAY_ENABLED] is True
    assert saved[ui_settings.SETTING_GARBAGE_NOTIFY_SAME_DAY_TIME] == "07:00"
    assert saved[ui_settings.SETTING_GARBAGE_NOTIFY_CATEGORY_TIMING] == {
        "bulky": ["before", "same_day"]
    }

    loaded = ui_settings.get_settings()
    assert loaded[ui_settings.SETTING_GARBAGE_NOTIFY_SAME_DAY_ENABLED] is True
    assert loaded[ui_settings.SETTING_GARBAGE_NOTIFY_CATEGORY_TIMING] == {
        "bulky": ["before", "same_day"]
    }


def test_energy_source_names_default_is_empty(data_dir):
    assert ui_settings.get_settings()[ui_settings.SETTING_ENERGY_SOURCE_NAMES] == {}


def test_energy_source_names_save_and_load(data_dir):
    saved = ui_settings.save_settings(
        {
            ui_settings.SETTING_ENERGY_SOURCE_NAMES: {
                "tapo:冷蔵庫": "キッチンの冷蔵庫",
                # 空文字は「上書きなし」。キーごと落とす
                "tapo:テレビ": "  ",
                # 長すぎる名前は入り口で切る
                "tapo:デスク": "あ" * 30,
            }
        }
    )
    names = saved[ui_settings.SETTING_ENERGY_SOURCE_NAMES]
    assert names["tapo:冷蔵庫"] == "キッチンの冷蔵庫"
    assert "tapo:テレビ" not in names
    assert names["tapo:デスク"] == "あ" * ui_settings.MAX_ENERGY_SOURCE_NAME_LENGTH

    loaded = ui_settings.get_settings()
    assert loaded[ui_settings.SETTING_ENERGY_SOURCE_NAMES]["tapo:冷蔵庫"] == "キッチンの冷蔵庫"


def test_saving_other_settings_keeps_energy_source_names(data_dir):
    """save_settings の merged に並べたキーだけが引き継がれる（#258と同種の抜け対策・#335）"""
    ui_settings.save_settings(
        {ui_settings.SETTING_ENERGY_SOURCE_NAMES: {"tapo:冷蔵庫": "キッチンの冷蔵庫"}}
    )
    saved = ui_settings.save_settings({ui_settings.SETTING_HIDDEN_DEVICES: ["device:2"]})
    assert saved[ui_settings.SETTING_ENERGY_SOURCE_NAMES] == {"tapo:冷蔵庫": "キッチンの冷蔵庫"}

    loaded = ui_settings.get_settings()
    assert loaded[ui_settings.SETTING_ENERGY_SOURCE_NAMES] == {"tapo:冷蔵庫": "キッチンの冷蔵庫"}


def test_room_layout_default_is_empty(data_dir):
    """まだ一度も保存していない状態。既定の紐付けはフロント側が補う（#399）。"""
    assert ui_settings.get_settings()[ui_settings.SETTING_ROOM_LAYOUT] == {"zones": []}


def test_room_layout_save_and_load(data_dir):
    saved = ui_settings.save_settings(
        {
            ui_settings.SETTING_ROOM_LAYOUT: {
                "zones": [
                    {
                        "key": "ldk",
                        "device_id": 1,
                        "ac_id": 1,
                        "tapo_sources": ["tapo:冷蔵庫", "tapo:冷蔵庫"],
                    },
                    {
                        "key": "bath",
                        "device_id": None,
                        "ac_id": None,
                        "tapo_sources": [],
                    },
                ]
            }
        }
    )
    assert saved[ui_settings.SETTING_ROOM_LAYOUT] == {
        "zones": [
            {
                "key": "ldk",
                "device_id": 1,
                "ac_id": 1,
                "tapo_sources": ["tapo:冷蔵庫"],
            },
            {
                "key": "bath",
                "device_id": None,
                "ac_id": None,
                "tapo_sources": [],
            },
        ]
    }

    loaded = ui_settings.get_settings()[ui_settings.SETTING_ROOM_LAYOUT]
    assert loaded["zones"][0]["device_id"] == 1
    assert loaded["zones"][0]["tapo_sources"] == ["tapo:冷蔵庫"]


def test_room_layout_rejects_broken_entries(data_dir):
    """キーが空・読めないID・文字列でないプラグの`source`は落とす。ゾーンの実在チェックはしない。"""
    saved = ui_settings.save_settings(
        {
            ui_settings.SETTING_ROOM_LAYOUT: {
                "zones": [
                    {"key": "", "device_id": 1},
                    "文字列",
                    {
                        "key": "ldk",
                        "device_id": "abc",
                        "ac_id": -1,
                        "tapo_sources": [1, "tapo:冷蔵庫"],
                    },
                    {"key": "ldk", "device_id": 2},
                ]
            }
        }
    )
    assert saved[ui_settings.SETTING_ROOM_LAYOUT] == {
        "zones": [
            {
                "key": "ldk",
                "device_id": None,
                "ac_id": None,
                "tapo_sources": ["tapo:冷蔵庫"],
            },
        ]
    }


def test_saving_other_settings_keeps_room_layout(data_dir):
    """`save_settings` の `merged` へ入れ忘れると、別のキーを保存した瞬間に消える。"""
    ui_settings.save_settings(
        {
            ui_settings.SETTING_ROOM_LAYOUT: {
                "zones": [
                    {
                        "key": "ldk",
                        "device_id": 2,
                        "ac_id": None,
                        "tapo_sources": ["tapo:冷蔵庫"],
                    }
                ]
            }
        }
    )
    ui_settings.save_settings({ui_settings.SETTING_ENERGY_UNIT_PRICE: 29.5})

    loaded = ui_settings.get_settings()
    assert loaded[ui_settings.SETTING_ROOM_LAYOUT] == {
        "zones": [
            {
                "key": "ldk",
                "device_id": 2,
                "ac_id": None,
                "tapo_sources": ["tapo:冷蔵庫"],
            }
        ]
    }
    assert loaded[ui_settings.SETTING_ENERGY_UNIT_PRICE] == 29.5
