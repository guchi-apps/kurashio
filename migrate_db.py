from dotenv import load_dotenv
import os
import sys
from sqlalchemy import create_engine, text

load_dotenv()

DB_USER = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")
DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
DB_PORT = os.getenv("DB_PORT", "3307")
DB_NAME = os.getenv("DB_NAME", "myroom")

# DDL (CREATE TABLE / ALTER TABLE) requires a privileged user. Set these for migrations only.
DB_ADMIN_USER = os.getenv("DB_ADMIN_USER")
DB_ADMIN_PASSWORD = os.getenv("DB_ADMIN_PASSWORD")

SENSOR_TABLE = "sensor_readings"
LEGACY_SENSOR_TABLE = "dht"

# DDLが権限で弾かれたときのMySQLエラー。1044はDB単位、1142はテーブル単位の拒否。
DDL_DENIED_MARKERS = ("1044", "1142", "command denied")

GRANT_SQL = """
-- Run as a MySQL admin user (e.g. root):
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES
  ON `{db_name}`.* TO '<migration user>'@'localhost';
FLUSH PRIVILEGES;
""".strip()


def _database_url(user: str, password: str) -> str:
    return f"mysql+mysqlconnector://{user}:{password}@{DB_HOST}:{DB_PORT}/{DB_NAME}"


def _table_exists(conn, table_name: str) -> bool:
    result = conn.execute(text(f"SHOW TABLES LIKE '{table_name}'"))
    return result.fetchone() is not None


def _column_exists(conn, table_name: str, column_name: str) -> bool:
    result = conn.execute(text(f"SHOW COLUMNS FROM `{table_name}` LIKE '{column_name}'"))
    return result.fetchone() is not None


def _print_ddl_denied_hint(migrate_user: str, using_admin: bool) -> None:
    print(f"\nDDL was denied for user '{migrate_user}' on database '{DB_NAME}'.")
    if using_admin:
        print("DB_ADMIN_USER is set, but it lacks DDL privileges on this database.")
    else:
        print("DB_ADMIN_USER is not set, so the app DB user was used.")
        print("The app DB user only has SELECT/INSERT/UPDATE/DELETE by design;")
        print("set DB_ADMIN_USER/DB_ADMIN_PASSWORD to the migration user for migrations.")
    print("\nIf the migration user itself lacks privileges, grant them once:\n")
    print(GRANT_SQL.format(db_name=DB_NAME))


def _ensure_sensor_table(conn) -> str:
    if _table_exists(conn, SENSOR_TABLE):
        print(f"Table '{SENSOR_TABLE}' already exists.")
        return SENSOR_TABLE

    if _table_exists(conn, LEGACY_SENSOR_TABLE):
        print(f"Renaming table '{LEGACY_SENSOR_TABLE}' to '{SENSOR_TABLE}'...")
        conn.execute(
            text(f"RENAME TABLE `{LEGACY_SENSOR_TABLE}` TO `{SENSOR_TABLE}`")
        )
        print("Table renamed successfully.")
        return SENSOR_TABLE

    print(f"Creating table '{SENSOR_TABLE}'...")
    conn.execute(
        text(
            f"""
            CREATE TABLE `{SENSOR_TABLE}` (
                datetime DATETIME NOT NULL,
                device_id INT NOT NULL DEFAULT 1,
                temperature FLOAT NULL,
                temperature_dht11 FLOAT NULL,
                humidity INT NULL,
                pressure INT NULL,
                co2 INT NULL,
                illuminance FLOAT NULL,
                PRIMARY KEY (datetime, device_id)
            )
            """
        )
    )
    print(f"Table '{SENSOR_TABLE}' created.")
    return SENSOR_TABLE


