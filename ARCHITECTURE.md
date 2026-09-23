# VWRAY — Kiến trúc hệ thống

## Tổng quan

VWRAY là **control plane** cho mạng/VPN đa cổng. Nó không chạy proxy hoặc mở socket VPN trực tiếp; nhiệm vụ của nó là:

- Quản lý identity (operator account, session)
- Quản lý resources (device, node, config, credential)
- Thu thập và tổng hợp traffic từ data-plane gateways
- Thực thi quota và policy (thông qua GatewayPolicyState mà agent đọc)
- Cung cấp realtime dashboard qua SSE
- Tính toán simulated billing + receipts
- Phát hiện anomaly và gửi notification
- Ghi audit log

Control plane giao tiếp với data plane thông qua **gateway agent protocol**: các HTTP endpoints trong `/api/gateway/*` mà agent (chạy trên host dữ liệu) gọi để:

- Pull policy cho từng device (`/api/gateway/policy`)
- Acknowledge policy (`/api/gateway/policy/ack`)
- Push traffic samples (`/api/gateway/traffic`)
- Push heartbeat (`/api/gateway/heartbeat`)
- Push DNS query stats (`/api/gateway/dns`)

## Split control plane / data plane

**Control plane** (repo này):

- Next.js app (frontend + API routes)
- Service layer `src/server/**` (framework-independent)
- PostgreSQL (Prisma)
- In-memory realtime bus (EventEmitter) hoặc Redis pub/sub cho multi-replica

**Data plane** (process riêng, không nằm trong repo này):

- WireGuard interface (wg0) hoặc Xray daemon
- Agent process quản lý interface đó, gọi control plane HTTP APIs
- Thực thi policy: block peer, revoke credential, áp dụng quota

Lợi ích của split này:

- Control plane không cần quyền root hay truy cập socket VPN
- Data plane có thể chạy trên host khác, evenbare metal hoặc VM
- Control plane có thể scale độc lập data plane
- Policy được trung tâm hóa, agent chỉ áp dụng theo instruction

## Adapter model

Mỗi VPN technology được encapsulate trong một adapter implementing interface `VpnAdapter`:

```typescript
interface VpnAdapter {
  readonly key: string;
  readonly displayName: string;
  readonly protocol: "WIREGUARD" | "XRAY_VLESS" | "XRAY_VMESS" | "XRAY_TROJAN" | "MOCK";
  capabilities(): AdapterCapabilities;
  createClient(spec: VpnClientSpec): Promise<VpnClientHandle>;
  revokeClient(handle: ...): Promise<void>;
  disconnectClient(handle: ...): Promise<void>;
  getStatus(): Promise<AdapterStatus>;
  getTraffic(): Promise<PeerTraffic[]>;
  applyQuota(request: ApplyQuotaRequest): Promise<void>;
}
```

Adapter hiện có:

| Adapter | Protocol | Mode | Byte accounting |
| --- | --- | --- | --- |
| WireGuardAdapter | WIREGUARD | agent / local (dev) | counters (peer counters) |
| XrayAdapter | XRAY_VLESS / XRAY_VMESS / XRAY_TROJAN | agent (cần apiUrl) | counters (nếu per-user stats bật) |
| MockGatewayAdapter | MOCK | development only | none (tạo dữ liệu giả) |

Capability reporting thật:

- `byteAccounting: "counters"` — adapter báo được bytes từ peer counters.
- `byteAccounting: "none"` — adapter không thể đo bytes per-peer.

Mọi tính toán optimization/savings keys off capability này. Adapter nào báo `none` sẽ dẫn đến "Unavailable" trong UI, không phải số đoán.

## Traffic pipeline

### Nhận sample

1. Agent push traffic sample đến `/api/gateway/traffic` (các字段: credentialPublicKey, deviceId, direction, bytes, packets, connections, hostname, ip, category, timestamp)
2. Collector (`src/server/traffic/collector.ts`) nhận, resolve device qua credentialPublicKey hoặc deviceId
3. Xác định source: REAL hay MOCK (tùy node.isRealGateway và DEV_MOCK_GATEWAY_ENABLED)

### Xử lý

Bước theo thứ tự:

