# CSV import middleware (Node.js)

Periodically uploads a work-order CSV file from disk to the FourJaw API.

The CSV file path and upload interval live in a TOML config file. The API key is
sourced from a `.env` file, so the secret is never committed alongside the rest
of the config.

This is the Node.js version of the Python example in [`../python`](../python).
See [`../README.md`](../README.md) for the API call and CSV format.

## How it works

Each cycle the script reads the CSV as raw bytes and uploads it with:

- `Content-Type: application/octet-stream`
- `X-API-KEY: <api-key>`

On success it logs the returned import job id. It then sleeps for the configured
interval and repeats. `Ctrl-C` / `SIGTERM` shut it down immediately -- part-way
through a retry backoff, and part-way through an upload still in flight.

A transient failure (network error, timeout, or HTTP 429/500/502/503/504) is
retried up to 4 times after the first attempt, waiting 0s, 4s, 8s and 16s between
them, and preferring the server's `Retry-After` over that schedule when it sends
one (capped at 120s, so a bogus header cannot park the process). This matters
because a typical `interval_seconds` is a whole day: without
retries, one bad gateway response would cost a day of work bookings. A 4xx other
than 429 is not retried — it will not fix itself — and neither is `413`
(file over the 1 GiB limit).

The retry schedule is the same under `--once`, so it is safe to drive from cron.
It is also identical to the Python implementation's, deliberately.

## Requirements

- Node.js 20.3+ (uses the global `fetch`, `AbortSignal.timeout` and
  `AbortSignal.any`)
- Dependencies in `package.json` (`dotenv`, `smol-toml`), pinned exactly

```bash
npm ci   # installs the locked versions; prefer this over `npm install`
```

## Setup

1. Copy the env template and fill in your real FourJaw API key:

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
node import-csv.js --once
# or: npm run once

# Run the periodic loop (Ctrl-C to stop)
node import-csv.js
# or: npm start
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `-c`, `--config` | `config.toml` | Path to the TOML config file |
| `--env` | `.env` | Path to the `.env` file holding the API key |
| `--once` | off | Upload once and exit instead of looping |
| `-h`, `--help` | — | Print usage and exit |

A real `FOURJAW_API_KEY` environment variable takes precedence over the `.env`
file, so a systemd unit or container can supply the secret directly.

## Tests

```bash
npm test   # or: node --test
```

`import-csv.test.js` covers config loading, the retry schedule and the upload
call. It uses Node's built-in test runner and stubs `fetch`, so there is nothing
extra to install, no network access, and no waiting through real backoffs. Worth
running if you adapt the script.

## Configuration reference

| Key | Type | Description |
|-----|------|-------------|
| `csv_path` | string | Path to the CSV file on disk (supports `~`). **A relative path is resolved against the config file's directory**, not the current working directory, so the same config works under cron or systemd regardless of `WorkingDirectory`. |
| `interval_seconds` | number | Seconds between uploads (must be > 0) |

## Notes

- **Auth**: the script sends your FourJaw API key in the `X-API-KEY` header. The
  key identifies your FourJaw account.
- **Scheduling**: the script self-loops, but you can instead run `--once` on a
  cron/systemd timer if you prefer external scheduling.
