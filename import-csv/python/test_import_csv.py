"""Unit tests for import-csv.py. Run with `python3 -m unittest discover`.

Uses only the standard library, so there is nothing extra to install. The upload
tests replace the session rather than talking to a server, so the suite is offline
and finishes in milliseconds.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
import tempfile
import unittest
from pathlib import Path

import requests


def _load_module():
    """Import the script despite the hyphen in its filename."""
    path = Path(__file__).with_name("import-csv.py")
    spec = importlib.util.spec_from_file_location("import_csv", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


csv_import = _load_module()

API_KEY_ENV = "FOURJAW_API_KEY"


class FakeResponse:
    """A requests.Response-alike: only the bits post_csv actually touches."""

    def __init__(self, status_code=200, text='{"id": "imp-1"}', json_error=False):
        self.status_code = status_code
        self.text = text
        self.ok = 200 <= status_code < 300
        self._json_error = json_error

    def json(self):
        if self._json_error:
            raise ValueError("not json")
        return json.loads(self.text)


class FakeSession:
    """Captures the POST and returns queued responses."""

    def __init__(self, *responses):
        self._responses = list(responses) or [FakeResponse()]
        self.calls = []

    def post(self, url, data=None, headers=None, timeout=None):
        self.calls.append(
            {"url": url, "data": data, "headers": headers, "timeout": timeout}
        )
        return self._responses[min(len(self.calls) - 1, len(self._responses) - 1)]


class FailingSession:
    def __init__(self, exc):
        self.exc = exc
        self.calls = []

    def post(self, *args, **kwargs):
        self.calls.append(args)
        raise self.exc


class ConfigTestCase(unittest.TestCase):
    """A temp directory and a valid API key for each test."""

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.dir = Path(self._dir.name)
        self.addCleanup(self._dir.cleanup)

        self._previous_key = os.environ.get(API_KEY_ENV)
        os.environ[API_KEY_ENV] = "test-key"
        self.addCleanup(self._restore_key)

        # The script logs every failure; assertions are on return values.
        logging.disable(logging.CRITICAL)
        self.addCleanup(logging.disable, logging.NOTSET)

    def _restore_key(self):
        if self._previous_key is None:
            os.environ.pop(API_KEY_ENV, None)
        else:
            os.environ[API_KEY_ENV] = self._previous_key

    def write_config(self, body, csv=None):
        path = self.dir / "config.toml"
        path.write_text(body)
        if csv is not None:
            (self.dir / "data.csv").write_text(csv)
        return path


class TestLoadConfig(ConfigTestCase):
    def test_relative_csv_path_resolves_against_the_config_file(self):
        path = self.write_config('csv_path = "data.csv"\ninterval_seconds = 60\n')
        config = csv_import.load_config(path)
        self.assertEqual(config.csv_path, self.dir / "data.csv")
        self.assertEqual(config.interval, 60.0)
        self.assertEqual(config.api_key, "test-key")

    def test_absolute_csv_path_is_kept(self):
        path = self.write_config(
            'csv_path = "/srv/exports/wo.csv"\ninterval_seconds = 60\n'
        )
        self.assertEqual(
            csv_import.load_config(path).csv_path, Path("/srv/exports/wo.csv")
        )

    def test_tilde_is_expanded(self):
        path = self.write_config(
            'csv_path = "~/exports/wo.csv"\ninterval_seconds = 60\n'
        )
        self.assertEqual(
            csv_import.load_config(path).csv_path,
            Path.home() / "exports/wo.csv",
        )

    def test_rejects_bad_config(self):
        cases = [
            ("missing csv_path", "interval_seconds = 60\n", "csv_path"),
            ("missing interval", 'csv_path = "a.csv"\n', "interval_seconds"),
            (
                "non-numeric interval",
                'csv_path = "a.csv"\ninterval_seconds = "soon"\n',
                "positive number",
            ),
            (
                "zero interval",
                'csv_path = "a.csv"\ninterval_seconds = 0\n',
                "positive number",
            ),
            (
                "non-string csv_path",
                "csv_path = 42\ninterval_seconds = 60\n",
                "non-empty string",
            ),
            (
                "empty csv_path",
                'csv_path = "   "\ninterval_seconds = 60\n',
                "non-empty string",
            ),
        ]
        for name, body, expected in cases:
            with self.subTest(name):
                path = self.write_config(body)
                with self.assertRaises(SystemExit) as caught:
                    csv_import.load_config(path)
                self.assertIn(expected, str(caught.exception))

    def test_rejects_a_missing_api_key(self):
        os.environ.pop(API_KEY_ENV, None)
        path = self.write_config('csv_path = "a.csv"\ninterval_seconds = 60\n')
        with self.assertRaises(SystemExit) as caught:
            csv_import.load_config(path)
        self.assertIn("API key not found", str(caught.exception))

    def test_reports_a_missing_config_file_without_a_traceback(self):
        with self.assertRaises(SystemExit) as caught:
            csv_import.load_config(self.dir / "absent.toml")
        self.assertIn("Cannot read config file", str(caught.exception))

    def test_reports_malformed_toml_without_a_traceback(self):
        path = self.write_config('csv_path = "a.csv"\ninterval_seconds =\n')
        with self.assertRaises(SystemExit) as caught:
            csv_import.load_config(path)
        self.assertIn("not valid TOML", str(caught.exception))


class TestBuildSession(unittest.TestCase):
    def test_retries_transient_statuses_on_a_capped_schedule(self):
        session = csv_import.build_session()
        retry = session.get_adapter("https://fourjaw.app").max_retries

        self.assertEqual(retry.total, csv_import.RETRY_TOTAL)
        self.assertEqual(retry.backoff_factor, csv_import.RETRY_BACKOFF_SECONDS)
        self.assertEqual(set(retry.status_forcelist), set(csv_import.RETRY_STATUSES))
        self.assertEqual(retry.allowed_methods, frozenset({"POST"}))
        self.assertTrue(retry.respect_retry_after_header)
        session.close()

    def test_does_not_retry_413_or_other_client_errors(self):
        for status in (400, 401, 413, 422):
            self.assertNotIn(status, csv_import.RETRY_STATUSES)

    def test_backoff_matches_the_documented_0_4_8_16_schedule(self):
        session = csv_import.build_session()
        retry = session.get_adapter("https://fourjaw.app").max_retries

        # urllib3 sizes the backoff from the retry history, so read it after each
        # increment: that is the wait actually applied before the next attempt.
        waits = []
        for _ in range(csv_import.RETRY_TOTAL):
            retry = retry.increment(method="POST", url="/", error=Exception("x"))
            waits.append(retry.get_backoff_time())

        self.assertEqual(waits, [0, 4.0, 8.0, 16.0])
        session.close()

    def test_caps_a_hostile_retry_after(self):
        """Assert the resulting wait, not how the ceiling is configured.

        urllib3 only offers a `retry_after_max` argument from 2.7.0, so the cap
        lives in CappedRetry. Testing the behaviour keeps this valid either way.
        """
        session = csv_import.build_session()
        retry = session.get_adapter("https://fourjaw.app").max_retries

        self.assertEqual(retry.parse_retry_after("3"), 3)
        self.assertEqual(
            retry.parse_retry_after("86400"), csv_import.MAX_RETRY_AFTER_SECONDS
        )
        session.close()

    def test_the_cap_survives_a_retry_increment(self):
        """increment() rebuilds the Retry, so the subclass has to be preserved."""
        session = csv_import.build_session()
        retry = session.get_adapter("https://fourjaw.app").max_retries

        for _ in range(csv_import.RETRY_TOTAL):
            retry = retry.increment(method="POST", url="/", error=Exception("x"))

        self.assertIsInstance(retry, csv_import.CappedRetry)
        self.assertEqual(
            retry.parse_retry_after("86400"), csv_import.MAX_RETRY_AFTER_SECONDS
        )
        session.close()


class TestPostCsv(ConfigTestCase):
    CSV = "Work order reference No.,Product reference No.\nWO-1,P-1\n"

    def config(self, csv=None):
        path = self.write_config(
            'csv_path = "data.csv"\ninterval_seconds = 60\n',
            csv=self.CSV if csv is None else csv,
        )
        return csv_import.load_config(path)

    def test_sends_the_csv_as_octet_stream_with_a_bearer_token(self):
        config = self.config()
        session = FakeSession(FakeResponse(200, '{"id": "imp-7"}'))

        self.assertTrue(csv_import.post_csv(config, session))

        (call,) = session.calls
        self.assertEqual(call["url"], csv_import.ENDPOINT)
        self.assertEqual(call["data"], self.CSV.encode())
        self.assertEqual(call["headers"]["Authorization"], "Bearer test-key")
        self.assertNotIn("X-API-KEY", call["headers"])
        self.assertEqual(call["headers"]["Content-Type"], "application/octet-stream")
        self.assertEqual(call["timeout"], csv_import.REQUEST_TIMEOUT_SECONDS)

    def test_returns_false_on_an_error_status(self):
        config = self.config()
        session = FakeSession(FakeResponse(422, "missing header"))
        self.assertFalse(csv_import.post_csv(config, session))

    def test_returns_false_on_a_transport_failure(self):
        config = self.config()
        session = FailingSession(requests.ConnectionError("socket hang up"))
        self.assertFalse(csv_import.post_csv(config, session))

    def test_succeeds_even_if_the_body_is_not_json(self):
        config = self.config()
        session = FakeSession(FakeResponse(200, "not json", json_error=True))
        self.assertTrue(csv_import.post_csv(config, session))

    def test_returns_false_without_uploading_when_the_csv_is_missing(self):
        path = self.write_config('csv_path = "absent.csv"\ninterval_seconds = 60\n')
        config = csv_import.load_config(path)
        session = FakeSession()

        self.assertFalse(csv_import.post_csv(config, session))
        self.assertEqual(session.calls, [])


if __name__ == "__main__":
    unittest.main()
