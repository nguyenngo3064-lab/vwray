# VWRAY Control Plane

Hạ tầng điều khiển mạng / VPN: dashboard quản lý thiết bị, cổng (node), cấu hình, thống kê lưu lượng realtime, hạn mức (quota) được thực thi ở server, DNS filtering, profile tối ưu hóa, và mô phỏng billing + 영수증.

**Mục đích:** Single control plane cho vận hành network đa cổng, với telemetry trung thực, enforcement thực (chứ không chỉ badge UI), và simulated billing để đo năng lực tiết kiệm của optimization.

**Bài bản:** Control plane không mở socket VPN trực tiếp. Cổng dữ liệu (WireGuard / Xray) chạy riêng và giao tiếp với control plane qua giao thức agent HTTP — xem DEPLOYMENT.md và VPN_GATEWAY.md.

---

## Stack

| Lớp | Công nghệ | Phiên bản |
| --- | --- | --- |
| Frontend | Next.js (App Router, React Server Components) | 16.x |
| Ngôn ngữ | TypeScript | 5.9 |
| Styling | Tailwind CSS (CSS-first tokens) | v4 |
| Backend | Next.js Route Handlers + service layer src/server/ | — |
| Database | PostgreSQL + Prisma 7 (driver adapter) | 16 / 7.x |
| Realtime | SSE + in-memory bus (Redis pub/sub optional) | — |
| Billing | Giả lập (không payment processor) | — |
| Kiểm thử | Vitest + PostgreSQL real (TEST_DATABASE_URL) | — |
| Container | Docker Compose (control plane, postgres, mock gateway) | — |

---

## Cấu trúc source

```
src/
├── app/
│   ├── (console)/          # Dashboard operator
│   │   ├── devices/        # Quản lý thiết bị, phê duyệt, khóa
│   │   ├── nodes/          # Cổng VPN (WireGuard / Xray / mock)
│   │   ├── configurations/ # Cấu hình + credential
│   │   ├── dns/            # DNS filter: danh sách, thống kê, rule
│   │   ├── optimization/   # Profile tối ưu hóa
│   │   ├── quota/          # Hạn mức
│   │   └── _shared/        # Contract dữ liệu dùng chung
│   └── api/
│       ├── auth/           # Login access-code, session, logout
│       ├── health/         # Health check
│       ├── devices/        # CRUD device + bulk
│       ├── nodes/          # CRUD node + health
│       ├── configs/        # Cấu hình + payload credential
│       ├── dns/            # Lists, rules, stats
│       ├── optimization/   # Profiles, analytics
│       ├── quota/          # Quota CRUD, reset
│       ├── traffic/        # Lịch sử, export CSV
│       ├── gateway/        # Agent protocol
│       ├── realtime/       # SSE stream
│       ├── receipts/       # PDF, QR, verify
│       ├── billing/        # Cost records
│       ├── notifications/  # List + mark read
│       ├── overview/       # Dashboard overview
│       ├── data/           # Data overview
│       └── system/         # Status, maintenance
├── server/
│   ├── auth/               # Session, login, CSRF, rate-limit
│   ├── db/                 # Prisma client singleton
│   ├── lib/                # Crypto, logger, IDs, time, errors
│   ├── config/             # Env validation (Zod, lazy)
│   ├── settings/           # Typed key/value settings
│   ├── vpn/                # Adapter interface, WireGuard/Xray/Mock
│   ├── traffic/            # Collector, buffer, aggregator
│   ├── realtime/           # Bus + aggregator singleton
│   ├── quota/              # Engine: evaluate, enforce, reset
│   ├── dns/                # Lists, rules, stats
│   ├── optimization/       # Profile CRUD, analytics
│   ├── billing/            # Simulated cost computation
│   ├── receipts/           # PDF, QR, verify
│   ├── audit/              # Structured audit log
│   ├── notifications/      # Notification + webhook delivery
│   ├── security/           # Anomaly, API keys, SSRF, webhooks
│   ├── gateway/            # Policy resolution, agent auth
│   ├── analytics/          # Consumers, filters, overview
│   ├── system/             # Status endpoint
│   └── http/               # Guard, respond helpers
├── components/ui/          # primitives (server-safe) + interactive
└── lib/
    └── format/             # Byte/rate/duration formatting
```

---

## Cách chạy local

### Tiền đề

- Node.js >= 20.11.0 (môi trường dùng v24.21.0)
- PostgreSQL 16 — local instance hoặc Docker
- npm 11.19.0

### Bước 1: Cài đặt

```bash
git clone https://github.com/oswi3525-glitch/vwray.git
cd vwray
npm install
```

### Bước 2: Cấu hình môi trường

```bash
cp .env.example .env
```

Chỉnh .env theo thực tế. Biến bắt buộc (fail rõ ràng nếu thiếu):

