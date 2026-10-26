import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptedForms, acceptsAnswer, gap, headwordPattern, normalize, preferredForm, splitHighlight, splitPair } from "./text";

test("highlights the headword and common inflections", () => {
  assert.deepEqual(splitHighlight("Training with a friend motivates me.", "motivate")?.[1], "motivates");
  assert.deepEqual(splitHighlight("She studied hard.", "study")?.[1], "studied");
  assert.deepEqual(splitHighlight("We got a day off today.", "day off")?.[1], "day off");
  assert.equal(splitHighlight("Nothing here.", "salt"), null);
});

test("does not match inside longer unrelated words", () => {
  assert.equal(splitHighlight("The cartoon was funny.", "art"), null);
});

test("an exact headword takes priority over an earlier inflection or misleading prefix", () => {
  assert.equal(splitHighlight("The soup was so hot that I had to wait.", "so")?.[1], "so");
  assert.equal(splitHighlight("Employers should train every employee.", "employee")?.[1], "employee");
  assert.equal(splitHighlight("In a monarchy, the monarch performs ceremonial duties.", "monarch")?.[1], "monarch");
  assert.equal(splitHighlight("She studied yesterday and will study tomorrow.", "study")?.[1], "study");
});

test("missing headwords never fall back to arbitrary prefixes or derivations", () => {
  for (const [word, sentence] of [
    ["so", "The soup tastes good."], ["employee", "Employers provide training."],
    ["monarch", "It is a constitutional monarchy."], ["teach", "The teacher arrived."],
    ["hard", "I hardly noticed."], ["work", "The workshop opened."],
    ["be", "We waited beyond the gate."], ["art", "The artisan returned."],
    ["in", "The indoor pool is closed."], ["train", "The trainee returned."],
  ]) assert.equal(splitHighlight(sentence, word), null, `${word}: ${sentence}`);
  assert.equal(headwordPattern("so").test("soup"), false);
  assert.equal(splitHighlight("This is so2 and sóso.", "so"), null);
});

test("explicit regular inflections cover spelling changes without accepting derived words", () => {
  for (const [word, form] of [
    ["study", "studies"], ["study", "studying"], ["study", "studied"],
    ["motivate", "motivated"], ["make", "making"], ["stop", "stopped"], ["stop", "stopping"],
    ["offer", "offered"], ["offer", "offering"], ["admit", "admitted"], ["embed", "embedded"],
    ["travel", "travelled"], ["travel", "traveled"], ["shovel", "shovelled"],
    ["panic", "panicked"], ["panic", "panicking"], ["tie", "tying"], ["die", "dying"],
    ["see", "seeing"], ["dye", "dyeing"], ["singe", "singeing"],
    ["big", "bigger"], ["happy", "happiest"], ["monarch", "monarchs"],
  ]) assert.equal(splitHighlight(`They said ${form} yesterday.`, word)?.[1], form, word);
  assert.equal(splitHighlight("She was singing.", "singe"), null);
});

test("existing irregular verbs retain full forms and do not expose artificial stems", () => {
  for (const [word, form] of [
    ["teach", "taught"], ["go", "went"], ["go", "goes"], ["be", "was"], ["be", "being"],
    ["write", "written"], ["write", "writing"], ["drive", "driving"], ["begin", "beginning"],
    ["get", "getting"], ["cut", "cutting"], ["run", "running"], ["swim", "swimming"],
    ["lie", "lay"], ["lie", "lain"], ["lie", "lying"], ["lie", "lied"],
    ["child", "children"], ["mouse", "mice"], ["goose", "geese"], ["ox", "oxen"],
    ["shelf", "shelves"], ["craftsman", "craftsmen"], ["good", "better"], ["far", "farthest"],
  ]) assert.equal(splitHighlight(`We heard ${form} today.`, word)?.[1], form, word);
  for (const form of ["runn", "runner", "runway"]) assert.equal(splitHighlight(`The ${form} is here.`, "run"), null);
});

test("phrases and compounds stay intact, including known compound inflections", () => {
  for (const [word, form] of [
    ["post office", "post   office"], ["day off", "days off"], ["take away", "took away"],
    ["mother-in-law", "mothers-in-law"], ["T-shirt", "T-shirts"], ["check-up", "check-ups"],
    ["push-up", "push-ups"], ["baby-sit", "baby-sitting"], ["counter-offer", "counter-offered"],
    ["o'clock", "o’clock"], ["part-time", "part‑time"], ["a.m.", "a.m."],
  ]) assert.equal(splitHighlight(`We mentioned ${form} today.`, word)?.[1], form, word);
  assert.equal(splitHighlight("The office is open.", "post office"), null);
  assert.equal(splitHighlight("They took the food away.", "take away"), null);
});

test("displayed spelling alternatives are separate answers with one stable preferred form", () => {
  assert.deepEqual(acceptedForms("cheque/check"), ["cheque", "check"]);
  assert.equal(preferredForm("cheque/check"), "cheque");
  assert.equal(preferredForm("United Kingdom"), "United Kingdom");
  assert.deepEqual(acceptedForms("Cheque / CHECK / cheque"), ["Cheque", "CHECK"]);
  for (const answer of ["cheque", "check", " CHECK ", "ｃｈｅｑｕｅ"]) assert.equal(acceptsAnswer(answer, "cheque/check"), true);
  for (const answer of ["cheque/check", "cheques", "checks", "cheq", ""]) assert.equal(acceptsAnswer(answer, "cheque/check"), false);
  assert.equal(acceptsAnswer("color", "colour"), false, "Undisplayed variants are not inferred.");
  for (const word of ["post office", "mother-in-law", "o'clock", "a.m.", "color(s)", "take in/out"]) {
    assert.deepEqual(acceptedForms(word), [word]);
  }
});

test("both displayed variants can be highlighted and gapped without accepting inflections as spelling answers", () => {
  assert.equal(gap("My grandmother sent me a cheque for my birthday.", "cheque/check")?.hidden, "cheque");
  assert.equal(gap("Please pay by check.", "cheque/check")?.hidden, "check");
  assert.equal(gap("The bank accepts cheques.", "cheque/check")?.hidden, "cheques");
  assert.equal(gap("The bank accepts checks.", "cheque/check")?.hidden, "checks");
  assert.equal(acceptsAnswer("checks", "cheque/check"), false);
});

test("gaps the sentence for cloze questions", () => {
  const g = gap("I refused the extra money as a matter of principle.", "principle");
  assert.equal(g?.hidden, "principle");
  assert.equal(g?.after, ".");
});

test("normalizes typography from mobile keyboards", () => {
  assert.equal(normalize("  Don’t  "), "don't");
  assert.deepEqual(splitPair("in principle｜原则上"), { en: "in principle", zh: "原则上" });
});
