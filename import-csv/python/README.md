# CSV import middleware (Python)

Periodically uploads a work-order CSV file from disk to the FourJaw API.

The CSV file path and upload interval live in a TOML config file. The API key is
sourced from a `.env` file, so the secret is never committed alongside the rest
of the config.

This is the Python version of the Node.js example in [`../node_js`](../node_js).
See [`../README.md`](../README.md) for the API call and CSV format.

## How it works

Each cycle the script reads the CSV as raw bytes and uploads it with:

- `Content-Type: application/octet-stream`
- `Authorization: Bearer <api-key>`

On success it logs the returned import job id. It then sleeps for the configured
interval and repeats. `Ctrl-C` / `SIGTERM` interrupt that wait, so it shuts down
rather than sitting until the next tick. One caveat: a signal that arrives *part
way through a retry backoff* is not acted on until the retries finish, because
that backoff happens inside `urllib3` where it cannot be interrupted — about 28
seconds on the schedule below, or a few minutes if the server keeps sending
`Retry-After`. Allow for that in `TimeoutStopSec` if you run this under systemd.
The Node version cancels its in-flight request and exits at once; this is the one
place the two deliberately differ.

A transient failure (connection error, timeout, or HTTP 429/500/502/503/504) is
retried up to 4 times after the first attempt, waiting 0s, 4s, 8s then 16s
between them, and honouring `Retry-After` up to 120s. This matters because a typical
`interval_seconds` is a whole day: without retries, one bad gateway response
would cost a day of work bookings. A 4xx other than 429 is not retried — it will
not fix itself — and neither is `413` (file over the 1 GiB limit).

The retry schedule is the same under `--once`, and is identical to the Node.js
implementation's, deliberately. The retries themselves happen inside `urllib3`,
so unlike the Node version they are not logged one by one — a failing upload logs
a single error once the attempts are exhausted.

## Requirements

- Python 3.11+ (uses the stdlib `tomllib`)
- Dependencies in `requirements.txt` (`requests`, `python-dotenv`, `urllib3`),
  pinned exactly

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
```

## Setup

1. Copy the env template and fill in your real FourJaw API key (see
   [Getting an API key](../README.md#getting-an-api-key)):

   ```bash
   cp .env.example .env
   # edit .env and set FOURJAW_API_KEY=...
   ```

2. Edit `config.toml` with your values:

   ```toml
   csv_path         = "data/export.csv"   # work-order CSV to upload
   interval_seconds = 86400               # how often to upload (86400 = daily)
   ```

## Usage

A `sample.csv` is bundled so you can check your key and config before wiring up a
real export — set `csv_path = "sample.csv"` and run with `--once`.

```bash
# Upload a single time and exit (handy for testing config/auth)
python3 import-csv.py --once

# Run the periodic loop (Ctrl-C to stop)
python3 import-csv.py
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `-c`, `--config` | `config.toml` | Path to the TOML config file |
| `--env` | `.env` | Path to the `.env` file holding the API key |
| `--once` | off | Upload once and exit instead of looping |

A real `FOURJAW_API_KEY` environment variable takes precedence over the `.env`
file, so a systemd unit or container can supply the secret directly.

## Tests

```bash
python3 -m unittest discover
```

`test_import_csv.py` covers config loading, the retry configuration and the upload
call. It uses only the standard library's `unittest` and a fake session, so there
is nothing extra to install and no network access. Worth running if you adapt the
script.

## Configuration reference

| Key | Type | Description |
|-----|------|-------------|
| `csv_path` | string | Path to the CSV file on disk (supports `~`). **A relative path is resolved against the config file's directory**, not the current working directory, so the same config works under cron or systemd regardless of `WorkingDirectory`. |
| `interval_seconds` | number | Seconds between uploads (must be > 0) |

## Notes

- **Auth**: the script sends your FourJaw API key as a bearer token —
  `Authorization: Bearer <api-key>`. The key belongs to the user who created it,
  not to your company account. See
  [Getting an API key](../README.md#getting-an-api-key).
- **Scheduling**: the script self-loops, but you can instead run `--once` on a
  cron/systemd timer if you prefer external scheduling.
