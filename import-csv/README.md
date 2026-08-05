# CSV import middleware

A small middleware that periodically uploads a work-order CSV file from disk to
the FourJaw API. Point it at a CSV that your ERP/MES exports, and it will upload
it on a fixed interval (e.g. once per day).

Two equivalent implementations are provided — pick whichever fits your stack:

- **[`node_js/`](node_js/)** — Node.js 20+
- **[`python/`](python/)** — Python 3.11+

Both behave identically:

- Read a `config.toml` for the CSV path and upload interval.
- Read the FourJaw API key from a `.env` file (never committed).
- `POST` the raw CSV bytes as `application/octet-stream` with an `X-API-KEY`
  header, then sleep and repeat.
- Support a `--once` flag to upload a single time (handy for testing).
- Ship unit tests that run offline, using each language's built-in test runner —
  see the language README for the command.

## The API call

Each upload is a single request to the FourJaw work-booking endpoint:

```
POST https://fourjaw.app/analytics/api/v0.1/work-booking/upload
X-API-KEY: <your-api-key>
Content-Type: application/octet-stream

<raw CSV bytes>
```

On success the API responds `200` with the import job id:

```json
{ "id": "..." }
```

Processing is asynchronous — poll for the state of the import, and any rejected
rows, using that id:

```
GET https://fourjaw.app/analytics/api/v0.1/work-booking/imports?importIds=<id>
X-API-KEY: <your-api-key>
```

`importIds` is required, and accepts more than one id.

## CSV format

The file needs a header row that identifies a work order reference column and a
product reference column. FourJaw's canonical names for those are:

```csv
Work order reference No.,Product reference No.
```

You do **not** have to reshape your export to match, for two reasons:

- **Extra columns are ignored.** Only those two are required, so in most cases
  you can upload what your ERP/MES already produces, unchanged.
- **Your own header names can be mapped.** If your export calls them something
  else, register a mapping once with `PUT /work-booking/header-mapping` and
  FourJaw translates your headers on every upload after that — usually easier
  than transforming the CSV before sending it.

Two endpoints help you get this right: `GET /work-booking/template` returns a
template CSV with the canonical header row, and `POST /work-booking/preview`
parses only the header row and the first few rows, so you can confirm a mapping
before uploading a whole file.

Uploads that aren't CSV, are empty, or that leave a required column unresolved
after mapping are rejected with `422`. The maximum upload size is 1 GiB; larger
uploads are rejected with `413`. Neither is retried — see the language READMEs.

## Writing the file safely

Both implementations read the file whole at each tick and upload whatever is
there. Neither can tell a complete file from one that is still being written, so
if your export lands in place gradually you can upload a half-written CSV and
import a partial set of work orders.

Have the producing job write to a temporary file in the same directory and then
`rename`/`mv` it over the target. A rename within one filesystem is atomic, so
the middleware only ever sees the old file or the complete new one.

## Getting started

See the README in [`node_js/`](node_js/) or [`python/`](python/) for
language-specific setup and usage.
