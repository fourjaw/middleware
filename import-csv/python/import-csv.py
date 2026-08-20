#!/usr/bin/env python3
"""Periodically upload a work-order CSV file to the FourJaw API.

The CSV path and interval live in a TOML config file; the API key comes from the
environment.
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import threading
import tomllib
from pathlib import Path

import requests
from dotenv import load_dotenv
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("post_csv")

ENDPOINT = "https://fourjaw.app/api/v1/work-booking/imports"
# Generate a key in the FourJaw web app under Personal settings -> API keys.
API_KEY_ENV = "FOURJAW_API_KEY"

REQUEST_TIMEOUT_SECONDS = 30

# A typical interval is a day, so one transient 502 must not cost a day of data.
RETRY_TOTAL = 4
RETRY_BACKOFF_SECONDS = 2.0
RETRY_STATUSES = (429, 500, 502, 503, 504)
MAX_RETRY_AFTER_SECONDS = 120

MAX_ERROR_BODY = 500


class Config:
    """Resolved runtime configuration."""

    def __init__(self, csv_path: Path, interval: float, api_key: str):
        self.csv_path = csv_path
        self.interval = interval
        self.api_key = api_key


class CappedRetry(Retry):
    """Retry that clamps however long a server asks us to wait.

    Left uncapped, one Retry-After header can park the upload for hours inside a
    sleep that no signal interrupts. urllib3's own `retry_after_max` argument
    only exists from 2.7.0, and older versions apply no ceiling at all, so cap it
    here instead: this works on every 2.x.
    """

    def parse_retry_after(self, retry_after: str) -> float:
        return min(super().parse_retry_after(retry_after), MAX_RETRY_AFTER_SECONDS)


def build_session() -> requests.Session:
    retry = CappedRetry(
        total=RETRY_TOTAL,
        backoff_factor=RETRY_BACKOFF_SECONDS,
        status_forcelist=RETRY_STATUSES,
        allowed_methods=frozenset({"POST"}),
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    session = requests.Session()
    session.mount("https://", HTTPAdapter(max_retries=retry))
    return session


def load_config(config_path: Path) -> Config:
    try:
        with config_path.open("rb") as fh:
            raw = tomllib.load(fh)
    except OSError as exc:
        raise SystemExit(
            f"Cannot read config file {config_path}: {exc.strerror}"
        ) from exc
    except tomllib.TOMLDecodeError as exc:
        raise SystemExit(f"Config file {config_path} is not valid TOML: {exc}") from exc

    for key in ("csv_path", "interval_seconds"):
        if key not in raw:
            raise SystemExit(f"Missing required config key: '{key}'")

    if not isinstance(raw["csv_path"], str) or not raw["csv_path"].strip():
        raise SystemExit("csv_path must be a non-empty string.")

    try:
        interval = float(raw["interval_seconds"])
    except (TypeError, ValueError) as exc:
        raise SystemExit("interval_seconds must be a positive number.") from exc

    if interval <= 0:
        raise SystemExit("interval_seconds must be a positive number.")

    csv_path = Path(raw["csv_path"]).expanduser()

    # Relative to the config file, not the cwd, for cron and systemd.
    if not csv_path.is_absolute():
        csv_path = (config_path.resolve().parent / csv_path).resolve()

    api_key = os.environ.get(API_KEY_ENV)
    if not api_key:
        raise SystemExit(
            f"API key not found. Set '{API_KEY_ENV}' in your .env file or environment."
        )

    return Config(csv_path, interval, api_key)


def post_csv(config: Config, session: requests.Session) -> bool:
    try:
        data = config.csv_path.read_bytes()
    except OSError as exc:
        logger.error("Failed to read CSV %s: %s", config.csv_path, exc)
        return False

    headers = {
        "Authorization": f"Bearer {config.api_key}",
        "Content-Type": "application/octet-stream",
    }

    try:
        response = session.post(
            ENDPOINT, data=data, headers=headers, timeout=REQUEST_TIMEOUT_SECONDS
        )
    except requests.RequestException as exc:
        logger.error("Upload to %s failed: %s", ENDPOINT, exc)
        return False

    if not response.ok:
        detail = response.text[:MAX_ERROR_BODY].strip()
        logger.error(
            "Upload to %s failed: HTTP %s%s",
            ENDPOINT,
            response.status_code,
            f" {detail}" if detail else "",
        )
        return False

    # Poll GET /work-booking/imports?import_ids=<id> for processing state.
    try:
        import_id = response.json().get("id", "?")
    except ValueError:
        import_id = "?"

    logger.info(
        "Uploaded %s (%d bytes) [%s] import id=%s",
        config.csv_path,
        len(data),
        response.status_code,
        import_id,
    )
    return True


def run(config: Config) -> None:
    stop = threading.Event()

    def handle_signal(signum, _frame):
        logger.info("Received signal %s, shutting down.", signum)
        stop.set()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    logger.info(
        "Starting: every %.0fs post %s -> %s",
        config.interval,
        config.csv_path,
        ENDPOINT,
    )

    with build_session() as session:
        while not stop.is_set():
            post_csv(config, session)
            stop.wait(config.interval)

    logger.info("Stopped.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "-c",
        "--config",
        type=Path,
        default=Path("config.toml"),
        help="Path to the TOML config file (default: config.toml).",
    )
    parser.add_argument(
        "--env",
        type=Path,
        default=Path(".env"),
        help="Path to the .env file holding the API key (default: .env).",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Post a single time and exit (useful for testing).",
    )
    args = parser.parse_args(argv)

    load_dotenv(args.env)
    config = load_config(args.config)

    if args.once:
        with build_session() as session:
            return 0 if post_csv(config, session) else 1

    run(config)
    return 0


if __name__ == "__main__":
    sys.exit(main())
