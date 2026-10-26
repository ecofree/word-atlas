"""Compile forge output into the public Word Atlas dataset.

Writes:
  public/atlas/index.json            compact list for search, grid and scheduling
  public/atlas/entries/<n>.json      full entries in chunks of 100 (learning order)
  public/atlas/img|thumb/<slug>.webp illustrations (512 / 256 px)
  public/atlas/audio/<uk|us|ex>/<slug>.mp3
  data/word-atlas.json|.csv          developer downloads (CC BY 4.0)
Usage: python3 scripts/atlas/build_atlas.py [--no-media]
"""
import argparse
import concurrent.futures as cf
import csv
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

from common import FORGE, ROOT

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from output_transaction import publish_outputs, staging_directory

TOPICS = [
    ("education", "教育"), ("work", "职场"), ("technology", "科技"), ("science", "科学"),
    ("environment", "环境"), ("health", "健康"), ("society", "社会"), ("government", "政法"),
    ("economy", "经济"), ("media", "媒体"), ("arts", "艺术"), ("travel", "旅行"),
    ("city", "城市"), ("nature", "自然"), ("daily", "生活"), ("emotion", "情感"),
    ("thinking", "思维"), ("sport", "运动"), ("history", "历史"),
]
TOPIC_INDEX = {k: i for i, (k, _) in enumerate(TOPICS)}
CEFR = ["A1", "A2", "B1", "B2", "C1", "C2"]
PUB = ROOT / "public" / "atlas"
DATA = ROOT / "data"


def slugify(word):
    s = word.strip().lower().replace("’", "'")
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "x"


def clean_entry(e):
    senses = [
        {"pos": (s.get("pos") or "").strip(), "zh": (s.get("zh") or "").strip(), "en": (s.get("en") or "").strip()}
        for s in (e.get("senses") or [])
        if s.get("zh")
    ][:3]
    ex = [
        {"en": (x.get("en") or "").strip(), "zh": (x.get("zh") or "").strip()}
        for x in (e.get("ex") or [])
        if x.get("en")
    ][:2]
    split = lambda xs: [x.strip() for x in (xs or []) if isinstance(x, str) and x.strip()]
    return {
        "w": (e.get("w") or e["src"]).strip(),
        "uk": (e.get("uk") or "").strip(),
        "us": (e.get("us") or "").strip(),
        "senses": senses,
        "ex": ex,
        "col": split(e.get("col"))[:4],
        "fam": split(e.get("fam"))[:4],
        "syn": split(e.get("syn"))[:3],
        "ant": split(e.get("ant"))[:2],
        "tip": (e.get("tip") or "").strip(),
        "cefr": e.get("cefr") if e.get("cefr") in CEFR else "B2",
        "topic": e.get("topic") if e.get("topic") in TOPIC_INDEX else "thinking",
        "note": (e.get("flag") or "").strip(),
    }


def webp(src, dst, size, q):
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return
    subprocess.run(["cwebp", "-quiet", "-q", str(q), "-m", "6", "-resize", str(size), str(size), str(src), "-o", str(dst)], check=True)


