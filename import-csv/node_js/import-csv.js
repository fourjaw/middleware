#!/usr/bin/env node
/**
 * Periodically upload a work-order CSV file to the FourJaw API. The CSV path and
 * interval live in a TOML config file; the API key comes from the environment.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parse as parseToml } from "smol-toml";
import { config as loadDotenv } from "dotenv";

const ENDPOINT = "https://fourjaw.app/api/v1/work-orders/imports";
// Generate a key in the FourJaw web app under Personal settings -> API keys.
const API_KEY_ENV = "FOURJAW_API_KEY";

const REQUEST_TIMEOUT_MS = 30_000;

// A typical interval is a day, so one transient 502 must not cost a day of data.
const RETRY_TOTAL = 4;
const RETRY_BACKOFF_MS = 2_000;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 120_000;

const MAX_ERROR_BODY = 500;

const USAGE = `Usage: node import-csv.js [options]

  -c, --config <path>  TOML config file (default: config.toml)
      --env <path>     .env file holding the API key (default: .env)
      --once           Post a single time and exit (useful for testing)
  -h, --help           This message
`;

function log(level, msg) {
  console.log(`${new Date().toISOString()} ${level} ${msg}`);
}

async function loadConfig(configPath) {
  const raw = parseToml(await readFile(configPath, "utf8"));

  for (const key of ["csv_path", "interval_seconds"]) {
    if (raw[key] === undefined) {
      throw new Error(`Missing required config key: '${key}'`);
    }
  }

  const interval = Number(raw.interval_seconds);
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new Error("interval_seconds must be a positive number.");
  }

  if (typeof raw.csv_path !== "string" || raw.csv_path.trim() === "") {
    throw new Error("csv_path must be a non-empty string.");
  }

  const expanded = raw.csv_path.startsWith("~/")
    ? join(homedir(), raw.csv_path.slice(2))
    : raw.csv_path;

  // Relative to the config file, not the cwd, for cron and systemd.
  const csvPath = isAbsolute(expanded)
    ? expanded
    : resolve(dirname(resolve(configPath)), expanded);

  const apiKey = process.env[API_KEY_ENV];
  if (!apiKey) {
    throw new Error(
      `API key not found. Set '${API_KEY_ENV}' in your .env file or environment.`,
    );
  }

  return { csvPath, interval, apiKey };
}

function parseRetryAfter(response) {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;

  const seconds = Number(raw);
  const ms = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(raw) - Date.now();

  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

// No wait before the first retry.
function backoffMs(retry) {
  return retry === 1 ? 0 : RETRY_BACKOFF_MS * 2 ** (retry - 1);
}

async function attemptUpload(config, data, stop) {
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: data,
      signal: AbortSignal.any([
        stop.signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]),
    });
  } catch (err) {
    if (stop.signal.aborted) return { ok: false, retryable: false };
    log("ERROR", `POST to ${ENDPOINT} failed: ${err.message}`);
    return { ok: false, retryable: true };
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => ""))
      .slice(0, MAX_ERROR_BODY)
      .trim();
    log(
      "ERROR",
      `Upload to ${ENDPOINT} failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`,
    );
    return {
      ok: false,
      retryable: RETRY_STATUSES.has(response.status),
      retryAfterMs: parseRetryAfter(response),
    };
  }

  // Poll GET /work-orders/imports?import_ids=<id> for processing state.
  const body = await response.json().catch(() => ({}));
  log(
    "INFO",
    `Uploaded ${config.csvPath} (${data.length} bytes) [${response.status}] import id=${body.id ?? "?"}`,
  );
  return { ok: true };
}

async function postCsv(config, { stop, pause }) {
  let data;
  try {
    data = await readFile(config.csvPath);
  } catch (err) {
    log("ERROR", `Failed to read CSV ${config.csvPath}: ${err.message}`);
    return false;
  }

  const total = RETRY_TOTAL + 1;
  for (let attempt = 1; attempt <= total; attempt += 1) {
    const { ok, retryable, retryAfterMs } = await attemptUpload(
      config,
      data,
      stop,
    );
    if (ok) return true;
    if (stop.signal.aborted) return false;
    if (!retryable || attempt > RETRY_TOTAL) return false;

    const wait = retryAfterMs ?? backoffMs(attempt);
    log(
      "WARN",
      `Attempt ${attempt}/${total} failed; retrying in ${wait / 1000}s${
        retryAfterMs === undefined ? "" : " (Retry-After)"
      }.`,
    );
    if (wait > 0) await pause(wait);
    // Shutting down mid-wait stops the retries.
    if (stop.signal.aborted) return false;
  }

  return false;
}

function createPauser() {
  const stop = new AbortController();
  // Aborting wakes any pending sleep.
  const pause = (ms) =>
    delay(ms, undefined, { signal: stop.signal }).catch(() => {});

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      log("INFO", `Received ${sig}, shutting down.`);
      stop.abort();
    });
  }

  return { stop, pause };
}

async function run(config, pauser) {
  const { stop, pause } = pauser;
  log(
    "INFO",
    `Starting: every ${config.interval}s post ${config.csvPath} -> ${ENDPOINT}`,
  );

  while (!stop.signal.aborted) {
    await postCsv(config, pauser);
    if (stop.signal.aborted) break;
    await pause(config.interval * 1000);
  }

  log("INFO", "Stopped.");
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string", short: "c", default: "config.toml" },
      env: { type: "string", default: ".env" },
      once: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  // A real env var still wins: dotenv does not overwrite.
  loadDotenv({ path: values.env, quiet: true });

  const config = await loadConfig(values.config);
  const pauser = createPauser();

  if (values.once) {
    process.exit((await postCsv(config, pauser)) ? 0 : 1);
  }

  await run(config, pauser);
}

// Guarded so the test file can import this module without running it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log("ERROR", err.message);
    process.exit(1);
  });
}

export {
  attemptUpload,
  backoffMs,
  loadConfig,
  parseRetryAfter,
  postCsv,
  RETRY_TOTAL,
};
