"""Regression tests for safe public-data compilation and repository export.

Every mutation is redirected to a TemporaryDirectory; no real dataset is built.
Run with: python3 -m unittest discover -s scripts -p 'test_*.py'
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SCRIPTS / "atlas"))


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder = load("pipeline_builder", SCRIPTS / "atlas" / "build_atlas.py")
packer = load("pipeline_packer", SCRIPTS / "package_public.py")
import output_transaction


def snapshot(root):
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}


def example():
    return {"hid": 1, "src": "apple", "w": "apple", "cefr": "A1", "topic": "daily",
            "senses": [{"pos": "n.", "zh": "苹果", "en": "A fruit."}],
            "ex": [{"en": "I ate an apple.", "zh": "我吃了一个苹果。"}]}


class BuildSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="atlas-build-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "project"
        self.pub, self.data, self.forge = self.root / "public" / "atlas", self.root / "data", self.root / ".local" / "forge"
        (self.pub / "entries").mkdir(parents=True)
        self.data.mkdir()
        (self.pub / "index.json").write_text('{"count":1,"words":[["previous"]]}')
        (self.pub / "entries" / "8.json").write_text('[{"id":"previous"}]')
        (self.data / "word-atlas.json").write_text('[{"id":"previous"}]')
        (self.data / "word-atlas.csv").write_text("previous csv\n")
        (self.data / "README.md").write_text("keep documentation\n")
        values = {"ROOT": self.root, "PUB": self.pub, "DATA": self.data, "FORGE": self.forge}
        self.addCleanup(patch.stopall)
        patch.multiple(builder, **values).start()

    def source(self, content):
        (self.forge / "text").mkdir(parents=True, exist_ok=True)
        (self.forge / "text" / "batch.json").write_text(content, encoding="utf-8")

    def run_build(self):
        with patch.object(sys, "argv", ["build_atlas.py", "--no-media"]), contextlib.redirect_stdout(io.StringIO()):
            builder.main()

    def assert_rejected_unchanged(self):
        before = snapshot(self.root)
        with self.assertRaises(ValueError):
            self.run_build()
        self.assertEqual(snapshot(self.root), before)

    def test_missing_forge_preserves_dataset(self):
        self.assert_rejected_unchanged()

    def test_empty_forge_preserves_dataset(self):
        self.source("[]")
        self.assert_rejected_unchanged()

    def test_invalid_json_preserves_dataset(self):
        self.source("{broken")
        self.assert_rejected_unchanged()

    def test_incomplete_or_malformed_entry_preserves_dataset(self):
        for row in (
            {"hid": 1, "src": "apple"},
            {**example(), "senses": "wrong"},
            {**example(), "senses": [{"zh": "  "}]},
            {**example(), "ex": [{"en": "Hi", "zh": ""}]},
            {**example(), "ex": [{"en": "  ", "zh": "译文"}]},
        ):
            with self.subTest(row=row):
                self.source(json.dumps([row]))
                self.assert_rejected_unchanged()

    def test_success_replaces_metadata_and_keeps_documentation(self):
        self.source(json.dumps([example()]))
        self.run_build()
        index = json.loads((self.pub / "index.json").read_text())
        self.assertEqual(index["count"], 1)
        self.assertEqual(index["words"][0][0], "apple")
        self.assertEqual(index["words"][0][6], 0)
        self.assertFalse((self.pub / "entries" / "8.json").exists())
        self.assertEqual(json.loads((self.data / "word-atlas.json").read_text())[0]["id"], "apple")
        self.assertEqual((self.data / "README.md").read_text(), "keep documentation\n")
        self.assertEqual(json.loads((self.forge / "build-warnings.json").read_text()), [])

    def test_text_only_build_only_advertises_existing_public_media(self):
        self.source(json.dumps([example()]))
        (self.pub / "audio" / "uk").mkdir(parents=True)
        (self.pub / "audio" / "uk" / "apple.mp3").write_bytes(b"public audio")
        (self.forge / "audio" / "us").mkdir(parents=True)
        (self.forge / "audio" / "us" / "1.mp3").write_bytes(b"not copied")
        self.run_build()
        self.assertEqual(json.loads((self.pub / "index.json").read_text())["words"][0][6], 2)

    def test_validation_failure_preserves_every_output(self):
        self.source(json.dumps([example()]))
        before = snapshot(self.root)
        with patch.object(builder, "validate_outputs", side_effect=ValueError("injected invalid output")):
            with self.assertRaisesRegex(ValueError, "injected"):
                self.run_build()
        self.assertEqual(snapshot(self.root), before)

    def test_second_output_commit_failure_rolls_back_first_output(self):
        self.source(json.dumps([example()]))
        before = snapshot(self.root)
        real_replace = os.replace
        failed = False
        def replace(src, dst):
            nonlocal failed
            if Path(dst) == self.data and not failed:
                failed = True
                raise OSError("injected data commit failure")
            return real_replace(src, dst)
        with patch.object(output_transaction.os, "replace", side_effect=replace):
            with self.assertRaisesRegex(OSError, "injected"):
                self.run_build()
        self.assertTrue(failed)
        self.assertEqual(snapshot(self.root), before)


class PackageSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="atlas-package-test-")
        self.addCleanup(self.temp.cleanup)
        self.parent = Path(self.temp.name)
        self.root = self.parent / "project"
        self.root.mkdir()
        (self.root / "README.md").write_text("public content\n")
        (self.parent / "unrelated.txt").write_text("keep this sibling\n")
        self.out = self.parent / "export"
        self.addCleanup(patch.stopall)
        patch.object(packer, "ROOT", self.root).start()
        patch.dict(os.environ, {"ATLAS_SECRET_FILES": ""}).start()

    def run_pack(self, out=None):
        with patch.object(sys, "argv", ["package_public.py", "--out", str(out or self.out)]), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return packer.main()

    def test_source_subdirectory_and_ancestor_destinations_are_rejected(self):
        before = snapshot(self.parent)
        for out in (self.root, self.root / "child", self.parent, self.parent.parent, Path(self.parent.anchor)):
            with self.subTest(out=out):
                self.assertNotEqual(self.run_pack(out), 0)
                self.assertEqual(snapshot(self.parent), before)

    def test_unknown_nonempty_output_is_not_touched(self):
        self.out.mkdir()
        (self.out / "important.txt").write_text("unrelated data")
        before = snapshot(self.parent)
        self.assertNotEqual(self.run_pack(), 0)
        self.assertEqual(snapshot(self.parent), before)

    def test_symlink_output_is_rejected_without_touching_target(self):
        actual = self.parent / "actual"
        actual.mkdir()
        (actual / "important.txt").write_text("unrelated data")
        self.out.symlink_to(actual, target_is_directory=True)
        before = snapshot(self.parent)
        self.assertNotEqual(self.run_pack(), 0)
        self.assertEqual(snapshot(self.parent), before)
        self.assertTrue(self.out.is_symlink())

    def test_new_export_and_managed_update_preserve_git(self):
        (self.out / ".git").mkdir(parents=True)
        (self.out / ".git" / "config").write_text("repository identity\n")
        self.assertEqual(self.run_pack(), 0)
        (self.root / "README.md").write_text("updated content\n")
        self.assertEqual(self.run_pack(), 0)
        self.assertEqual((self.out / "README.md").read_text(), "updated content\n")
        self.assertEqual((self.out / ".git" / "config").read_text(), "repository identity\n")
        self.assertEqual(json.loads((self.out / packer.EXPORT_MARKER).read_text())["format"], packer.EXPORT_ID)

    def test_legacy_manifest_export_can_be_updated(self):
        self.assertEqual(self.run_pack(), 0)
        (self.out / packer.EXPORT_MARKER).unlink()
        (self.root / "README.md").write_text("updated content\n")
        self.assertEqual(self.run_pack(), 0)
        self.assertTrue((self.out / packer.EXPORT_MARKER).exists())

    def test_unmanaged_file_in_previous_export_is_not_removed(self):
        self.assertEqual(self.run_pack(), 0)
        (self.out / "user-note.txt").write_text("keep personal notes")
        before = snapshot(self.parent)
        self.assertNotEqual(self.run_pack(), 0)
        self.assertEqual(snapshot(self.parent), before)

    def test_scan_failure_keeps_previous_export(self):
        self.assertEqual(self.run_pack(), 0)
        (self.root / "README.md").write_text("sk" + "-" + "a" * 30)
        before = snapshot(self.parent)
        self.assertNotEqual(self.run_pack(), 0)
        self.assertEqual(snapshot(self.parent), before)

    def test_commit_failure_restores_previous_export_and_git(self):
        (self.out / ".git").mkdir(parents=True)
        (self.out / ".git" / "config").write_text("repository identity\n")
        self.assertEqual(self.run_pack(), 0)
        (self.root / "README.md").write_text("updated content\n")
        before = snapshot(self.parent)
        real_replace = os.replace
        failed = False
        def replace(src, dst):
            nonlocal failed
            if Path(dst) == self.out and not failed:
                failed = True
                raise OSError("injected export commit failure")
            return real_replace(src, dst)
        with patch.object(output_transaction.os, "replace", side_effect=replace):
            self.assertNotEqual(self.run_pack(), 0)
        self.assertTrue(failed)
        self.assertEqual(snapshot(self.parent), before)

    def test_empty_export_keeps_previous_output(self):
        self.assertEqual(self.run_pack(), 0)
        (self.root / "README.md").unlink()
        before = snapshot(self.parent)
        self.assertNotEqual(self.run_pack(), 0)
        self.assertEqual(snapshot(self.parent), before)

    def test_rollback_failure_retains_git_recovery_copy(self):
        (self.out / ".git").mkdir(parents=True)
        (self.out / ".git" / "config").write_text("repository identity\n")
        self.assertEqual(self.run_pack(), 0)
        real_replace = os.replace
        def replace(src, dst):
            src, dst = Path(src), Path(dst)
            if dst == self.out and "-export-" in str(src):
                raise OSError("injected export commit failure")
            if src.name == ".git" and "-export-" in str(src):
                raise OSError("injected git rollback failure")
            return real_replace(src, dst)
        with patch.object(output_transaction.os, "replace", side_effect=replace):
            with self.assertRaises(output_transaction.OutputRecoveryError):
                self.run_pack()
        retained = list(self.parent.glob(".export-export-*/output/.git/config"))
        self.assertEqual(len(retained), 1)
        self.assertEqual(retained[0].read_text(), "repository identity\n")


if __name__ == "__main__":
    unittest.main()
