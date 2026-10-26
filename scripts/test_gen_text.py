"""Offline regressions for headword input validation; model calls are always mocked."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ATLAS = Path(__file__).resolve().parent / "atlas"
sys.path.insert(0, str(ATLAS))
spec = importlib.util.spec_from_file_location("tested_gen_text", ATLAS / "gen_text.py")
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


class HeadwordInputTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="atlas-text-input-test-")
        self.addCleanup(temporary.cleanup)
        self.forge = Path(temporary.name)
        self.addCleanup(patch.stopall)
        patch.object(generator, "FORGE", self.forge).start()
        self.env = patch.object(generator, "load_env", return_value={}).start()
        self.chat = patch.object(generator, "stream_chat", side_effect=AssertionError("Unexpected model call")).start()
        self.retry = patch.object(generator, "with_retry", side_effect=lambda call, **_: call()).start()

    def input(self, data):
        (self.forge / "headwords.json").write_text(json.dumps(data), encoding="utf-8")

    def main(self, *args):
        out, error = io.StringIO(), io.StringIO()
        with patch.object(sys, "argv", ["gen_text.py", *args]), contextlib.redirect_stdout(out), contextlib.redirect_stderr(error):
            status = generator.main()
        return status, out.getvalue(), error.getvalue()

    def test_omitted_null_and_empty_notes_are_equivalent(self):
        for record in ({"hid": 1, "word": "apple"}, {"hid": 1, "word": "apple", "raw": None}, {"hid": 1, "word": "apple", "raw": []}):
            with self.subTest(record=record):
                self.assertEqual(generator.prompt_for([record]), "Words:\n- apple")

    def test_notes_are_trimmed_bounded_and_do_not_mutate_the_input(self):
        original = [{"hid": 1, "word": " apple ", "raw": [" fruit ", "", " ", "x" * 200]}]
        before = json.loads(json.dumps(original))
        prompt = generator.prompt_for(original)
        self.assertEqual(prompt, "Words:\n- apple  (notes: " + ("fruit / " + "x" * 200)[:160] + ")")
        self.assertEqual(original, before)

    def test_invalid_note_types_are_explicit_input_errors(self):
        for raw in ("fruit", 7, True, {}, ["fruit", None], [3]):
            with self.subTest(raw=raw):
                with self.assertRaisesRegex(ValueError, r"headwords.json\[0\]\.raw"):
                    generator.prompt_for([{"hid": 1, "word": "apple", "raw": raw}])
        self.chat.assert_not_called()

    def test_missing_null_notes_generate_successfully_without_live_calls(self):
        self.input([{"hid": 1, "word": "apple"}, {"hid": 2, "word": "pear", "raw": None}])
        self.chat.side_effect = lambda _env, _payload: json.dumps({"entries": [{"w": "generated"}]})
        status, out, error = self.main("--batch", "1", "--workers", "1")
        self.assertEqual((status, error), (0, ""))
        self.assertIn("finished ok=2 fail=0", out)
        self.assertEqual(self.chat.call_count, 2)
        first = json.loads((self.forge / "text/0000.json").read_text())
        second = json.loads((self.forge / "text/0001.json").read_text())
        self.assertEqual((first[0]["hid"], first[0]["src"]), (1, "apple"))
        self.assertEqual((second[0]["hid"], second[0]["src"]), (2, "pear"))

    def test_invalid_later_row_prevents_every_job_and_output_change(self):
        self.input([{"hid": 1, "word": "apple"}, {"hid": 2, "word": "pear", "raw": "not an array"}])
        (self.forge / "text").mkdir()
        previous = self.forge / "text/0000.json"
        previous.write_text("previous generated batch")
        status, _, error = self.main("--batch", "1", "--workers", "1")
        self.assertEqual(status, 2)
        self.assertIn("Input error: headwords.json[1].raw", error)
        self.assertEqual(previous.read_text(), "previous generated batch")
        self.assertFalse((self.forge / "text/0001.json").exists())
        self.env.assert_not_called()
        self.chat.assert_not_called()
        self.retry.assert_not_called()

    def test_whole_file_is_validated_before_selecting_a_limit(self):
        self.input([{"hid": 1, "word": "apple"}, {"hid": 2, "word": "pear", "raw": {}}])
        status, _, _ = self.main("--limit", "1")
        self.assertEqual(status, 2)
        self.env.assert_not_called()
        self.chat.assert_not_called()
        self.assertFalse((self.forge / "text").exists())

    def test_bad_file_shapes_ids_and_words_fail_without_credentials(self):
        bad_inputs = [None, {}, [], [None], [{"hid": True, "word": "apple"}], [{"hid": -1, "word": "apple"}], [{"hid": 1, "word": " "}], [{"hid": 1, "word": "apple"}, {"hid": 1, "word": "pear"}]]
        for data in bad_inputs:
            with self.subTest(data=data):
                self.input(data)
                status, _, error = self.main()
                self.assertEqual(status, 2)
                self.assertIn("Input error:", error)
        self.env.assert_not_called()
        self.chat.assert_not_called()
        self.assertFalse((self.forge / "text").exists())

    def test_missing_or_malformed_json_is_an_input_error(self):
        self.assertEqual(self.main()[0], 2)
        (self.forge / "headwords.json").write_text("not json")
        self.assertEqual(self.main()[0], 2)
        self.env.assert_not_called()
        self.chat.assert_not_called()

    def test_check_input_never_loads_credentials_or_creates_output(self):
        self.input([{"hid": 1, "word": "apple"}])
        status, out, error = self.main("--check-input")
        self.assertEqual((status, error), (0, ""))
        self.assertIn("validated 1 selected headwords", out)
        self.env.assert_not_called()
        self.chat.assert_not_called()
        self.assertFalse((self.forge / "text").exists())

    def test_empty_selection_and_invalid_numeric_options_fail_before_work(self):
        self.input([{"hid": 1, "word": "apple"}])
        self.assertEqual(self.main("--start", "1")[0], 2)
        for option, value in (("--start", "-1"), ("--limit", "-1"), ("--workers", "0"), ("--batch", "0")):
            with self.subTest(option=option), self.assertRaises(SystemExit) as raised:
                self.main(option, value)
            self.assertEqual(raised.exception.code, 2)
        self.env.assert_not_called()
        self.chat.assert_not_called()

    def test_generation_failure_returns_a_failing_exit_status(self):
        self.input([{"hid": 1, "word": "apple"}])
        self.chat.side_effect = RuntimeError("mock model failure")
        status, out, _ = self.main("--workers", "1")
        self.assertEqual(status, 1)
        self.assertIn("finished ok=0 fail=1", out)
        self.assertFalse((self.forge / "text/0000.json").exists())


if __name__ == "__main__":
    unittest.main()