def read_entries():
    """Reject missing or malformed forge input before touching public output."""
    source = FORGE / "text"
    files = sorted(source.glob("*.json")) if source.is_dir() else []
    if not files:
        raise ValueError("No forge text input found; existing dataset was not changed.")
    raw = {}
    for p in files:
        try:
            batch = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"Invalid forge batch: {p.name}") from error
        if not isinstance(batch, list):
            raise ValueError(f"Forge batch must contain a list: {p.name}")
        for e in batch:
            if (
                not isinstance(e, dict)
                or type(e.get("hid")) is not int
                or e["hid"] < 0
                or not isinstance(e.get("src"), str)
                or not e["src"].strip()
            ):
                raise ValueError(f"Invalid forge entry identity: {p.name}")
            for key in ("w", "uk", "us", "tip", "flag"):
                if e.get(key) is not None and not isinstance(e[key], str):
                    raise ValueError(f"Invalid {key} for forge entry {e['hid']}")
            for key in ("senses", "ex", "col", "fam", "syn", "ant"):
                if e.get(key) is not None and not isinstance(e[key], list):
                    raise ValueError(f"Invalid {key} for forge entry {e['hid']}")
            for key, fields in (("senses", ("pos", "zh", "en")), ("ex", ("en", "zh"))):
                if any(
                    not isinstance(item, dict)
                    or any(item.get(field) is not None and not isinstance(item[field], str) for field in fields)
                    for item in (e.get(key) or [])
                ):
                    raise ValueError(f"Invalid {key} for forge entry {e['hid']}")
            raw[e["hid"]] = e

    if not raw:
        raise ValueError("Forge text input is empty; existing dataset was not changed.")

    entries, warnings, seen = [], [], set()
    for hid, e in sorted(raw.items()):
        c = clean_entry(e)
        if (
            not c["w"] or not c["senses"] or not c["ex"]
            or any(not sense["zh"] for sense in c["senses"])
            or any(not x["en"] or not x["zh"] for x in c["ex"])
        ):
            raise ValueError(f"Incomplete forge entry {hid}; existing dataset was not changed.")
        slug = slugify(e["src"])
        if slug in seen:
            slug = f"{slug}-{hid}"
        if not re.fullmatch(r"[a-z0-9-]{1,64}", slug) or slug in seen:
            raise ValueError(f"Invalid or duplicate generated id for forge entry {hid}")
        seen.add(slug)
        c["id"] = slug
        c["_hid"] = hid
        entries.append(c)

    # Learning path: easier levels first, deterministic shuffle inside each level
    # so neighbouring words come from different topics.
    entries.sort(key=lambda c: (CEFR.index(c["cefr"]), hashlib.sha1(c["id"].encode()).hexdigest()))
    return entries, warnings


