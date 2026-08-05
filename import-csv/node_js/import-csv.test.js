/**
 * Unit tests for import-csv.js. Run with `npm test` (uses the built-in
 * node:test runner, so there is nothing extra to install).
 *
 * The upload tests replace the global fetch rather than talking to a server, so
 * the suite is offline and finishes in milliseconds. Retry tests pass their own
 * `pause`, so the backoff schedule is asserted without ever sleeping.
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import {
  attemptUpload,
  backoffMs,
  loadConfig,
  parseRetryAfter,
  postCsv,
  RETRY_TOTAL,
} from "./import-csv.js";

const API_KEY_ENV = "FOURJAW_API_KEY";
const realFetch = globalThis.fetch;
const realLog = console.log;

/** Write a config.toml (and optionally a CSV) into a fresh temp directory. */
async function withConfig(body, { csv } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "import-csv-test-"));
  const configPath = join(dir, "config.toml");
  await writeFile(configPath, body);
  if (csv !== undefined) await writeFile(join(dir, "data.csv"), csv);
  return { dir, configPath };
}

/** A Response-alike: only the bits attemptUpload actually touches. */
function fakeResponse({ status = 200, body = "", headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

/** Records the waits postCsv asks for instead of performing them. */
function recordingPauser() {
  const waits = [];
  const stop = new AbortController();
  return { stop, pause: async (ms) => void waits.push(ms), waits };
}

beforeEach(() => {
  globalThis.fetch = realFetch;
  process.env[API_KEY_ENV] = "test-key";
  // The script logs every attempt; the assertions are on return values, so keep
  // the runner's output readable. Comment this out when debugging a failure.
  console.log = () => {};
});

after(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
});

describe("loadConfig", () => {
  it("resolves a relative csv_path against the config file, not the cwd", async () => {
    const { dir, configPath } = await withConfig(
      'csv_path = "data.csv"\ninterval_seconds = 60\n',
    );
    const config = await loadConfig(configPath);
    assert.equal(config.csvPath, join(dir, "data.csv"));
    assert.equal(config.interval, 60);
    assert.equal(config.apiKey, "test-key");
  });

  it("keeps an absolute csv_path as given", async () => {
    const { configPath } = await withConfig(
      'csv_path = "/srv/exports/wo.csv"\ninterval_seconds = 60\n',
    );
    assert.equal((await loadConfig(configPath)).csvPath, "/srv/exports/wo.csv");
  });

  it("expands a leading ~/ to the home directory", async () => {
    const { configPath } = await withConfig(
      'csv_path = "~/exports/wo.csv"\ninterval_seconds = 60\n',
    );
    const { csvPath } = await loadConfig(configPath);
    assert.equal(csvPath, join(process.env.HOME, "exports/wo.csv"));
  });

  const rejections = [
    ["a missing csv_path", 'interval_seconds = 60\n', /csv_path/],
    ["a missing interval_seconds", 'csv_path = "a.csv"\n', /interval_seconds/],
    [
      "a non-numeric interval_seconds",
      'csv_path = "a.csv"\ninterval_seconds = "soon"\n',
      /positive number/,
    ],
    [
      "a zero interval_seconds",
      'csv_path = "a.csv"\ninterval_seconds = 0\n',
      /positive number/,
    ],
    [
      "a non-string csv_path",
      "csv_path = 42\ninterval_seconds = 60\n",
      /non-empty string/,
    ],
    [
      "an empty csv_path",
      'csv_path = "   "\ninterval_seconds = 60\n',
      /non-empty string/,
    ],
  ];

  for (const [name, body, expected] of rejections) {
    it(`rejects ${name}`, async () => {
      const { configPath } = await withConfig(body);
      await assert.rejects(() => loadConfig(configPath), expected);
    });
  }

  it("rejects a missing API key", async () => {
    delete process.env[API_KEY_ENV];
    const { configPath } = await withConfig(
      'csv_path = "a.csv"\ninterval_seconds = 60\n',
    );
    await assert.rejects(() => loadConfig(configPath), /API key not found/);
  });
});

describe("backoffMs", () => {
  it("does not wait before the first retry", () => {
    assert.equal(backoffMs(1), 0);
  });

  it("doubles from 4s thereafter", () => {
    assert.deepEqual([2, 3, 4].map(backoffMs), [4_000, 8_000, 16_000]);
  });
});

describe("parseRetryAfter", () => {
  it("reads a delay in seconds", () => {
    assert.equal(parseRetryAfter(fakeResponse({ headers: { "retry-after": "3" } })), 3_000);
  });

  it("caps a hostile value at 120s", () => {
    assert.equal(
      parseRetryAfter(fakeResponse({ headers: { "retry-after": "86400" } })),
      120_000,
    );
  });

  it("ignores a header that is absent, unparseable, or in the past", () => {
    for (const headers of [{}, { "retry-after": "soon" }, { "retry-after": "-5" }]) {
      assert.equal(parseRetryAfter(fakeResponse({ headers })), undefined);
    }
  });
});

describe("attemptUpload", () => {
  const config = { apiKey: "test-key", csvPath: "/tmp/a.csv" };
  const stop = { signal: new AbortController().signal };

  it("sends the CSV as octet-stream with the API key, and returns the import id", async () => {
    let seen;
    globalThis.fetch = async (url, init) => {
      seen = { url, init };
      return fakeResponse({ status: 200, body: '{"id":"imp-1"}' });
    };

    const result = await attemptUpload(config, Buffer.from("a,b\n"), stop);

    assert.equal(result.ok, true);
    assert.equal(seen.init.method, "POST");
    assert.equal(seen.init.headers["X-API-KEY"], "test-key");
    assert.equal(seen.init.headers["Content-Type"], "application/octet-stream");
    assert.equal(seen.init.body.toString(), "a,b\n");
  });

  it("marks 429 and 5xx retryable, and other 4xx not", async () => {
    for (const [status, retryable] of [
      [429, true],
      [500, true],
      [503, true],
      [504, true],
      [413, false],
      [422, false],
      [401, false],
    ]) {
      globalThis.fetch = async () => fakeResponse({ status, body: "nope" });
      const result = await attemptUpload(config, Buffer.from("x"), stop);
      assert.equal(result.ok, false, `status ${status}`);
      assert.equal(result.retryable, retryable, `status ${status}`);
    }
  });

  it("treats a transport failure as retryable", async () => {
    globalThis.fetch = async () => {
      throw new Error("socket hang up");
    };
    const result = await attemptUpload(config, Buffer.from("x"), stop);
    assert.deepEqual(result, { ok: false, retryable: true });
  });

  it("does not ask for a retry once shutdown has started", async () => {
    const aborted = new AbortController();
    aborted.abort();
    globalThis.fetch = async () => {
      throw new Error("aborted");
    };
    const result = await attemptUpload(config, Buffer.from("x"), {
      signal: aborted.signal,
    });
    assert.equal(result.retryable, false);
  });
});

describe("postCsv", () => {
  async function configWithCsv() {
    const { configPath } = await withConfig(
      'csv_path = "data.csv"\ninterval_seconds = 60\n',
      { csv: "Work order reference No.,Product reference No.\nWO-1,P-1\n" },
    );
    return loadConfig(configPath);
  }

  it("returns true on a first-attempt success, with no waits", async () => {
    const config = await configWithCsv();
    const pauser = recordingPauser();
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return fakeResponse({ status: 200, body: '{"id":"imp-1"}' });
    };

    assert.equal(await postCsv(config, pauser), true);
    assert.equal(calls, 1);
    assert.deepEqual(pauser.waits, []);
  });

  it("retries a 503 on the 0/4/8/16s schedule, then gives up", async () => {
    const config = await configWithCsv();
    const pauser = recordingPauser();
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return fakeResponse({ status: 503, body: "busy" });
    };

    assert.equal(await postCsv(config, pauser), false);
    assert.equal(calls, RETRY_TOTAL + 1);
    assert.deepEqual(pauser.waits, [4_000, 8_000, 16_000]);
  });

  it("prefers Retry-After over the schedule", async () => {
    const config = await configWithCsv();
    const pauser = recordingPauser();
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return calls === 1
        ? fakeResponse({ status: 429, headers: { "retry-after": "7" } })
        : fakeResponse({ status: 200, body: '{"id":"imp-2"}' });
    };

    assert.equal(await postCsv(config, pauser), true);
    assert.deepEqual(pauser.waits, [7_000]);
  });

  it("does not retry a non-retryable status", async () => {
    const config = await configWithCsv();
    const pauser = recordingPauser();
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return fakeResponse({ status: 413, body: "too big" });
    };

    assert.equal(await postCsv(config, pauser), false);
    assert.equal(calls, 1);
    assert.deepEqual(pauser.waits, []);
  });

  it("stops retrying when shutdown starts mid-backoff", async () => {
    const config = await configWithCsv();
    const pauser = recordingPauser();
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return fakeResponse({ status: 503, body: "busy" });
    };
    // Abort while the second attempt's backoff is pending.
    const { pause } = pauser;
    pauser.pause = async (ms) => {
      await pause(ms);
      pauser.stop.abort();
    };

    assert.equal(await postCsv(config, pauser), false);
    assert.equal(calls, 2);
  });

  it("returns false, without uploading, when the CSV is missing", async () => {
    const { configPath } = await withConfig(
      'csv_path = "absent.csv"\ninterval_seconds = 60\n',
    );
    const config = await loadConfig(configPath);
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return fakeResponse();
    };

    assert.equal(await postCsv(config, recordingPauser()), false);
    assert.equal(calls, 0);
  });
});
