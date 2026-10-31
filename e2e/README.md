# baileys-api e2e (black box)

Tests the image built from the repo `Dockerfile` from the outside, over HTTP,
with a real Redis. The tests play Rails (the "baileys" provider in Bem OS):
they call the API and receive webhooks in their own process.

## Run

Docker only, no Bun on the host needed.

```sh
e2e/run.sh                          # build, up, CLI checks, bun test, down
e2e/run.sh tests/cluster.test.ts    # one file (args go to `bun test`)
e2e/run.sh -t 'admin guard'         # by test name
E2E_KEEP=1 e2e/run.sh               # leave the stack up afterwards
E2E_SKIP_BUILD=1 e2e/run.sh         # reuse the last image
```

A run takes about 2.5 minutes. Most of that is the reconnect-loop test, which
waits about 55s for ten offline reconnects. If a run fails, service logs go to
`e2e/logs/` (gitignored). The repo's own `bun test` (bunfig `root = "src"`)
never picks these files up.

## Stack (`compose.yaml`, project `baileys-api-e2e`)

| service | role |
| --- | --- |
| `baileys` + `redis` | standalone instance (what Bem OS runs). Its Redis has a password, so the test can check that `/status` does not leak it |
| `proxy` + `worker-1` + `worker-2` + `redis-cluster` | cluster role: a lease-owner proxy in front of two workers |
| `tests` | `oven/bun:1-alpine` (same tag as the Dockerfile), runs `bun test` as your uid. It is also the webhook receiver at `http://tests:4000` |

No host ports are published and no `container_name` is set. The network is
`internal: true`.

## What is faked, and why

- **WhatsApp: not reachable at all.** The network has no internet, so every
  socket fails at DNS. The gateway still behaves as it would in production: it
  reports `connection.update` webhooks (`reconnecting`, then
  `disconnect: {statusCode: 408, reason: "connection_lost"}`, then
  `reconnect_loop_detected` with a quarantine). Those webhooks are the contract
  the suite checks.
- **Rails** is the test process. It calls the API and records webhooks.
- **API keys** are created with the real CLI (`bun manage-api-keys`, run via
  `docker compose exec` in `run.sh`). The CLI's output is asserted there.
- **Gray-box setup, used in only three places:** the runner writes media files
  into a volume it shares with the SUT. In the cluster it also writes Redis keys
  for a lease held by a dead owner and for media owners. A paired socket would
  produce these states, but nothing can reach them offline.

## Needs a paired WhatsApp account (not covered)

These cannot be tested offline:

- QR codes (`qrDataUrl`) and pairing codes. `usePairingCode` is only checked
  as accepted.
- `connection: "open"`, `wrong_phone_number`, and whether an imported session
  actually resumes.
- Every messaging, presence, contact, profile and group call on a **connected**
  socket, including the `send-message` idempotency 409.
- Inbound webhooks: `messages.upsert/update`, receipts, groups, presence,
  `message-capping`, and media capture with `includeMedia`.
- Cluster failover and drain. These need a worker to be stopped (SIGTERM) or to
  hang, which the runner cannot do: graceful handoff, the proxy's 504 mapping,
  and route-cache invalidation over pub/sub.

## Known bugs (tests marked `test.todo`, message starts with `KNOWN BUG:`)

`bun test --todo` runs them. They should start passing once the bugs are fixed.

1. **31 per-phone routes return 500 for a phone that is not connected.**
   Only `send-message`, `reachout-timelock`, `new-chat-cap` and
   `GET /connections/:phone` turn `BaileysNotConnectedError` into a 404. Every
   other handler lets the error escape, and Elysia answers
   `500 Phone number not connected`. One example is `read-messages` in
   `src/controllers/connections/index.ts:450`. Rails treats any non-2xx as
   `ProviderUnavailableError`, so Bem OS is not affected today. The swagger
   documents neither status.
2. **Schema validation runs before auth.** If a request has no key and an
   invalid body or params, it gets `422` with the validation details instead of
   `401`. This happens because `onBeforeHandle` in `src/middlewares/auth.ts:60`
   runs after Elysia's validation. A request with a valid body and no key does
   get `401`.
