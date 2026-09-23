# VWRAY — Bảo mật

## Mô hình mối đe dọa

VWRAY là control plane cho mạng/VPN. Mối đe dọa chính:

1. **Credential theft** — access code / password / VPN credential bị lấy
2. **Session hijack** — session token bị giả mạo hoặc đánh cắp
3. **CSRF** — request giả mạo từ domain khác
4. **Brute-force** — tấn công mật mã hoặc access code
5. **Privilege escalation** — user thường trở thành admin
6. **Data exfiltration** — credential material, audit log, cost records bị dump
7. **Enforcement bypass** — device vượt quota mà không bị block
8. **SSRF** — webhook URL trỏ đến internal service
9. **Mock pollution** — mock traffic nhầm thành real trong production
10. **Unauthenticated gateway ingest** — agent không авторизован push traffic
11. **Clickjacking / XSS / MIME sniffing** — attack vector từ browser

## Mitigation

### Credential storage

| Loại | Cách lưu | Notes |
| --- | --- | --- |
| Access code | scrypt hash | Không plaintext, không recoverable sau khi tạo |
| Operator password | scrypt hash | Không plaintext |
| Session token | SHA-256 digest (lưu trong cookie) | Không plaintext, revoked là chính |
| CSRF secret | SHA-256 digest (lưu server-side) | Derived từ session token |
| VPN credential (private key, UUID, password) | AES-256-GCM encrypt | ENCRYPTION_KEY từ environment, không bao giờ gửi client |

### Session

- Session lưu server-side (AdminSession trong PostgreSQL).
- Revoked là chính: session được đánh dấu revokedAt, không chỉ expired.
- Idle TTL và absolute TTL đều được enforce.
- Session token SHA-256 digest: không reveal raw token trong log hay response.

### CSRF

- Mọi request không-GET yêu cầu CSRF verification.
- Mechanism: header `x-vwray-csrf` + cookie csrf, cả hai phải khớp session hiện tại.
- Cookie CSRF và header CSRF derived từ cùng session token + session csrfSecret.
- Stale cookie từ session cũ không thể replay được.
- Cross-site form post không thể forge header.

### Brute-force protection

| Biến | Mặc định | Ghi chú |
| --- | --- | --- |
| AUTH_MAX_ATTEMPTS_PER_WINDOW | 8 | Số attempt tối đa trong window |
| AUTH_ATTEMPT_WINDOW_MINUTES | 15 | Chiều dài window (phút) |
| AUTH_LOCKOUT_MINUTES | 15 | Thời gian lockout sau khi vượt limit |

- Failed attempts được đếm theo credential và theo IP.
- Lockout được enforce trong login path.

### Rate limiting

- `checkHotBucket` trong `src/server/auth/rate-limit.ts`: kiểm tra xem credential/IP đang trong hot bucket không.
- Traffic collector cũng check rate limit trước khi accept sample.

### Enforcement thật

- Quota exceeded → transaction đóng sessions, update GatewayPolicyState, send notification.
- GatewayPolicyState được agent pull, agent block peer thực.
- Không chỉ badge UI: data plane là thứ từ chối connection.
- Policy revision bumped khi state change, agent nhận biết change.

### Mock traffic

- Mock traffic được label DataSource = MOCK, không bao giờ bị nhầm là real.
- Mock ingest bị refused trong production bất kể settings.
- Mock ingest bị refused ngoài development trừ khi operator opt-in.
- UI hiển thị DEV badge khi mock feed active.

### API key cho gateway agent

- Mỗi node có per-node API token (hash tại rest).
- Node-scoped authorisation: token liên kết với node cụ thể.
- Timestamp skew rejection: payload với clock khác control plane quá GATEWAY_MAX_CLOCK_SKEW_SECONDS bị reject.
- Payload validation: thiết bị trước khi accept.

### SSRF guard

- Webhook URL phải https.
- Webhook URL không được resolve đến private address.
- SSRF guard check cả lúc write và lúc send.

### Webhook security

- Webhook secret được sealed encrypt (AES-256-GCM) trong database.
- HMAC headers sent với webhook delivery.

### Headers

- CSP: ngăn script inject từ source ngoài.
- X-Frame-Options: DENY — ngăn clickjacking.
- X-Content-Type-Options: nosniff — ngăn MIME sniffing.
- Referrer-Policy:ควบคุม referrer information.
- HSTS: production only.

### Secrets management

- Không secret trong database: AUTH_SECRET, ENCRYPTION_KEY, GATEWAY_AGENT_TOKEN, VPN_API_KEY, ALERT_WEBHOOK_SECRET — tất cả từ environment.
- Secrets không bao giờ serialized đến client.
- publicEnv() chỉ expose safe values.

## Security audit log

- Mọi authentication attempt, CSRF failure, quota enforcement, policy change, config change, receipt issuance được audit.
- Audit log retention: 730 ngày mặc định.
- Audit log không chứa secret (metadata được sanitise).

## Không làm

- Không store plaintext credential.
- Không send private key / API secret đến client.
- Không accept mock traffic trong production.
- Không claim savings không có data đo.
- Không show 0 bps khi gateway stale — hiển thị "Gateway unavailable" thay vì.
- Không generate configuration cho client chưa support format đó.

## Báo cáo lỗ hổng

Đ contact bộ phận bảo mật, sử dụng kênh chính thức của tổ chức.
