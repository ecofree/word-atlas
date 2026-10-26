/** Irregular forms that a stem match would miss ("teach" → "taught"). */
const IRREGULAR = new Map(
  "arise arose arisen|awake awoke awoken|bear bore borne born|beat beat beaten|become became|begin began begun beginn|bend bent|bet bet|bind bound|bite bit bitten|bleed bled|blow blew blown|break broke broken|breed bred|bring brought|broadcast broadcast|build built|burn burnt burned|burst burst|buy bought|catch caught|choose chose chosen|cling clung|come came|cost cost|creep crept|cut cut cutt|deal dealt|dig dug|do did done does|draw drew drawn|dream dreamt dreamed|drink drank drunk|drive drove driven|eat ate eaten|fall fell fallen|feed fed|feel felt|fight fought|find found|flee fled|fling flung|fly flew flown flies|forbid forbade forbidden|forget forgot forgotten|forgive forgave forgiven|freeze froze frozen|get got gotten gett|give gave given|go went gone goes|grind ground|grow grew grown|hang hung|have had has|hear heard|hide hid hidden|hit hit hitt|hold held|hurt hurt|keep kept|kneel knelt|know knew known|lay laid|lead led|lean leant leaned|leap leapt leaped|learn learnt learned|leave left|lend lent|let let|lie lay lain|light lit|lose lost|make made|mean meant|meet met|pay paid|prove proved proven|put put putt|quit quit|read read|ride rode ridden|ring rang rung|rise rose risen|run ran runn|say said|see saw seen|seek sought|sell sold|send sent|set set|sew sewed sewn|shake shook shaken|shed shed|shine shone|shoot shot|show showed shown|shrink shrank shrunk|shut shut|sing sang sung|sink sank sunk|sit sat sitt|sleep slept|slide slid|sling slung|speak spoke spoken|speed sped|spend spent|spill spilt spilled|spin spun spinn|spy spied spies|mislead misled|spit spat|split split|spread spread|spring sprang sprung|stand stood|steal stole stolen|stick stuck|sting stung|stink stank stunk|stride strode|strike struck|string strung|strive strove striven|swear swore sworn|sweep swept|swell swelled swollen|swim swam swum swimm|swing swung|take took taken|teach taught|tear tore torn|tell told|think thought|throw threw thrown|tread trod trodden|understand understood|undertake undertook undertaken|upset upset|wake woke woken|wear wore worn|weave wove woven|weep wept|win won winn|wind wound|withdraw withdrew withdrawn|write wrote written|be was were been is are am|child children|man men|woman women|foot feet|tooth teeth|mouse mice|person people|good better best|bad worse worst|far further farther furthest"
    .split("|")
    .map((row) => row.split(" "))
    .map(([base, ...forms]) => [base, forms] as const),
);