def migrate():
    migrate_user = DB_ADMIN_USER or DB_USER
    migrate_password = DB_ADMIN_PASSWORD if DB_ADMIN_USER else DB_PASSWORD

    if not migrate_user or not migrate_password:
        print("Error: DB credentials are not configured.")
        sys.exit(1)

    using_admin = bool(DB_ADMIN_USER)
    print(f"Connecting to database at {DB_HOST}:{DB_PORT} as {migrate_user}...")
    if not using_admin:
        print("Note: Using app DB user. Set DB_ADMIN_USER/DB_ADMIN_PASSWORD if DDL is denied.")

    try:
        engine = create_engine(_database_url(migrate_user, migrate_password))
        with engine.begin() as conn:
            sensor_table = _ensure_sensor_table(conn)

            print("Checking if 'device_id' column exists...")
            if _column_exists(conn, sensor_table, "device_id"):
                print("Column 'device_id' already exists.")
            else:
                print("Adding column 'device_id'...")
                conn.execute(
                    text(
                        f"ALTER TABLE `{sensor_table}` "
                        "ADD COLUMN device_id INT NOT NULL DEFAULT 1"
                    )
                )

                print("Updating Primary Key to (datetime, device_id)...")
                try:
                    conn.execute(text(f"ALTER TABLE `{sensor_table}` DROP PRIMARY KEY"))
                    conn.execute(
                        text(
                            f"ALTER TABLE `{sensor_table}` "
                            "ADD PRIMARY KEY (datetime, device_id)"
                        )
                    )
                    print("Primary Key updated successfully.")
                except Exception as pk_e:
                    print(f"Failed to update Primary Key (might be complex to automate): {pk_e}")

            print("Checking if 'co2' column exists...")
            if _column_exists(conn, sensor_table, "co2"):
                print("Column 'co2' already exists.")
            else:
                print("Adding column 'co2'...")
                conn.execute(text(f"ALTER TABLE `{sensor_table}` ADD COLUMN co2 INT NULL"))
                print("Column 'co2' added.")

            print("Checking if 'illuminance' column exists...")
            if _column_exists(conn, sensor_table, "illuminance"):
                print("Column 'illuminance' already exists.")
            else:
                print("Adding column 'illuminance'...")
                conn.execute(
                    text(f"ALTER TABLE `{sensor_table}` ADD COLUMN illuminance FLOAT NULL")
                )
                print("Column 'illuminance' added.")

            print("Checking if 'temperature_dht11' column exists...")
            if _column_exists(conn, sensor_table, "temperature_dht11"):
                print("Column 'temperature_dht11' already exists.")
            else:
                print("Adding column 'temperature_dht11'...")
                conn.execute(
                    text(
                        f"ALTER TABLE `{sensor_table}` "
                        "ADD COLUMN temperature_dht11 FLOAT NULL"
                    )
                )
                print("Column 'temperature_dht11' added.")

            print("Checking if 'aircon' table exists...")
            result = conn.execute(text("SHOW TABLES LIKE 'aircon'"))
            if result.fetchone():
                print("Table 'aircon' already exists.")
            else:
                print("Creating table 'aircon'...")
                conn.execute(text("""
                    CREATE TABLE aircon (
                        datetime DATETIME NOT NULL,
                        ac_id INT NOT NULL DEFAULT 1,
                        name VARCHAR(100) NULL,
                        room_temperature FLOAT NULL,
                        target_temperature FLOAT NULL,
                        humidity INT NULL,
                        mode VARCHAR(20) NULL,
                        power VARCHAR(10) NULL,
                        fan_speed VARCHAR(10) NULL,
                        fan_swing VARCHAR(20) NULL,
                        online TINYINT NULL,
                        model VARCHAR(100) NULL,
                        PRIMARY KEY (datetime, ac_id)
                    )
                """))
                print("Table 'aircon' created.")

            print("Checking if 'display_entities' table exists...")
            result = conn.execute(text("SHOW TABLES LIKE 'display_entities'"))
            if result.fetchone():
                print("Table 'display_entities' already exists.")
            else:
                print("Creating table 'display_entities'...")
                conn.execute(text("""
                    CREATE TABLE display_entities (
                        entity_type VARCHAR(20) NOT NULL,
                        entity_id INT NOT NULL,
                        name VARCHAR(100) NOT NULL,
                        inherits_from INT NULL,
                        updated_at DATETIME NULL,
                        PRIMARY KEY (entity_type, entity_id)
                    )
                """))
                print("Table 'display_entities' created.")

            if _table_exists(conn, "display_entities"):
                sensor_count = conn.execute(
                    text(
                        "SELECT COUNT(*) FROM display_entities "
                        "WHERE entity_type = 'sensor'"
                    )
                ).scalar()
                if sensor_count == 0 and _table_exists(conn, "device_names"):
                    print("Migrating device_names into display_entities...")
                    if _column_exists(conn, "device_names", "inherits_from"):
                        conn.execute(text("""
                            INSERT INTO display_entities (entity_type, entity_id, name, inherits_from, updated_at)
                            SELECT 'sensor', id, name, inherits_from, updated_at
                            FROM device_names
                        """))
                    else:
                        conn.execute(text("""
                            INSERT INTO display_entities (entity_type, entity_id, name, inherits_from, updated_at)
                            SELECT 'sensor', id, name, NULL, updated_at
                            FROM device_names
                        """))
                    print("device_names migrated.")

                aircon_count = conn.execute(
                    text(
                        "SELECT COUNT(*) FROM display_entities "
                        "WHERE entity_type = 'aircon'"
                    )
                ).scalar()
                if aircon_count == 0 and _table_exists(conn, "aircon_unit_names"):
                    print("Migrating aircon_unit_names into display_entities...")
                    conn.execute(text("""
                        INSERT INTO display_entities (entity_type, entity_id, name, inherits_from, updated_at)
                        SELECT 'aircon', ac_id, name, NULL, updated_at
                        FROM aircon_unit_names
                    """))
                    print("aircon_unit_names migrated.")

            print("Checking if 'app_settings' table exists...")
            result = conn.execute(text("SHOW TABLES LIKE 'app_settings'"))
            if result.fetchone():
                print("Table 'app_settings' already exists.")
            else:
                print("Creating table 'app_settings'...")
                conn.execute(text("""
                    CREATE TABLE app_settings (
                        setting_key VARCHAR(64) NOT NULL PRIMARY KEY,
                        setting_value TEXT NOT NULL,
                        updated_at DATETIME NULL
                    )
                """))
                print("Table 'app_settings' created.")

            print("Checking if 'daily_energy' table exists...")
            result = conn.execute(text("SHOW TABLES LIKE 'daily_energy'"))
            if result.fetchone():
                print("Table 'daily_energy' already exists.")
            else:
                print("Creating table 'daily_energy'...")
                conn.execute(text("""
                    CREATE TABLE daily_energy (
                        date DATE NOT NULL,
                        source VARCHAR(64) NOT NULL,
                        kwh FLOAT NULL,
                        cost_yen FLOAT NULL,
                        power_w FLOAT NULL,
                        updated_at DATETIME NULL,
                        PRIMARY KEY (date, source)
                    )
                """))
                print("Table 'daily_energy' created.")

            # power_w はスマートプラグ対応（#109）で後から足した列。
            # daily_energy を先に作った環境にも入るよう、テーブル作成とは別に確認する。
            print("Checking if 'power_w' column exists on 'daily_energy'...")
            if _column_exists(conn, "daily_energy", "power_w"):
                print("Column 'power_w' already exists.")
            else:
                print("Adding column 'power_w'...")
                conn.execute(
                    text("ALTER TABLE daily_energy ADD COLUMN power_w FLOAT NULL")
                )
                print("Column 'power_w' added.")

            # お掃除ロボット（eufy）の稼働履歴（#110）。状態が変わった瞬間だけ1行入る。
            # updated_at は「同じ状態を最後に確認した時刻」で、受信が途絶えたかの判定に使う。
            print("Checking if 'cleaner_runs' table exists...")
            if _table_exists(conn, "cleaner_runs"):
                print("Table 'cleaner_runs' already exists.")
            else:
                print("Creating table 'cleaner_runs'...")
                conn.execute(text("""
                    CREATE TABLE cleaner_runs (
                        datetime DATETIME NOT NULL,
                        event VARCHAR(20) NOT NULL,
                        battery INT NULL,
                        updated_at DATETIME NULL,
                        PRIMARY KEY (datetime)
                    )
                """))
                print("Table 'cleaner_runs' created.")

            # 時間ごと表示（#300）のための当日累計スナップショット。上書きの daily_energy と
            # 違い追記する。収集スクリプトの実行頻度（エアコン=1時間ごと、Tapo=5分ごと）が
            # そのままポーリング間隔になるため、収集スクリプト側の変更は不要。
            print("Checking if 'energy_readings' table exists...")
            if _table_exists(conn, "energy_readings"):
                print("Table 'energy_readings' already exists.")
            else:
                print("Creating table 'energy_readings'...")
                conn.execute(text("""
                    CREATE TABLE energy_readings (
                        recorded_at DATETIME NOT NULL,
                        source VARCHAR(64) NOT NULL,
                        kwh FLOAT NULL,
                        cost_yen FLOAT NULL,
                        power_w FLOAT NULL,
                        PRIMARY KEY (recorded_at, source)
                    )
                """))
                print("Table 'energy_readings' created.")

            # 照明の点灯・消灯が変わった時刻（#368）。Nature Remo に「照明」として登録した
            # 機器の状態を5分ごとに読み、前回と違うときだけ1行足す。スナップショットを
            # 積まないのは、要るのが変わった瞬間だけで、5分おきに書くと1機器あたり
            # 年10万行になるため。照度から判定する照明はこのテーブルを使わない。
            print("Checking if 'light_events' table exists...")
            if _table_exists(conn, "light_events"):
                print("Table 'light_events' already exists.")
            else:
                print("Creating table 'light_events'...")
                conn.execute(text("""
                    CREATE TABLE light_events (
                        recorded_at DATETIME NOT NULL,
                        appliance_key VARCHAR(64) NOT NULL,
                        power VARCHAR(8) NOT NULL,
                        PRIMARY KEY (recorded_at, appliance_key)
                    )
                """))
                print("Table 'light_events' created.")

            # 月ごとの確定請求（#249）。はぴeみる電のお知らせメール由来。
            # 引越しの月は旧契約と新契約の2通が届くため、contract_key まで主キーに含める。
            print("Checking if 'utility_bills' table exists...")
            if _table_exists(conn, "utility_bills"):
                print("Table 'utility_bills' already exists.")
            else:
                print("Creating table 'utility_bills'...")
                conn.execute(text("""
                    CREATE TABLE utility_bills (
                        billing_month DATE NOT NULL,
                        kind VARCHAR(16) NOT NULL,
                        contract_key VARCHAR(32) NOT NULL,
                        plan_name VARCHAR(64) NULL,
                        amount_yen INT NOT NULL,
                        usage_value FLOAT NULL,
                        usage_unit VARCHAR(8) NULL,
                        received_at DATETIME NULL,
                        updated_at DATETIME NULL,
                        PRIMARY KEY (billing_month, kind, contract_key)
                    )
                """))
                print("Table 'utility_bills' created.")

            # 月次請求の出典（#814）。1通のメールに電気・ガスが載るので (メールID, 種別, 契約) で一意。
            print("Checking if 'utility_bill_imports' table exists...")
            if _table_exists(conn, "utility_bill_imports"):
                print("Table 'utility_bill_imports' already exists.")
            else:
                print("Creating table 'utility_bill_imports'...")
                conn.execute(text("""
                    CREATE TABLE utility_bill_imports (
                        import_id INT NOT NULL AUTO_INCREMENT,
                        source_message_id VARCHAR(255) NOT NULL,
                        kind VARCHAR(16) NOT NULL,
                        contract_key VARCHAR(32) NOT NULL,
                        billing_month DATE NOT NULL,
                        source_label VARCHAR(64) NULL,
                        confidence FLOAT NULL,
                        imported_at DATETIME NOT NULL,
                        PRIMARY KEY (import_id),
                        UNIQUE KEY uq_utility_bill_imports_source (source_message_id, kind, contract_key)
                    )
                """))
                print("Table 'utility_bill_imports' created.")

            # KEPCO「みるでん」CSVからの時間ごと実測（家全体、#302）。energy_readings と違い
            # 累計スナップショットではなく、その時間帯の実測値をそのまま持つ。
            print("Checking if 'kepco_hourly_usage' table exists...")
            if _table_exists(conn, "kepco_hourly_usage"):
                print("Table 'kepco_hourly_usage' already exists.")
            else:
                print("Creating table 'kepco_hourly_usage'...")
                conn.execute(text("""
                    CREATE TABLE kepco_hourly_usage (
                        date DATE NOT NULL,
                        hour INT NOT NULL,
                        kwh FLOAT NOT NULL,
                        imported_at DATETIME NULL,
                        PRIMARY KEY (date, hour)
                    )
                """))
                print("Table 'kepco_hourly_usage' created.")

        print("Migration completed.")

    except Exception as e:
        # 例外そのものを必ず出す。以前は権限エラーを固定文言のヒントで握り潰しており、
        # デプロイのログから「どのSQLがどう失敗したのか」が分からなかった（#193）。
        print(f"\nMigration failed: {e}")
        err = str(e)
        if any(marker in err for marker in DDL_DENIED_MARKERS):
            _print_ddl_denied_hint(migrate_user, using_admin)
        sys.exit(1)

if __name__ == "__main__":
    migrate()
