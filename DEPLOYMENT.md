# Deployment

VWRAY is a control plane. WireGuard/Xray data-plane traffic runs on a separate gateway node.

## Railway

1. Create a PostgreSQL service and a web service from this repository.
2. Keep the repository `railway.json`; it uses `Dockerfile` and `/api/health`.
3. Set these variables on the web service:

```text
NODE_ENV=production
APP_URL=https://your-public-domain
DATABASE_URL=${{Postgres.DATABASE_URL}}
AUTH_SECRET=<random secret, 32+ characters>
ENCRYPTION_KEY=<random secret, 24+ characters>
WIREGUARD_SERVER_PUBLIC_KEY=<public key of the gateway wg0 interface>
ALLOW_BOOTSTRAP_CODE_RETRIEVAL=false
RUN_MIGRATIONS_ON_START=true
```

4. Deploy and wait for `/api/health` to return a healthy response.
5. Run the first bootstrap from a protected server shell. The first access code is printed once:

```bash
npm run bootstrap
```

Do not put the access code, agent token, private key, or `DATABASE_URL` in the browser or in a public repository.

## Render

1. Create a Blueprint deployment from `render.yaml`.
2. Render creates the PostgreSQL database and injects `DATABASE_URL` into the web service.
3. Set `APP_URL` to the final public HTTPS URL and add `AUTH_SECRET` and `ENCRYPTION_KEY` as secrets.
4. Keep `RUN_MIGRATIONS_ON_START=true`; the container applies committed migrations before serving traffic.
5. Confirm the Render health check at `/api/health` before opening the console.

## Public URL and client profiles

`APP_URL` is shown in the console menu as **PUBLIC URL**. It is the control-plane URL, not the VPN tunnel endpoint. The node's public endpoint and port are configured separately when a node is registered.

Approved devices and online nodes appear in **Configurations**. Generate a profile there, then use the download/copy controls. The generated payload is sensitive and is only returned once by the create request.

## Production checklist

- Use HTTPS for `APP_URL`.
- Expose the WireGuard UDP port on the gateway firewall.
- Keep the control-plane database private.
- Store gateway agent tokens outside the UI after creation.
- Verify the node heartbeat is `ONLINE` before generating a profile.
- Test approve, disconnect, block, revoke, and recovery from the Devices page.

## Environment variables

| Variable | Required | Used by | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | control plane | PostgreSQL connection string. Never printed to logs or API responses. |
| `AUTH_SECRET` | yes | control plane | Signs CSRF material. 32+ characters. |
| `ENCRYPTION_KEY` | yes | control plane | AES-256-GCM key sealing credential material at rest. 32 bytes (base64/hex) preferred. |
| `NODE_ENV` | yes | control plane | `production` enables `Secure` cookies and refuses mock gateways. |
| `APP_URL` | recommended | control plane | Public origin of the control plane (CSRF origin checks, client links). |
| `PUBLIC_HOSTNAME` | optional | control plane | Operator override for the public hostname when the platform does not provide one. Host or `host:port` only, no scheme, no path. |
| `DEFAULT_ACCESS_CODE` | optional | control plane | First-boot access code (4+ chars). When unset a random 20-character code is generated and printed once. |
| `OWNER_PASSWORD` | optional | control plane | First-boot owner password (12+ chars) so the dashboard can be entered with a password on the first login. |
| `ALLOW_BOOTSTRAP_CODE_RETRIEVAL` | optional | control plane | Keep `false` in production; the code is printed to the server log exactly once instead. |
| `NODE_ENROLLMENT_TOKEN` | required once | VPN node | Shared secret an agent presents when self-registering (`POST /api/nodes/register`). Rotate after onboarding. |
| `WIREGUARD_SERVER_PUBLIC_KEY` | required for client profiles | VPN node | Public key of the gateway `wg0` interface. |
| `PORT` | platform-provided | control plane | Railway assigns it. Never hardcoded; the container reads it at start. |
| `RAILWAY_PUBLIC_DOMAIN` | platform-provided | control plane | Used to resolve the control-plane URL automatically. |
| `IP_DETECT_URLS` | optional | control plane | Comma-separated https IP-echo endpoints (default port only) to override the built-in providers. |
| `WG_INTERFACE` / `WG_CONFIG_PATH` | VPN node only | VPN node | Interface name and config path on the data-plane host. |
| `GATEWAY_MAX_CLOCK_SKEW_SECONDS` | optional | control plane | Rejects heartbeats whose timestamp drifts further than this (replay protection). |
| `VPN_API_URL`, `XRAY_API_URL` | optional | VPN node | Loopback management endpoints for the respective adapters. |