| Biến | Ghi chú |
| --- | --- |
| DATABASE_URL | Connection string PostgreSQL |
| AUTH_SECRET | 32+ bytes base64 — `openssl rand -base64 48` |
| ENCRYPTION_KEY | 32 bytes base64 — `openssl rand -base64 32` |

Biến quan trọng khác:

| Biến | Giá trị mẫu | Ghi chú |
| --- | --- | --- |
| NODE_ENV | development | development / production / test |
| APP_URL | http://localhost:3000 | Origin công khai |
| SESSION_ABSOLUTE_TTL_MINUTES | 720 | TTL tối đa session |
| SESSION_IDLE_TTL_MINUTES | 120 | TTL idle |
| DEV_MOCK_GATEWAY_ENABLED | true | Cho phép mock gateway trong dev |
| BILLING_CURRENCY | VND | Tiền tệ |
| PRICE_PER_GB | 25000 | Đơn giá / GB (simulated) |
| BASE_FEE | 15000 | Phí cơ sở (simulated) |
| FREE_QUOTA_GB | 0 | Miễn phí |
| REALTIME_WINDOWS | 30,60,300,900 | Cửa sổ chart (giây) |
| TRAFFIC_FLUSH_INTERVAL_SECONDS | 10 | Tần suất flush raw sample ra DB |

### Bước 3: Khởi tạo database

```bash
npx prisma migrate dev    # Tạo migration + apply (dev)
npx prisma generate       # Generate Prisma Client (nếu cần)
```

### Bước 4: Chạy

```bash
npm run dev   # next dev -p 3000
```

Dashboard: **http://localhost:3000**

### First-boot

Khi database trống, control plane tự động tạo owner account + access code lần đầu. Access code được in ra server log và không thể lấy lại sau đó.

Lấy code:

```bash
npm run bootstrap   # tsx scripts/bootstrap.ts
```

> Production: vô hiệu hóa ALLOW_BOOTSTRAP_CODE_RETRIEVAL=false và lấy code từ log.

---

## API endpoints

### Authentication

| Phương thức | Đường dẫn | Ghi chú |
| --- | --- | --- |
| GET | /api/auth | Trạng thái: needsBootstrap, authenticated, user |
| POST | /api/auth | Login access code (body: { accessCode }) |
| POST | /api/auth/bootstrap | Lấy access code lần đầu (ALLOW_BOOTSTRAP_CODE_RETRIEVAL=true) |
| POST | /api/auth/logout | Đăng xuất |

CSRF bảo vệ bằng header x-vwray-csrf + cookie.

### Devices

| Phương thức | Đường dẫn | Ghi chú |
| --- | --- | --- |
| GET | /api/devices | Danh sách |
| POST | /api/devices | Tạo |
| GET | /api/devices/:id | Chi tiết |
| PATCH | /api/devices/:id | Cập nhật |
| DELETE | /api/devices/:id | Xóa |
| POST | /api/devices/bulk | Import bulk |

### Nodes

| Phương thức | Đường dẫn | Ghi chú |
| --- | --- | --- |
| GET | /api/nodes | List |
| POST | /api/nodes | Tạo |
| GET | /api/nodes/:id | Chi tiết |
| PATCH | /api/nodes/:id | Cập nhật |
| DELETE | /api/nodes/:id | Xóa |
| GET | /api/nodes/:id/health | Health check |

### Configs

| Phương thức | Đường dẫn | Ghi chú |
| --- | --- | --- |
| GET | /api/configs | List |
| POST | /api/configs | Tạo |
| GET | /api/configs/:id | Chi tiết |
| PATCH | /api/configs/:id | Cập nhật |
| DELETE | /api/configs/:id | Xóa |
| GET | /api/configs/:id/payload | Credential payload |

### Traffic

| Phương thức | Đường dẫn | Ghi chú |
| --- | --- | --- |
| GET | /api/traffic | Lịch sử (agg) |
| GET | /api/traffic/consumers | Top consumer |
| GET | /api/traffic/export | Export CSV |

### Gateway (agent protocol)

| Phương thức | Đường dẫn | Ghi chú |
| --- | --- | --- |
| GET | /api/gateway/policy | Agent pull policy |
| POST | /api/gateway/policy/ack | Agent acknowledge |
| POST | /api/gateway/traffic | Agent push traffic |
| POST | /api/gateway/heartbeat | Agent heartbeat |
| POST | /api/gateway/dns | Agent push DNS stat |
| GET | /api/gateway/sessions | Session status |

### Realtime

| Phương thức | Đường dẫn | Ghi chú |
| --- | --- | --- |
| GET | /api/realtime/stream | SSE: traffic.tick, system.status, notification, quota.update, device.update, node.update |

### DNS

