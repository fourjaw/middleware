# FourJaw middleware

Public, minimal, copy-and-adapt middleware for connecting the
[FourJaw](https://fourjaw.com) API to the other systems on your shop floor and
in your business.

Middleware here means a small standalone program that sits between FourJaw and
something else, and moves data between the two on a schedule.

These are starting points, not supported products: deliberately small, readable
in a few minutes, and meant to be adapted to your own environment.

## Authentication

All middleware authenticates with a FourJaw API key sent in the `X-API-KEY`
request header. Keep your key secret.

## Middleware

| Middleware | Description | Direction | Languages |
|---------|-------------|-----------|-----------|
| [`import-csv/`](import-csv/) | Periodically upload a work-order CSV file to the FourJaw API on a schedule. | Into FourJaw | Node.js, Python |

## Conventions

- **Secrets** live in a local `.env` file. Copy the provided `.env.example`,
  fill in your key, and never commit `.env`.
- **Non-secret settings** (file paths, intervals) live in a `config.toml`
  alongside each implementation.
- **Each middleware is self-contained** in its own directory, with a README
  covering the API calls it makes and the data format it expects. Where a
  middleware ships more than one implementation, each language lives in its own
  subdirectory and the implementations behave the same way.

## Contributing

Issues and pull requests that keep the middleware small and clear are welcome —
whether that's a new integration, or another language implementation of an
existing one.

## Licence

This code is provided as-is under the [MIT Licence](LICENSE).