## First login (control plane)

1. Set `AUTH_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`, `NODE_ENV=production`.
2. Deploy with `RUN_MIGRATIONS_ON_START=true` and wait for `/api/health` to report `ok`.
3. From a protected server shell, run the first bootstrap:

   ```bash
   npm run bootstrap                                   # prints the access code once
   # or, with a password ready for the first login:
   OWNER_PASSWORD='<12+ characters>' npm run bootstrap
   ```

4. Open `https://<control-plane-domain>/login`, sign in with `owner` + password (or the access code via the secondary form).
5. Set a password if you bootstrapped with an access code only, then sign out and sign back in with the password.

Every unauthenticated page request is redirected to `/login`; the console layout re-verifies the session against the database on every render, and every mutating API call additionally requires the CSRF header and the right role.

## Deploying the VPN node agent

The control plane on Railway cannot receive WireGuard UDP. Run the node on a host with a public IP (VPS).

1. On the VPS, install WireGuard and enable forwarding:

   ```bash
   apt-get update && apt-get install -y wireguard-tools
   umask 077 && wg genkey | tee wg-private.key | wg pubkey > wg-public.key
   cat > /etc/wireguard/wg0.conf <<EOF
   [Interface]
   Address = 10.200.0.1/24
   ListenPort = 51820
   PrivateKey = $(cat wg-private.key)
   PostUp   = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
   PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE
   EOF
   sysctl -w net.ipv4.ip_forward=1
   wg-quick up wg0
   ```

2. Open the UDP port (`51820/udp`) in the firewall/security group.
3. In the console, register a node with its public endpoint and port, then approve it.
4. On the VPS, run the agent (sets the control-plane URL and the enrollment token once):

   ```bash
   cd vwray-node
   CONTROL_PLANE_URL=https://<control-plane-domain> \
   NODE_ENROLLMENT_TOKEN=<same value as the control plane> \
   PUBLIC_ENDPOINT=https://<vps-domain-or-ip> \
   WG_INTERFACE=wg0 \
   npm start
   ```

5. The node appears as `REGISTERING`/`PENDING`; approve it in the console. Heartbeats then derive `ONLINE`, and the agent's WireGuard observation feeds `WIREGUARD_READY`/`WIREGUARD_DOWN`. `VPN_REACHABLE` stays `UNVERIFIED` until you confirm a client actually connects.

The endpoint you give clients is always the node's endpoint, never the control plane and never Railway's outbound IP.

## Client setup

1. Approve a device, then generate a profile in **Configurations**.
2. iPhone/Android: install WireGuard, import by QR or `.conf` file. Windows/Linux: `wg-quick up ./profile.conf` or import into the app.
3. `ALLOWEDIPS` follows the `vpn.tunnelMode` setting: `FULL` routes everything through the tunnel; `SPLIT` sends only the VPN subnet and private ranges.
4. Revoking a peer in the console stops it connecting; generate a new profile for a new device.

## Operations

- **Rotate a node token**: Nodes page -> Rotate token. The previous token stops working immediately; the new one is shown once.
- **Change a node endpoint / offline node**: update the node in the console; a node with no heartbeat for the staleness window flips `DEGRADED` then `OFFLINE` automatically (server-side, never claimed).
- **Migrations**: committed migrations run on start. Apply them early with `docker compose run --rm migrate` or a Railway pre-deploy command.
- **Backup**: use your platform's managed PostgreSQL backups. Restores run migrations forward; no data is ever rewritten by the application.
- **Rollback**: redeploy the previous image (the database schema is additive — new columns default to values that keep old behaviour, and nodes keep their approval state).

## Health checks

`/api/health` is unauthenticated and reports subsystem state (database, configuration, realtime, gateway counts) without leaking data.