1. **Resolve** — map credential/public key đến device. Identity là credential, không phải source IP (NAT có thể share IP).
2. **Account** — feed realtime aggregator trước, để live chart không bị chặn bởi database latency.
3. **Record** — queue raw sample vào in-memory buffer.
4. **Enforce** — gọi quota engine, có thể revoke session và block peer tại gateway trong transaction.

Enforcement phụ thuộc vào byte đã đếm, không phải ngược lại — device không thể vượt quota rồi mới bị chặn.

### Buffer và flush

- Raw samples được queue trong memory (`src/server/traffic/buffer.ts`).
- Flush batch ra PostgreSQL theo `TRAFFIC_FLUSH_INTERVAL_SECONDS` (mặc định 10 giây).
- Trong flush: bulk insert raw rows + upsert aggregates cho nhiều granularity (MINUTE, HOUR, DAY, MONTH) và nhiều dimension.
- Crash-window trade-off: tối đa 1 flush interval raw samples có thể mất nếu process crash. Aggregates derived từ raw samples, nên billing history có thể thiếu đoạn đó.

### Realtime aggregator

- `src/server/realtime/aggregator.ts`: singleton, survive Next.js dev reloads.
- Nhận batch bytes từ collector, tính rate (Bps) từ delta thời gian.
- Maintain sliding ring buffer cho các chart window (30s, 60s, 300s, 900s).
- Publish `traffic.tick` mỗi giây qua bus.
- Không viết PostgreSQL: history được viết bởi flush path.

### Status thật

Aggregator quyết định status chart:

- `live` — gateway reported trong freshness window, có throughput > 0.
- `idle` — gateway healthy, nhưng không có traffic.
- `stale` — không có gateway report gần đây. Chart KHÔNG hiển thị 0 bps.
- `mock` — chỉ có mock feed, không có real feed.

### In-memory bus

- `src/server/realtime/bus.ts`: EventEmitter-based bus.
- Sự kiện: `traffic.tick`, `system.status`, `notification`, `quota.update`, `device.update`, `node.update`.
- Với multi-replica deployment: thay EventEmitter bằng Redis pub/sub, subscriber API không đổi.

## Quota engine

`src/server/quota/engine.ts`:

- Chỉ nơi quota được evaluate.
- Chạy trong traffic ingest path, server-side.
- Frontend không quyết định gì: chỉ render state engine trả.

Khi quota exceeded, transaction:

1. device.connectionStatus = QUOTA_EXCEEDED, quotaExceededAt = now
2. quota.exceededAt = now, usedBytes recorded
3. Mọi open VpnSession cho device được close với endReason = QUOTA_EXCEEDED
4. GatewayPolicyState (device, node) upsert → QUOTA_EXCEEDED, revision bumped
5. Audit row `quota.exceeded` viết trong transaction
6. Notification gửi sau commit

Bước 4 là điều làm enforcement thành thật: quyết định đi đến data plane, data plane là thứ từ chối connection.

`graceBytes` chỉ tolerates packets đã in-flight khi decision landing; không phải bypass budget.

## Policy enforcement model

GatewayPolicyState là model trung tâm cho enforcement:

- Mỗi row: (deviceId, nodeId), state (ACTIVE / BLOCKED / QUOTA_EXCEEDED / REVOKED), reason, revision, appliedAt, ackedAt.
- Agent pull policy từ `/api/gateway/policy`.
- Agent acknowledge từ `/api/gateway/policy/ack`.
- Policy change → revision bumped → agent nhận biết change.

resolvePolicy (`src/server/gateway/policy.ts`):

- Tính state cuối cùng từ device state + quota state + config state + policy row.
- Reason lấy từ strongest block reason.
- Operator notes và internal rationale không bao giờ leak ra agent.

## DNS filtering

- DNS list: blocklist / allowlist, entries với domain, category, source.
- DNS rules: tùy chỉnh allow/block domain cụ thể, scope nullable.
- DNS query stats: count blocked/allowed, top domains.
- Provider: none / hosts-file / dnsmasq / unbound / adguardhome / pihole (agent execute tùy provider).
- Stats push từ agent qua `/api/gateway/dns`.
- Filtering list push từ control plane đến agent.

## Optimization

