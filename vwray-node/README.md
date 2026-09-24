# vwray-node

A standalone VWRAY node agent that auto-registers with the control plane, persists its credentials, and sends authenticated heartbeats.

## Quick start

```bash
CONTROL_PLANE_URL=http://localhost:3000 \
NODE_NAME=vwray-node-01 \
npx tsx vwray-node/src/index.ts
```

## Configuration

- CONTROL_PLANE_URL — base URL of the VWRAY control plane
- NODE_NAME — stable node label
- NODE_LOCATION — human-readable location label
- NODE_PROTOCOL — WIREGUARD, XRAY_VLESS, XRAY_VMESS, XRAY_TROJAN, or MOCK
- NODE_PORT / PORT — local port to bind
- PUBLIC_ENDPOINT — explicit public endpoint if known
- RAILWAY_PUBLIC_DOMAIN — Railway domain auto-detection
- HEARTBEAT_INTERVAL_MS — heartbeat cadence in milliseconds

The agent stores its credential in ~/.config/vwray-node/credentials.json and will reuse it across restarts.