def compile_outputs(entries, warnings, pub, data, warning_file, no_media):
    """Write only into a private staging directory."""
    # Keep existing media and unrelated download documentation. copy2 deliberately
    # avoids hard links: rewriting a staged file must never modify the live file.
    if PUB.exists():
        shutil.copytree(PUB, pub, dirs_exist_ok=True)
    if DATA.exists():
        shutil.copytree(DATA, data, dirs_exist_ok=True)
    if (pub / "entries").exists():
        shutil.rmtree(pub / "entries")

    for d in ("img", "thumb", "audio/uk", "audio/us", "audio/ex", "audio/ex2", "entries"):
        (pub / d).mkdir(parents=True, exist_ok=True)

    def media(c):
        hid, slug, m = c["_hid"], c["id"], 0
        if no_media:
            # A text-only rebuild advertises only media actually present in the
            # staged public output, not files which exist only in the forge.
            exists = lambda rel: (pub / rel).is_file() and (pub / rel).stat().st_size > 0
            if exists(f"img/{slug}.webp") and exists(f"thumb/{slug}.webp"):
                m |= 1
            for bit, sub in ((2, "uk"), (4, "us"), (8, "ex"), (16, "ex2")):
                if exists(f"audio/{sub}/{slug}.mp3"):
                    m |= bit
            return m
        src = FORGE / "img" / f"{hid}.webp"
        if src.exists() and src.stat().st_size > 1000:
            webp(src, pub / "img" / f"{slug}.webp", 512, 74)
            webp(src, pub / "thumb" / f"{slug}.webp", 256, 70)
            m |= 1
        for bit, acc, sub in ((2, "uk", "uk"), (4, "us", "us"), (8, "ex", "ex"), (16, "ex2", "ex2")):
            s = FORGE / "audio" / sub / f"{hid}.mp3"
            if s.exists():
                if s.stat().st_size == 0:
                    raise ValueError(f"Empty source audio for forge entry {hid}: {sub}")
                dst = pub / "audio" / acc / f"{slug}.mp3"
                if not dst.exists() or dst.stat().st_size != s.stat().st_size:
                    shutil.copyfile(s, dst)
                m |= bit
        return m

    with cf.ThreadPoolExecutor(10) as ex:
        flags = list(ex.map(media, entries))

    index = []
    for i, (c, m) in enumerate(zip(entries, flags)):
        c["m"] = m
        s0 = c["senses"][0]
        zh = f'{s0["pos"]} {s0["zh"]}'.strip()
        index.append([c["id"], c["w"], zh, c["uk"] or c["us"], CEFR.index(c["cefr"]), TOPIC_INDEX[c["topic"]], m])

    for n in range(0, len(entries), 100):
        chunk = [{k: v for k, v in c.items() if not k.startswith("_")} for c in entries[n : n + 100]]
        (pub / "entries" / f"{n // 100}.json").write_text(json.dumps(chunk, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    meta = {
        "id": "word-atlas-open",
        "version": 1,
        "name": "Word Atlas Open",
        "license": "CC BY 4.0",
        "count": len(index),
        "examples": sum(len(c["ex"]) for c in entries),
        "illustrated": sum(1 for m in flags if m & 1),
        "voiced": sum(1 for m in flags if m & 2),
        "chunk": 100,
        "topics": TOPICS,
        "cefr": CEFR,
        "fields": ["id", "word", "zh", "ipa", "cefr", "topic", "media"],
        "words": index,
    }
    (pub / "index.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    data.mkdir(exist_ok=True)
    public = [{k: v for k, v in c.items() if not k.startswith("_") and k != "m"} for c in entries]
    (data / "word-atlas.json").write_text(json.dumps(public, ensure_ascii=False, indent=1), encoding="utf-8")
    with open(data / "word-atlas.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["id", "word", "ipa_uk", "ipa_us", "cefr", "topic", "meanings_zh", "definition_en",
                    "example1_en", "example1_zh", "example2_en", "example2_zh", "collocations", "word_family",
                    "synonyms", "antonyms", "tip_zh"])
        for c in public:
            ex = c["ex"] + [{"en": "", "zh": ""}] * (2 - len(c["ex"]))
            w.writerow([c["id"], c["w"], c["uk"], c["us"], c["cefr"], c["topic"],
                        " | ".join(f'{s["pos"]} {s["zh"]}' for s in c["senses"]),
                        " | ".join(s["en"] for s in c["senses"]),
                        ex[0]["en"], ex[0]["zh"], ex[1]["en"], ex[1]["zh"],
                        " ; ".join(c["col"]), " ; ".join(c["fam"]), ", ".join(c["syn"]), ", ".join(c["ant"]), c["tip"]])
    warning_file.write_text(json.dumps(warnings, ensure_ascii=False, indent=1), encoding="utf-8")
    return meta


def validate_outputs(pub, data):
    meta = json.loads((pub / "index.json").read_text(encoding="utf-8"))
    entries = []
    for n in range(0, meta["count"], meta["chunk"]):
        entries.extend(json.loads((pub / "entries" / f"{n // meta['chunk']}.json").read_text(encoding="utf-8")))
    downloads = json.loads((data / "word-atlas.json").read_text(encoding="utf-8"))
    ids = [e["id"] for e in entries]
    if (
        not ids or len(ids) != meta["count"] or len(set(ids)) != len(ids)
        or ids != [row[0] for row in meta["words"]]
        or ids != [e["id"] for e in downloads]
        or sum(len(e["ex"]) for e in entries) != meta["examples"]
    ):
        raise ValueError("Generated dataset failed consistency validation")
    for e in entries:
        required = [(1, f"img/{e['id']}.webp"), (1, f"thumb/{e['id']}.webp")]
        required.extend((bit, f"audio/{sub}/{e['id']}.mp3") for bit, sub in ((2, "uk"), (4, "us"), (8, "ex"), (16, "ex2")))
        for bit, relative in required:
            if e["m"] & bit and (not (pub / relative).is_file() or not (pub / relative).stat().st_size):
                raise ValueError(f"Generated dataset references missing media: {relative}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-media", action="store_true")
    a = ap.parse_args()
    entries, warnings = read_entries()
    with staging_directory(ROOT, ".atlas-build-") as stage:
        pub, data, warning_file = stage / "atlas", stage / "data", stage / "build-warnings.json"
        meta = compile_outputs(entries, warnings, pub, data, warning_file, a.no_media)
        validate_outputs(pub, data)
        publish_outputs([(pub, PUB), (data, DATA), (warning_file, FORGE / "build-warnings.json")])
    print(json.dumps({k: meta[k] for k in ("count", "examples", "illustrated", "voiced")}), "warnings", len(warnings))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"Atlas build aborted: {error}") from error
