import { visibleRemoteGroups, type RemoteButtons } from "@/lib/remote";

/** ホーム画面ウィジェット（Large）に並べるボタン1つぶん（`SharedWidgetSnapshot.RemoteButton` と同じ形） */
export interface WidgetRemoteButton {
  id: string;
  label: string;
  /** どの部屋のボタンか分かるよう、所属グループ名（例: リビング）も渡す */
  groupName: string;
}

/** ウィジェットに載せる上限。Largeの高さに収まる件数（#546） */
export const WIDGET_REMOTE_BUTTON_LIMIT = 4;

/** ダッシュボードに出しているボタン（非表示を除く）を、並び順どおり先頭から `limit` 件 */
export function buildWidgetRemoteButtons(
  buttons: RemoteButtons | null,
  limit: number = WIDGET_REMOTE_BUTTON_LIMIT
): WidgetRemoteButton[] {
  return visibleRemoteGroups(buttons)
    .flatMap((group) =>
      group.buttons.map((button) => ({
        id: button.id,
        label: button.label,
        groupName: group.name,
      }))
    )
    .slice(0, limit);
}