export const normalize = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .replace(/[‐‑–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** Only explicitly displayed whole-word alternatives are answers; do not invent spelling variants. */
export function acceptedForms(headword: string): string[] {
  const alternatives = headword.split("/").map((s) => s.trim());
  const forms = alternatives.length > 1 && alternatives.every((s) => /^[A-Za-z]+(?:['’‘-][A-Za-z]+)*$/.test(s))
    ? alternatives : [headword.trim()];
  const seen = new Set<string>();
  return forms.filter((form) => {
    const key = normalize(form);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The first displayed alternative supplies the letter slots and letter hints. */
export const preferredForm = (headword: string) => acceptedForms(headword)[0] ?? headword.trim();
export const acceptsAnswer = (value: string, headword: string) =>
  acceptedForms(headword).some((form) => normalize(value) === normalize(form));

// Stress cannot be inferred safely from spelling. List multisyllabic doubling cases explicitly.
const DOUBLE = new Set("admit begin commit compel confer control defer embed equip excel expel fulfil infer occur omit permit prefer propel rebel refer regret repel submit transfer transmit transship uncap travel cancel label model signal quarrel marvel marshal shovel fuel kidnap worship handicap program quit squat quiz gas".split(" "));
const KEEP_E = new Set(["age", "dye", "singe", "queue"]);
const EXTRA_FORMS: Record<string, string[]> = {
  ad: ["ads"], goose: ["geese"], ox: ["oxen"], craftsman: ["craftsmen"],
  life: ["lives"], wife: ["wives"], knife: ["knives"], shelf: ["shelves"], leaf: ["leaves"],
  wolf: ["wolves"], loaf: ["loaves"], calf: ["calves"], half: ["halves"], thief: ["thieves"], self: ["selves"],
  tomato: ["tomatoes"], potato: ["potatoes"], hero: ["heroes"], echo: ["echoes"], quiz: ["quizzes", "quizzed"],
  // Regular and irregular meanings coexist for these verbs.
  lie: ["lied"], hang: ["hanged"], shine: ["shined"], light: ["lighted"], far: ["farthest"],
};
// Restrict -er/-est to known adjectives, so e.g. teacher cannot be mistaken for teach.
const COMPARABLE = new Set("big small large little great nice happy sad long short tall high low fast slow old young warm cold hot cool hard easy heavy light early late quick quiet kind brave bright strong weak rich poor near deep thin thick wet dry clean clear dark safe simple clever narrow shallow cheap neat tight loose broad new fresh soft sharp proud sweet calm rare steep firm slim fit gentle rough plain smooth mild fierce loud empty noisy busy friendly lively healthy angry hungry lonely lucky funny silly dirty ugly pretty wealthy merry tidy tiny".split(" "));

function inflectedWord(word: string): string[] {
  const irregular = [...(IRREGULAR.get(word) ?? []), ...(EXTRA_FORMS[word] ?? [])];
  // The old table contains doubled stems (runn, beginn); expand them to real -ing forms only.
  const forms = new Set([word, ...irregular.map((form) => form === word + word.slice(-1) ? `${form}ing` : form)]);
  if (!/^[a-z]+$/.test(word) || (word.length < 3 && !irregular.length)) return [...forms];
  const consonantY = /[^aeiou]y$/.test(word);
  const hardCh = ["monarch", "patriarch", "matriarch", "stomach", "epoch"].includes(word);
  forms.add(consonantY ? `${word.slice(0, -1)}ies` : !hardCh && /(?:s|x|z|ch|sh)$/.test(word) ? `${word}es` : `${word}s`);
  const doubles = DOUBLE.has(word) || (/[^aeiou][aeiou][bdgmnprt]$/.test(word) && (word.match(/[aeiou]+/g)?.length ?? 0) === 1);
  const stem = /ic$/.test(word) ? `${word}k` : doubles ? word + word.slice(-1) : word;
  if (/ie$/.test(word)) forms.add(`${word.slice(0, -2)}ying`);
  else if (/e$/.test(word) && !/(?:ee|ye|oe)$/.test(word)) {
    if (word !== "be" && !["dye", "singe"].includes(word)) forms.add(`${word.slice(0, -1)}ing`);
    if (KEEP_E.has(word) || word === "be") forms.add(`${word}ing`);
  } else forms.add(`${stem}ing`);
  if (!irregular.length) {
    forms.add(consonantY ? `${word.slice(0, -1)}ied` : /e$/.test(word) ? `${word}d` : `${stem}ed`);
    // These British spellings also have an undoubled American form.
    if (/l$/.test(word) && DOUBLE.has(word)) { forms.add(`${word}ed`); forms.add(`${word}ing`); }
  }
  if (COMPARABLE.has(word)) {
    const adjectiveStem = consonantY ? word.slice(0, -1) + "i" : /e$/.test(word) ? word.slice(0, -1) : stem;
    forms.add(`${adjectiveStem}er`); forms.add(`${adjectiveStem}est`);
  }
  return [...forms];
}

function inflectedForms(headword: string): string[] {
  return acceptedForms(headword).flatMap((form) => {
    const word = normalize(form);
    if (/^[a-z]+-in-law$/.test(word)) return [word, word.replace("-in-law", "s-in-law")];
    if (word === "day off") return [word, "days off"];
    if (word === "take away") return inflectedWord("take").map((verb) => `${verb} away`);
    // Keep phrases intact. For hyphenated compounds, inflect only the final component.
    if (/^[a-z]+(?:-[a-z]+)+$/.test(word)) {
      const last = word.lastIndexOf("-");
      const tails = inflectedWord(word.slice(last + 1)).map((tail) => word.slice(0, last + 1) + tail);
      return word.endsWith("-up") ? [...tails, `${word}s`] : tails;
    }
    return inflectedWord(word);
  });
}

function pattern(forms: string[]) {
  const escaped = [...new Set(forms)].sort((a, b) => b.length - a.length).map((form) =>
    form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+").replace(/-/g, "[-‐‑–—]").replace(/'/g, "['’‘]"),
  );
  return new RegExp(`(?<![\\p{L}\\p{N}_])(${escaped.join("|") || "(?!)"})(?![\\p{L}\\p{N}_])`, "iu");
}

/** Exact words plus a finite set of inflections; never arbitrary stem-prefix matches. */
export const headwordPattern = (word: string) => pattern(inflectedForms(word));

export function splitHighlight(sentence: string, word: string): [string, string, string] | null {
  // Search the entire sentence for an exact form before considering any inflection.
  const m = pattern(acceptedForms(word).map(normalize)).exec(sentence) ?? headwordPattern(word).exec(sentence);
  if (!m) return null;
  return [sentence.slice(0, m.index), m[0], sentence.slice(m.index + m[0].length)];
}

export function gap(sentence: string, word: string) {
  const parts = splitHighlight(sentence, word);
  return parts ? { before: parts[0], hidden: parts[1], after: parts[2] } : null;
}

export function shuffle<T>(xs: T[], seed = Math.random() * 2 ** 31): T[] {
  const out = [...xs];
  let x = Math.floor(seed) || 1;
  for (let i = out.length - 1; i > 0; i--) {
    x = (Math.imul(1664525, x) + 1013904223) >>> 0;
    const j = x % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function hashSeed(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Collocations are stored as "english｜中文". */
export const splitPair = (s: string) => {
  const [en, zh] = s.split(/[｜|]/);
  return { en: (en || "").trim(), zh: (zh || "").trim() };
};

export const plural = (n: number) => n.toLocaleString("en-US");
