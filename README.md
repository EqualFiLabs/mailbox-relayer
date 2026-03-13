# mailbox-relayer

Offchain mailbox relayer service for EqualFi.

## Endpoints

- `GET /providers` - list scaffolded compute adapters
- `POST /messages` - enqueue a **canonical encrypted mailbox envelope**
- `GET /messages/:id` - fetch message details
- `POST /deliveries/:id/ack` - acknowledge delivery
- `POST /demo/vertical-flow` - run mocked end-to-end flow (encrypt → queue → adapter execute → callback + ack)

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