| Phương thức | Đường dẫn | Ghi chú |
| --- | --- | --- |
| GET | /api/dns | DNS overview |
| GET | /api/dns/lists | List lists |
| POST | /api/dns/lists | Tạo list |
| GET | /api/dns/lists/:id | Chi tiết |
| PATCH | /api/dns/lists/:id | Update list + entries |
| DELETE | /api/dns/lists/:id | Xóa |
| GET | /api/dns/stats | Statistics |
| POST | /api/dns/rules | Tạo rule tùy chỉnh |

### Optimization

| Phương thức | Đường dẫn | Ghi chú |
| --- | --- | --- |
| GET | /api/optimization | List profile + capability matrix |
| PATCH | /api/optimization/profiles/:id | Update profile |
| GET | /api/optimization/analytics | Savings analytics |

### Quota

| Phương thức | Đường dẫn | Ghi chú |
| --- | --- | --- |
| GET | /api/quota | List |
| POST | /api/quota | Tạo |
| GET | /api/quota/:id | Chi tiết |
| POST | /api/quota/:id/reset | Reset quota → mở device lại |

### Billing & Receipts

| Phương thức | Đường dẫn | Ghi chú |
| --- | --- | --- |
| GET | /api/receipts | List |
| POST | /api/receipts | Tạo |
| GET | /api/receipts/:id | Chi tiết |
| GET | /api/receipts/:id/pdf | Generate PDF |
| GET | /api/receipts/:id/qr | QR code |
| GET | /api/receipts/verify/:receiptNumber | Verify receipt number |

### System

| Phương thức | Đường dẫn | Ghi chú |
| --- | --- | --- |
| GET | /api/health | Health check |
| GET | /api/system/status | System status |
| GET | /api/overview | Dashboard overview |
| GET | /api/data/overview | Data overview |

### Notifications

| Phương thức | Đường dẫn | Ghi chú |
| --- | --- | --- |
| GET | /api/notifications | List |
| POST | /api/notifications/read | Mark read |

---

## Mô hình data

PostgreSQL, quản lý bởi Prisma 7. Schema: prisma/schema.prisma.

Model quan trọng:

- AdminUser — operator account (OWNER / ADMIN / ANALYST / VIEWER)
- AccessCode — mã phà đăng nhập, hash (scrypt), không plaintext
- AdminSession — session lưu server-side, revoked là chính
- VpnNode — cổng VPN: protocol, adapterKey, isRealGateway
- Device — thiết bị: approvalState, connectionStatus, securityState
- VpnConfig / ConfigCredential — cấu hình + credential (encrypted tại rest)
- GatewayPolicyState — policy enforcement: state, revision, ackedAt — agent pull để áp dụng thật
- TrafficAggregate — lưu lượng aggregate theo dimension
- Quota — hạn mức: scope, limitBytes, usedBytes, period
- CostRecord — simulated billing record
- Receipt — 영수증: number, status, PDF
- DnsList / DnsListEntry / DnsQueryStat — DNS filtering
- OptimizationProfile / OptimizationRecord — profile + savings
- AnomalyEvent — detected anomaly (neutral)
- Notification — notification
- AuditLog — structured audit trail
- SystemSetting — typed key/value settings
- WebhookEndpoint — outbound webhook (SSRF-guarded)
- MaintenanceRun — retention/cleanup job log

> DataSource (REAL / MOCK) discriminatory mọi measurement.
> MeasurementKind (MEASURED / ESTIMATED) discriminatory optimization numbers.

---

## Bảo mật

- Credential hash (scrypt), không plaintext.
- Session token SHA-256 digest, lưu server-side, revoked là chính.
- CSRF: header x-vwray-csrf + cookie phải khớp session.
- Rate-limit + lockout chống brute-force.
- VPN credential encrypted tại rest (AES-256-GCM).
- Quota exceeded → transaction đóng sessions, update GatewayPolicyState, agent block peer thực.
- Mock traffic label MOCK, refused ở production.
- SSRF guard: webhook URL phải https, không private.
- Headers: CSP, X-Frame-Options: DENY, X-Content-Type-Options: nosniff, Referrer-Policy, HSTS.

---

## Phát triển

### Test

```bash
npm run test          # vitest run
npm run test:watch    # vitest
```

Test suite chạy PostgreSQL thực (TEST_DATABASE_URL). Migrations apply bởi global setup trước khi chạy suite.

### Lint & typecheck

```bash
npm run lint
npm run typecheck
```

### Production build

```bash
npm run build   # prisma generate && next build
npm run start   # next start -p 3000
```

### Docker

```bash
docker compose up -d                     # control plane + postgres
docker compose -f docker-compose.mock.yml up -d   # thêm mock gateway
```

Xem DEPLOYMENT.md để chi tiết.

---

## Chức năng chính

### 1. Authentication & Session

