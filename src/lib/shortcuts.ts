export type ShortcutMap = Readonly<Record<string, () => void>>;

/** Page shortcuts never act behind an open dialog, even if focus has escaped it. */
export function handlePageShortcut(event: KeyboardEvent, map: ShortcutMap, root: Pick<Document, "querySelector"> = document) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
  if (root.querySelector('[role="dialog"], dialog[open]')) return;

  const target = event.target as HTMLElement | null;
  if (!target) return;
  const editing = target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
  const readonlyEnter = event.key === "Enter" && (target.tagName === "INPUT" || target.tagName === "TEXTAREA") && (target as HTMLInputElement).readOnly;
  if (editing && !readonlyEnter) return;
  if (target.closest?.("button") && (event.key === "Enter" || event.key === " ")) return;

  const action = map[event.key];
  if (action) {
    event.preventDefault();
    action();
  }
}
