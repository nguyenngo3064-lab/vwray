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
