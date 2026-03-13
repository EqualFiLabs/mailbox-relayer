# mailbox-relayer

Offchain mailbox relayer service for EqualFi.

## Endpoints

- `POST /messages` - enqueue encrypted message payload metadata
- `GET /messages/:id` - fetch message details
- `POST /deliveries/:id/ack` - acknowledge delivery

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm start
```
