"""Generate original learner entries for every headword (CC BY 4.0 content).

Usage: python3 scripts/atlas/gen_text.py [--limit N] [--workers W] [--batch B]
Output: .local/forge/text/<batch>.json (resumable)
"""
import argparse
import concurrent.futures as cf
import json
import re
import sys

from common import FORGE, load_env, stream_chat, with_retry

TOPICS = [
    "education", "work", "technology", "science", "environment", "health",
    "society", "government", "economy", "media", "arts", "travel", "city",
    "nature", "daily", "emotion", "thinking", "sport", "history",
]

SYSTEM = """You are the lead lexicographer of an open-source English vocabulary atlas for Chinese learners preparing for IELTS (band 5.5-7.5).
Write ORIGINAL content in your own words. The raw notes you receive are only a hint for which senses matter; never copy them.
Accuracy beats creativity: IPA, part of speech, Chinese meanings and grammar must be correct. Prefer standard British IPA for ipa_uk and General American for ipa_us, with slashes.
Return strict JSON only: {"entries":[...]} with one entry per input word, same order, using exactly this shape:
{
 "w": headword exactly as given (fix only obvious typos, and then set "flag"),
 "uk": "/IPA/", "us": "/IPA/",
 "senses": [{"pos": "n.|v.|adj.|adv.|prep.|conj.|pron.|phr.|num.|int.|det.", "zh": "简洁中文释义，可用；分隔，≤14字", "en": "learner-friendly English definition, ≤12 words"}],  // 1-3 senses, most IELTS-useful first
 "ex": [
   {"en": "Everyday sentence, 7-13 words, natural, vivid, uses the headword exactly or an inflected form", "zh": "自然的中文翻译"},
   {"en": "IELTS-style sentence, 12-22 words, academic/discussion register on an IELTS topic", "zh": "自然的中文翻译"}
 ],
 "col": ["2-4 high-value collocations, each as 'english phrase｜中文'"],
 "fam": ["0-4 word-family members as 'word (pos)'"],
 "syn": ["0-3 synonyms"], "ant": ["0-2 antonyms"],
 "tip": "≤36字中文：最有用的一条用法/辨析/记忆提示。不得编造词源；没有可靠词源就讲用法或易混词。",
 "cefr": "A1|A2|B1|B2|C1|C2",
 "topic": one of [TOPICS],
 "scene": "Depicting the FIRST sense: one concrete, visually clear illustration idea (≤28 words, English) that makes the core meaning obvious at a glance: a single moment with people/objects/places. Abstract words become a clear metaphorical scene. Never mention text, letters, signs, labels or numbers.",
 "flag": "" or short note if the headword is malformed, offensive, or not a real English word
}
Sentences must be safe for all ages, culturally neutral, and must not mention real brands or living public figures. Do not reuse the same names across entries; avoid 'Tom' and 'Mary'."""


def validate_headwords(value):
    """Validate the whole input before any credentials are read or jobs submitted."""
    if not isinstance(value, list) or not value:
        raise ValueError("headwords.json must contain a non-empty array")
    headwords, seen = [], set()
    for index, item in enumerate(value):
        where = f"headwords.json[{index}]"
        if not isinstance(item, dict):
            raise ValueError(f"{where} must be an object")
        hid, word = item.get("hid"), item.get("word")
        if type(hid) is not int or hid < 0 or hid in seen:
            raise ValueError(f"{where}.hid must be a unique non-negative integer")
        if not isinstance(word, str) or not word.strip():
            raise ValueError(f"{where}.word must be a non-empty string")
        raw = item.get("raw")
        if raw is None:
            raw = []
        if not isinstance(raw, list) or any(not isinstance(note, str) for note in raw):
            raise ValueError(f"{where}.raw must be an array of strings, null, or omitted")
        seen.add(hid)
        headwords.append({**item, "word": word.strip(), "raw": [note.strip() for note in raw if note.strip()]})
    return headwords


def prompt_for(batch):
    lines = []
    for g in validate_headwords(batch):
        raw = " / ".join(g["raw"])[:160]
        notes = f"  (notes: {raw})" if raw else ""
        lines.append(f'- {g["word"]}{notes}')
    return "Words:\n" + "\n".join(lines)


def run_batch(env, model, idx, batch, outdir):
    out = outdir / f"{idx:04d}.json"
    if out.exists():
        return idx, "cached"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM.replace("[TOPICS]", json.dumps(TOPICS))},
            {"role": "user", "content": prompt_for(batch)},
        ],
    }

    def call():
        text = stream_chat(env, payload)
        text = re.sub(r"^```(?:json)?|```$", "", text.strip()).strip()
        data = json.loads(text)
        entries = data["entries"]
        if len(entries) != len(batch):
            raise ValueError(f"expected {len(batch)} got {len(entries)}")
        return entries

    entries = with_retry(call, tries=4, base=5)
    for g, e in zip(batch, entries):
        e["hid"] = g["hid"]
        e["src"] = g["word"]
    out.write_text(json.dumps(entries, ensure_ascii=False), encoding="utf-8")
    return idx, "ok"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--batch", type=int, default=20)
    ap.add_argument("--model", default="gpt-6")
    ap.add_argument("--out", default="text")
    ap.add_argument("--check-input", action="store_true", help="validate headwords without credentials, model calls or output changes")
    a = ap.parse_args()
    if a.start < 0 or a.limit < 0 or a.workers < 1 or a.batch < 1:
        ap.error("--start and --limit must be non-negative; --workers and --batch must be positive")
    try:
        hw = validate_headwords(json.loads((FORGE / "headwords.json").read_text(encoding="utf-8")))
        hw = hw[a.start:]
        if a.limit:
            hw = hw[: a.limit]
        if not hw:
            raise ValueError("--start/--limit selected no headwords")
    except (OSError, ValueError) as error:
        print(f"Input error: {error}", file=sys.stderr)
        return 2
    if a.check_input:
        print(f"validated {len(hw)} selected headwords; no model calls or output changes")
        return 0
    env = load_env()
    outdir = FORGE / a.out
    outdir.mkdir(parents=True, exist_ok=True)
    batches = [hw[i : i + a.batch] for i in range(0, len(hw), a.batch)]
    base = a.start // a.batch
    done = fail = 0
    with cf.ThreadPoolExecutor(a.workers) as ex:
        futs = {ex.submit(run_batch, env, a.model, base + i, b, outdir): base + i for i, b in enumerate(batches)}
        for f in cf.as_completed(futs):
            try:
                f.result()
                done += 1
            except Exception as e:
                fail += 1
                print("FAIL", futs[f], str(e)[:200], flush=True)
            if (done + fail) % 10 == 0:
                print(f"progress {done+fail}/{len(batches)} fail={fail}", flush=True)
    print(f"finished ok={done} fail={fail}", flush=True)
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
