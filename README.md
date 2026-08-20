# FourJaw middleware

Public, minimal, copy-and-adapt middleware for connecting the
[FourJaw](https://fourjaw.com) API to the other systems on your shop floor and
in your business.

Middleware here means a small standalone program that sits between FourJaw and
something else, and moves data between the two on a schedule.

These are starting points, not supported products: deliberately small, readable
in a few minutes, and meant to be adapted to your own environment.

## Authentication

Each middleware's README states the API it calls and how it authenticates. The
middleware here uses a FourJaw API key sent as a bearer token:

```
Authorization: Bearer <your-api-key>
```

Keys are created in the FourJaw web app under **Personal settings → API keys**. A
key belongs to the person who created it, not to your company account, so calls
made with it are attributed to that user, and it stops working when the key is
deleted or expires. Choose an owner who will outlast the integration rather than
whoever happens to set it up. Keep your key secret, and give each integration its
own so one can be revoked without disturbing the others.

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
