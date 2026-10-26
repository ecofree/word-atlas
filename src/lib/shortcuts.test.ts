import assert from "node:assert/strict";
import { test } from "node:test";
import { handlePageShortcut } from "./shortcuts";

function fixture(key: string, options: { dialog?: boolean; tag?: string; readOnly?: boolean; editable?: boolean; prevented?: boolean; ctrl?: boolean; repeat?: boolean } = {}) {
  const tag = options.tag ?? "DIV";
  const target = {
    tagName: tag,
    readOnly: options.readOnly ?? false,
    closest(selector: string) {
      if (selector === "button") return tag === "BUTTON" ? target : null;
      return ["INPUT", "TEXTAREA", "SELECT"].includes(tag) || options.editable ? target : null;
    },
  };
  let prevented = !!options.prevented;
  const event = {
    key, target, metaKey: false, altKey: false, ctrlKey: !!options.ctrl, repeat: !!options.repeat,
    get defaultPrevented() { return prevented; },
    preventDefault() { prevented = true; },
  } as unknown as KeyboardEvent;
  const root = { querySelector: () => options.dialog ? {} : null } as unknown as Pick<Document, "querySelector">;
  return { event, root };
}

test("open dialogs block background answers and advancement, then shortcuts work after close", () => {
  let answers = 0;
  let advances = 0;
  const actions = { "1": () => answers++, Enter: () => advances++, " ": () => advances++ };
  for (const key of ["1", "Enter", " "]) {
    const { event, root } = fixture(key, { dialog: true });
    handlePageShortcut(event, actions, root);
    assert.equal(event.defaultPrevented, false);
  }
  assert.equal(answers, 0);
  assert.equal(advances, 0);

  const { event, root } = fixture("1");
  handlePageShortcut(event, actions, root);
  assert.equal(answers, 1);
  assert.equal(event.defaultPrevented, true);
});

test("handled, modified, repeated and editing keystrokes never answer a question", () => {
  let answers = 0;
  for (const options of [{ prevented: true }, { ctrl: true }, { repeat: true }, { tag: "INPUT" }, { tag: "TEXTAREA" }, { tag: "SELECT" }, { editable: true }]) {
    const { event, root } = fixture("1", options);
    handlePageShortcut(event, { "1": () => answers++ }, root);
  }
  assert.equal(answers, 0);
});

test("buttons retain native activation and a read-only spelling answer can continue with Enter", () => {
  let advances = 0;
  const actions = { Enter: () => advances++, " ": () => advances++ };
  for (const key of ["Enter", " "]) {
    const { event, root } = fixture(key, { tag: "BUTTON" });
    handlePageShortcut(event, actions, root);
    assert.equal(event.defaultPrevented, false);
  }
  assert.equal(advances, 0);
  const { event, root } = fixture("Enter", { tag: "INPUT", readOnly: true });
  handlePageShortcut(event, actions, root);
  assert.equal(advances, 1);
});

test("an unloaded step with no shortcuts cannot advance or grade", () => {
  const { event, root } = fixture("Enter");
  handlePageShortcut(event, {}, root);
  assert.equal(event.defaultPrevented, false);
});