- Login bằng access code (scrypt hash).
- First-boot tự động tạo owner + access code.
- Session lưu server-side, revoke là chính, CSRF protection.
- Rate-limit & lockout chống brute-force.
- Role-based: OWNER > ADMIN > ANALYST > VIEWER.

### 2. VPN Nodes & Adapter

- Hỗ trợ WireGuard (local dev / agent production) và Xray (VLESS / VMESS / Trojan).
- Adapter interface chung VpnAdapter.
- Capability reporting thật: adapter báo byteAccounting: counters hay none.
- Mock gateway chỉ ở development, refused ở production.

### 3. Devices

- approvalState (PENDING/APPROVED/REJECTED/BLOCKED), connectionStatus, securityState.
- Private mode: device mới mặc định PENDING.
- Bulk import.

### 4. Configs & Credentials

- Config chứa credential material.
- Credential encrypted tại rest.
- Payload route trả config đầy đủ cho client.

### 5. Traffic & Realtime

- Collector nhận sample, resolve device qua credential.
- Buffer raw sample, flush batch ra PostgreSQL.
- Realtime aggregator tính rate, maintain sliding ring buffer, publish qua SSE bus.
- Dashboard SSE nhận traffic.tick, system.status, v.v.
- Status thật: stale khi gateway im lặng, mock khi chỉ có mock feed, live khi real.

### 6. Quota Engine

- Evaluation trong traffic ingest path, server-side.
- Vượt quota: transaction đóng sessions, đánh dấu device, update policy, notification.
- Policy gửi agent → agent block peer thực.
- Reset quota: xoá usedBytes, clear block, ack policy.

### 7. DNS Filtering

- DNS list: blocklist / allowlist, entries, categories.
- DNS rules tùy chỉnh.
- DNS query stats: blocked/allowed count, top domains.
- Provider: none / hosts-file / dnsmasq / unbound / adguardhome / pihole.
- Push đến agent qua /api/gateway/dns.

### 8. Optimization Profiles

- 5 profile built-in: BALANCED, DATA_SAVER, GAMING, VIDEO_SAVER, MAXIMUM_SAVING.
- Capability matrix theo adapter.
- Assignment cho device, savings report.
- Honest savings: chỉ claim actual khi có đủ sample.

### 9. Simulated Billing & Receipts

- Công thức: cost = base_fee + max(0, (bytes/1GB - free_quota)) * price_per_gb.
- Sử dụng actual bytes (optimized total khi có).
- Cost records lưu埋, projections gated trên real history.
- Receipts: PDF, QR, verify.

### 10. Anomaly Detection & Notifications

- Anomaly detection trên aggregated traffic + node telemetry.
- Notification types: node.offline, node.recovered, quota.warning, quota.exceeded, anomaly.detected, config.revoked, device.approved/rejected, auth.failures, optimization.changed.
- Delivery: SSE bus + optional webhook (SSRF-guarded, HMAC-signed).

### 11. Audit Log

- Mọi action quan trọng được record.
- Retention: 730 ngày mặc định.

---

## Environment biến

Xem .env.example để biết toàn bộ biến.

Các nhóm:

- Core: NODE_ENV, APP_URL, WEBSOCKET_URL, DATABASE_URL, DATABASE_POOL_MAX
- Auth: AUTH_SECRET, ENCRYPTION_KEY, session TTL, rate-limit params, ALLOW_BOOTSTRAP_CODE_RETRIEVAL
- VPN data plane: VPN_API_URL, VPN_API_KEY, GATEWAY_AGENT_TOKEN, GATEWAY_MAX_CLOCK_SKEW_SECONDS, DEV_MOCK_GATEWAY_ENABLED, DEV_MOCK_GATEWAY_BPS
- DNS: DNS_PROVIDER, DNS_PROVIDER_URL, DNS_PROVIDER_API_KEY
- Billing simulation: BILLING_CURRENCY, PRICE_PER_GB, BASE_FEE, FREE_QUOTA_GB, BILLING_PERIOD, BILLING_PERIOD_START_DAY
- Realtime: REALTIME_WINDOWS, REALTIME_BUFFER_SECONDS, TRAFFIC_FLUSH_INTERVAL_SECONDS
- Retention: TRAFFIC_RAW_RETENTION_DAYS, TRAFFIC_AGGREGATE_RETENTION_DAYS, AUDIT_LOG_RETENTION_DAYS, DNS_STAT_RETENTION_DAYS
- Multi-instance: REDIS_URL (optional)
- Gateways: WG_INTERFACE, WG_CONFIG_PATH, XRAY_API_URL, XRAY_CONFIG_PATH
- Webhooks: ALERT_WEBHOOK_URL, ALERT_WEBHOOK_SECRET

---

## License

Project này là private. Không phân phối công khai.
