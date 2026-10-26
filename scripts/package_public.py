#!/usr/bin/env python3
"""Export the public repository from a strict allowlist and scan every file.

    python3 scripts/package_public.py --out ../开源发布/word-atlas

Never reads .local/, environment files or credential stores, except that it may
compare file contents against secrets passed via ATLAS_SECRET_FILES so that an
exact leaked key is caught. Matched content is never printed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

from output_transaction import publish_outputs, staging_directory

ROOT = Path(__file__).resolve().parents[1]
EXPORT_MARKER = ".word-atlas-export.json"
EXPORT_ID = "word-atlas-public-export"
TOP = {
    "README.md", "README.en.md", "LICENSE", "CONTENT_LICENSE.md", "CONTRIBUTING.md", "SECURITY.md",
    ".gitignore", "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts", "index.html",
}
SCRIPTS = {
    "check-atlas.mjs", "render-cards.mjs", "record-demo.mjs", "package_public.py",
    "output_transaction.py", "test_pipeline_safety.py", "test_gen_text.py",
    "atlas-release.ts", "offline-release.ts", "test.mjs", "e2e-regressions.mjs",
    "e2e-storage-failures.mjs", "e2e-offline.mjs",
}
ATLAS_SCRIPTS = {"common.py", "gen_text.py", "gen_images.py", "gen_brand.py", "gen_word_audio.py", "gen_sentence_audio.py", "gen_sfx.py", "gen_galaxy_audio.sh", "fix_blocked.py", "build_atlas.py", "build_sfx.py"}
TEXT = {".ts", ".tsx", ".css", ".svg", ".md", ".json", ".mjs", ".js", ".py", ".html", ".csv", ".yml", ".webmanifest", ""}
PATTERNS = {
    "API credential pattern": re.compile(rb"\b(?:sk[_-][A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|xi-[A-Za-z0-9]{20,})\b"),
    "private home path": re.compile(rb"(?:/Users/|/home/)[A-Za-z0-9_.-]+/|[A-Za-z]:\\Users\\"),
    "private key material": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "credential in URL": re.compile(rb"https?://[^/\s:@]+:[^/\s@]{4,}@"),
    # Assembled at runtime so this file does not match its own pattern.
    "private dataset marker": re.compile("|".join(["private-ielts" + "-atlas", "/local" + "/media/", r"\.local" + "/media-map"]).encode()),
}


def allowed(rel: Path) -> bool:
    p = rel.parts
    name = rel.as_posix()
    if any(x in {".local", ".git", "node_modules", "dist", "output", "__pycache__", ".claude", ".playwright-cli"} or x.startswith(".env") for x in p):
        return False
    if len(p) == 1:
        return name in TOP
    if p[0] == "src":
        return rel.suffix in {".ts", ".tsx", ".css", ".svg"}
    if p[0] == "scripts":
        return (len(p) == 2 and p[1] in SCRIPTS) or (len(p) == 3 and p[1] == "atlas" and p[2] in ATLAS_SCRIPTS)
    if p[0] == "docs":
        return (len(p) == 2 and rel.suffix == ".md") or (len(p) == 3 and p[1] == "assets" and rel.suffix in {".jpg", ".png", ".gif", ".webp", ".mp4"})
    if p[0] == "data":
        return len(p) == 2 and p[1] in {"word-atlas.json", "word-atlas.csv", "README.md"}
    if name in {".github/workflows/check.yml", ".github/workflows/pages.yml"}:
        return True
    if p[0] == "public":
        inner = p[1:]
        if len(inner) == 1:
            return inner[0] in {"favicon.svg", "manifest.webmanifest", "icon-512.png", "robots.txt", "sw.js"}
        if inner[0] == "sfx":
            return len(inner) == 2 and rel.suffix == ".mp3"
        if inner[0] == "brand":
            return len(inner) == 2 and rel.suffix in {".webp", ".jpg"}
        if inner[0] == "atlas":
            sub = inner[1:]
            if sub == ("index.json",):
                return True
            if len(sub) == 2 and sub[0] == "entries":
                return re.fullmatch(r"\d+\.json", sub[1]) is not None
            if len(sub) == 2 and sub[0] in {"img", "thumb"}:
                return rel.suffix == ".webp"
            if len(sub) == 3 and sub[0] == "audio" and sub[1] in {"uk", "us", "ex", "ex2"}:
                return rel.suffix == ".mp3"
    return False


def secrets() -> list[bytes]:
    out = []
    for f in filter(None, os.environ.get("ATLAS_SECRET_FILES", "").split(os.pathsep)):
        for line in Path(f).read_text(errors="ignore").splitlines():
            v = line.split("=", 1)[-1].strip()
            if len(v) >= 16 and not v.startswith("http"):
                out.append(v.encode())
    return out


def validate_destination(raw: Path) -> Path:
    if raw.is_symlink():
        raise ValueError("refusing a symlink export destination")
    out, root = raw.resolve(), ROOT.resolve()
    if out == root or root in out.parents or out in root.parents or out == Path(out.anchor):
        raise ValueError("export destination must be outside the source and all of its ancestors")
    if not out.exists():
        return out
    if not out.is_dir():
        raise ValueError("export destination must be a directory")
    children = [p for p in out.iterdir() if p.name != ".git"]
    if not children:
        return out  # New directory or a repository containing only .git.

    # A previous public manifest identifies managed files. This also permits
    # upgrading exports made before the dedicated marker was introduced.
    manifest_file = out / "PUBLIC_MANIFEST.json"
    if manifest_file.is_symlink() or not manifest_file.is_file():
        raise ValueError("refusing an unrecognized non-empty export directory")
    try:
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        items = manifest["items"]
        if not isinstance(items, list) or not items or manifest["files"] != len(items):
            raise ValueError("invalid manifest")
        paths = set()
        for item in items:
            rel = Path(item["path"])
            if (
                rel.is_absolute() or not rel.parts or ".." in rel.parts
                or rel.parts[0] == ".git" or not allowed(rel)
                or rel.as_posix() in paths
                or not isinstance(item.get("sha256"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"])
            ):
                raise ValueError("invalid manifest entry")
            paths.add(rel.as_posix())
        marker = out / EXPORT_MARKER
        if marker.exists() and json.loads(marker.read_text(encoding="utf-8")) != {"format": EXPORT_ID, "version": 1}:
            raise ValueError("invalid export marker")
    except (KeyError, TypeError, ValueError, OSError) as error:
        raise ValueError("refusing an invalid public export manifest") from error

    managed = paths | {"PUBLIC_MANIFEST.json", EXPORT_MARKER}
    directories = {parent.as_posix() for name in paths for parent in Path(name).parents if parent != Path(".")}
    for path in out.rglob("*"):
        rel = path.relative_to(out)
        if rel.parts[0] == ".git":
            continue
        if path.is_symlink() or (path.is_dir() and rel.as_posix() not in directories) or (path.is_file() and rel.as_posix() not in managed):
            raise ValueError(f"refusing to remove an unmanaged export path: {rel.as_posix()}")
    return out


def export_to(stage: Path):
    """Build and scan a new export without modifying the destination."""
    exact = secrets()
    files, problems, total = [], [], 0
    for path in sorted(ROOT.rglob("*")):
        if path.is_symlink():
            continue
        rel = path.relative_to(ROOT)
        if not path.is_file() or not allowed(rel):
            continue
        data = path.read_bytes()
        if path.suffix in TEXT:
            hits = [label for label, rx in PATTERNS.items() if rx.search(data)]
            if any(s in data for s in exact):
                hits.append("exact secret match")
            if hits:
                problems.append(f"{rel}: {', '.join(hits)}")
                continue
        dst = stage / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)
        files.append({"path": rel.as_posix(), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        total += len(data)
    if problems:
        raise ValueError("blocked files:\n  " + "\n  ".join(problems))
    if not files:
        raise ValueError("refusing to publish an empty export")
    for item in files:
        content = (stage / item["path"]).read_bytes()
        if len(content) != item["bytes"] or hashlib.sha256(content).hexdigest() != item["sha256"]:
            raise ValueError(f"export verification failed: {item['path']}")
    (stage / "PUBLIC_MANIFEST.json").write_text(json.dumps({"files": len(files), "bytes": total, "items": files}, indent=0), encoding="utf-8")
    (stage / EXPORT_MARKER).write_text(json.dumps({"format": EXPORT_ID, "version": 1}), encoding="utf-8")
    return files, total


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    try:
        out = validate_destination(Path(a.out).expanduser())
        out.parent.mkdir(parents=True, exist_ok=True)
        keep_git = (out / ".git").exists()
        with staging_directory(out.parent, f".{out.name}-export-") as temporary:
            stage = temporary / "output"
            stage.mkdir()
            files, total = export_to(stage)
            # Revalidate immediately before committing, after the potentially
            # lengthy copy/scan. A newly added unrelated file must be preserved.
            validate_destination(out)
            publish_outputs([(stage, out)], preserve=(".git",))
        print(json.dumps({"out": out.name, "files": len(files), "megabytes": round(total / 1e6, 1), "kept_git": keep_git}))
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