- 5 profile built-in với key cố định.
Mỗi profile có:
  - Tên, mô tả
  - DNS filtering level
  - Compression enabled
  - Media optimization
  - Latency priority
  - UDP stability
  - Low queueing
  - Aggressive filtering
  - Routing policy
  - Target saving range (min/max pct)

- Capability matrix: mỗi adapter báo capabilities, profile được mark supported/unsupported dựa trên missing capabilities.
- Assignment: gán profile cho device.
- Savings analytics: MEASURED (có đủ sample) vs ESTIMATED (DNS-blocked requests không đo byte-exact).

## Billing simulation

- Không payment processor, không implied.
- Công thức: `cost = base_fee + max(0, (bytes/1GB - free_quota)) * price_per_gb`
- Sử dụng actual bytes (optimized total khi có), không estimate.
- Cost records lưu埋, projections gated trên real history.
- Receipts: PDF (pdf-lib), QR code (qrcode), verify bằng receipt number.

## Audit log

- Mọi action quan trọng được record.
- Actor: USER / SYSTEM / GATEWAY / API_KEY.
- Result: SUCCESS / FAILURE / DENIED.
- Metadata: JSON, không chứa secret.
- Retention: 730 ngày mặc định.

## Settings

- SystemSetting model: typed key/value.
- Settings registry (`src/server/settings/definitions.ts`): mỗi key có category, description, Zod schema, default value.
- Secrets không nằm trong settings: chỉ từ environment.

## Cross-cutting concerns

### Crypto

- `src/server/lib/crypto.ts`: hash (SHA-256, scrypt), HMAC, AES-256-GCM encryption, safe equality (timing-safe).
- `ENCRYPTION_KEY` từ environment, 32 bytes base64.

### Logger

- `src/server/lib/logger.ts`: structured log, request ID, không log secret.

### Errors

- `src/server/lib/errors.ts`: typed errors, HTTP status mapping, không leak internal detail.

### IDs

- `src/server/lib/ids.ts`: cuid-style IDs, access code generation, token generation, safe equality.

### Time

- `src/server/lib/time.ts`: billing period calculation, date range resolution, elapsed days.

### Environment

- `src/server/config/env.ts`: Zod schema, lazy read (getEnv()), publicEnv() cho safe client values.

---

## Deployment architecture

Đ single-process:

```
┌─────────────────────────────────────────────────────┐
│                   Browser (dashboard)               │
│  ┌──────────────────────────────────────────────┐   │
│  │  Next.js app (static + RSC + client JS)      │   │
│  └──────────────────────────────────────────────┘   │
│  HTTP requests → /api/*                            │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│                  Control Plane (Next.js)            │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │  Auth    │  │  API     │  │  Realtime (SSE)  │   │
│  │  Service │  │  Routes  │  │  + Aggregator    │   │
│  └──────────┘  └──────────┘  └──────────────────┘   │
│       │                │                │            │
│       ▼                ▼                ▼            │
│  ┌──────────────────────────────────────────────┐   │
│  │              PostgreSQL (Prisma)              │   │
│  │  users, sessions, devices, nodes, configs,   │   │
│  │  traffic aggregates, quotas, costs, receipts │   │
│  └──────────────────────────────────────────────┘   │
│                         │                            │
│                         ▼ (HTTP)                   │
└─────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────┐
│             Data Plane Host (separator)             │
│  ┌──────────────┐  ┌─────────────────────────────┐ │
│  │  WireGuard   │  │  Xray daemon (optional)     │ │
│  │  / Xray      │  │                             │ │
│  └──────────────┘  └─────────────────────────────┘ │
│  ┌────────────────────────────────────────────────┐ │
│  │              Gateway Agent                      │ │
│  │  • Pull policy from control plane              │ │
│  │  • Apply policy locally                        │ │
│  │  • Push traffic, heartbeat, DNS stats         │ │
│  └────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

Multi-replica (optional):

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│  CP #1   │    │  CP #2   │    │  CP #3   │
│  (Next)  │    │  (Next)  │    │  (Next)  │
└──────────┘    └──────────┘    └──────────┘
     │               │               │
     └───────┬───────┘               │
             │  Redis pub/sub        │
             └───────────────────────┘
                     │
              (shared event stream)
```

Khi REDIS_URL được set, realtime bus dùng Redis pub/sub thay vì in-memory EventEmitter.
