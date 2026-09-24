# VPN Gateway Setup

The control plane does not open a VPN socket. A gateway node runs WireGuard or Xray and talks to VWRAY through the authenticated agent API.

## WireGuard gateway

1. Install WireGuard on the gateway host and create the server interface, normally `wg0`.
2. Allow the WireGuard UDP listen port through the gateway firewall.
3. Register the gateway in **Nodes** with its public endpoint, UDP port, and protocol `WIREGUARD`.
4. Set `WIREGUARD_SERVER_PUBLIC_KEY` to the public key of the gateway's `wg0` interface.
5. Store the returned `vwrt.<node>.<secret>` agent token in the gateway agent environment. It is shown only once.
6. Configure the agent management URL and interface name (`wg0`), then send authenticated heartbeats to:

```text
POST https://your-control-plane.example/api/gateway/heartbeat
```

The agent must also implement the management actions used by the WireGuard adapter: `create`, `revoke`, `disconnect`, `quota`, `status`, and `traffic`.

## Android and iOS

- Android: install WireGuard, import the generated profile from a file or QR code, review the endpoint and AllowedIPs, then activate it.
- iOS: install WireGuard, choose Add a tunnel, scan/import the generated profile, approve the VPN permission, then activate it.
- NPV Tunnel: use it only with a profile format it explicitly supports. A standard WireGuard `.conf` should be imported through WireGuard on both Android and iOS; do not paste private keys into NPV Tunnel unless its documentation requires that exact format.

## Device access control

A new device first appears as `PENDING`. An operator can approve or reject it in **Devices**. Approved devices can receive a generated configuration. `Disconnect` ends the active session; `Block` prevents future access until the device is unblocked by policy.

## Security

Never commit WireGuard private keys, agent tokens, access codes, or production database URLs. Rotate an agent token if it is exposed, revoke affected client configurations, and block the associated device while investigating.
