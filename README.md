# mailbox-relayer

Offchain mailbox relayer service for EqualFi.

## Endpoints

- `POST /messages` - enqueue a **canonical encrypted mailbox envelope**
- `GET /messages/:id` - fetch message details
- `POST /deliveries/:id/ack` - acknowledge delivery

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

## Development

```bash
npm install
npm run dev
npm test
```

## Build

```bash
npm run build
npm start
```
