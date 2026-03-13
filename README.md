# mailbox-relayer

Offchain mailbox relayer service for EqualFi.

## Endpoints

- `GET /providers` - list scaffolded compute adapters
- `POST /messages` - enqueue a **canonical encrypted mailbox envelope**
- `GET /messages/:id` - fetch message details
- `POST /deliveries/:id/ack` - acknowledge delivery
- `POST /demo/vertical-flow` - run mocked end-to-end flow (encrypt → queue → adapter execute → callback + ack)
- `POST /events/onchain` - ingest on-chain lifecycle events (single event or batch)
- `GET /agreements/:agreementId/state` - inspect relayer agreement state machine view
- `POST /metering/run` - execute deterministic metering poll once (all agreements or one)
- `GET /metering/submissions` - inspect prepared batched registerUsage submissions + latest settlement status
- `POST /settlement/run` - process usage settlement queue (new + due retries)
- `GET /settlement/attempts` - inspect settlement attempt history
- `GET /metering/status` - metering + kill-switch retry + settlement scheduler status
- `GET /agreements/:agreementId/draw-eligibility` - check whether draw path is frozen
- `POST /killswitch/retries/run` - process due termination retries (with backoff)
- `GET /killswitch/active` - list active kill-switches
- `GET /killswitch/attempts` - inspect termination attempts/history

## Canonical envelope schema (v1)

`POST /messages` expects:

```json
{
  "version": "equalfi.mailbox.ecies.eth-crypto.v1",
  "recipient": "agent:base:0x...",
  "cipher": {
    "iv": "<32 hex chars>",
    "ephemPublicKey": "<128|130 hex chars>",
    "ciphertext": "<even-length hex>",
    "mac": "<64 hex chars>"
  },
  "createdAt": "2026-03-10T20:00:00.000Z",
  "expiresAt": "2026-03-10T21:00:00.000Z",
  "traceId": "optional-trace-id"
}
```

Notes:
- This matches the current `@equalfi/mailbox-sdk` envelope primitives (`iv`, `ephemPublicKey`, `ciphertext`, `mac`).
- If mailbox contracts/events carry `bytes envelope`, decode bytes to UTF-8 envelope string in the edge service, then map into this canonical shape for relayer storage/indexing.

## Compute provider adapter interface (step 3)

Scaffolded provider adapter contracts live in `src/providers/`:

- `types.ts` → `ComputeProviderAdapter` interface + request/result contracts
- `lambda.ts` → `LambdaComputeAdapter` stub
- `runpod.ts` → `RunPodComputeAdapter` stub
- `venice.ts` → `VeniceComputeAdapter` stub
- `registry.ts` → no-lock-in adapter registry + default registration

Current status:
- `venice` adapter has a live HTTP implementation scaffold (key create, usage read, revoke flow)
- `lambda` and `runpod` remain stubbed

Environment variables:

- `VENICE_API_KEY` (required for live Venice operations)
- `VENICE_BASE_URL` (optional, default `https://api.venice.ai/api/v1`)
- `RELAYER_DB_PATH` (optional; when set, enables durable SQLite state store)
- `METERING_ENABLED` (`true`/`false`, default `false`)
- `METERING_INTERVAL_MS` (default `30000`)
- `KILLSWITCH_RETRY_ENABLED` (`true`/`false`, default `false`)
- `KILLSWITCH_RETRY_INTERVAL_MS` (default `30000`)
- `USAGE_SETTLEMENT_ENABLED` (`true`/`false`, default `false`)
- `USAGE_SETTLEMENT_INTERVAL_MS` (default `30000`)
- `USAGE_SETTLEMENT_WEBHOOK_URL` (optional; external signer/settlement worker endpoint)
- `USAGE_SETTLEMENT_WEBHOOK_TOKEN` (optional; bearer token for settlement webhook)

Durable SQLite state includes:
- mailbox messages
- provider resource links (`agreementId -> providerResourceId`)
- usage checkpoints
- prepared usage submission batches (`registerUsage` payload staging)
- usage settlement attempts + retry metadata
- active kill-switch state
- termination attempt history + retry metadata (backoff scheduling)
- processed event keys (idempotency)

## Step 4 vertical demo flow

`POST /demo/vertical-flow` executes a fully mocked slice:

1. Borrower payload is encrypted using SDK-compatible ECIES helpers (`MailboxCompat`)
2. Encrypted request is queued as canonical mailbox envelope
3. Selected provider adapter stub executes (`lambda` / `runpod` / `venice`)
4. Provider callback payload is encrypted and queued
5. Callback delivery is acknowledged and persisted

Example request:

```json
{
  "provider": "venice",
  "agreementId": "agreement-123",
  "traceId": "trace-xyz"
}
```

## On-chain event ingestion worker (Phase 2)

`POST /events/onchain` accepts either:

```json
{
  "chainId": 84532,
  "blockNumber": 123,
  "logIndex": 1,
  "eventType": "activation",
  "agreementId": "agreement-123",
  "provider": "venice"
}
```

or batched:

```json
{
  "events": [
    { "chainId": 84532, "blockNumber": 123, "logIndex": 1, "eventType": "activation", "agreementId": "a-1", "provider": "venice" },
    { "chainId": 84532, "blockNumber": 123, "logIndex": 2, "eventType": "mailbox", "agreementId": "a-1", "envelope": { "version": "equalfi.mailbox.ecies.eth-crypto.v1", "recipient": "agent:base:0xabc", "cipher": { "iv": "45ec7da7123f5562935ecd4cf0f3139e", "ephemPublicKey": "045ea7b6221a026bafa1adcf2c727d8ebaf5395b40a932bf85c1e991467113ba8867fbcca8e242864e0ea02342deb475e17f384095208dd7e34b1a9162ac647323", "ciphertext": "9971dc361b6cd776ffc3fdb0a7d74149", "mac": "0957308398294e8c9f03482c7c0ba49c9aa7d3252dabe4af8224279d9be220c1" }, "createdAt": "2026-03-10T20:00:00.000Z" } }
  ]
}
```

Supported `eventType` values:
- `activation`
- `mailbox`
- `breach`
- `default`

Idempotency:
- dedupe key is `chainId:blockNumber:logIndex`
- processed keys persist when `RELAYER_DB_PATH` is set

## Deterministic metering loop (Phase 2)

- Poll source agreements from persisted provider links
- Poll provider usage using per-agreement checkpoint windows (`from` -> `to`)
- Aggregate usage deterministically by canonical `unitType`
- Stage batched registerUsage payloads in durable store (`usage_submissions`)
- Update usage checkpoints after each successful polling window
- On breach/default events, perform a **final metering pass** before key termination attempt
- Breach/default events activate a kill-switch (draw frozen) and record termination attempts with retry backoff

Run once manually:

```bash
curl -X POST http://localhost:3000/metering/run \
  -H 'content-type: application/json' \
  -d '{"to":"2026-03-10T21:01:00.000Z"}'
```

Run one agreement/final pass manually:

```bash
curl -X POST http://localhost:3000/metering/run \
  -H 'content-type: application/json' \
  -d '{"agreementId":"agreement-123","finalPass":true}'
```

## Development

```bash
npm install
npm run dev
npm run lint
npm test
```

## Build

```bash
npm run build
npm start
```
