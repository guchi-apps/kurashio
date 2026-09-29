/**
 * ウィジェットのボタン押下（#546）を、アプリ経由で1回だけ送るための記録。
 *
 * アプリは Web の結果通知（ack）を受けるまで保留を消さない。リロードで途切れると同じ押下が
 * 再配達されるため、**送る前に押下のキーを記録**しておき、記録済みのキーは送らない
 * （最大1回。送信が通っていたかは分からないので、再配達分は「結果不明」として扱う）。
 */
const STORAGE_KEY = "myroom_widget_press_keys";
const KEEP = 20;

interface KeyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function readKeys(storage: KeyStorage): string[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/** キーを記録できたら true（初めて見た）。記録済みなら false。保存できないときは送らない側に倒す */
export function claimPressKey(storage: KeyStorage, key: string): boolean {
  const keys = readKeys(storage);
  if (keys.includes(key)) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify([...keys, key].slice(-KEEP)));
  } catch {
    return false;
  }
  return true;
}
