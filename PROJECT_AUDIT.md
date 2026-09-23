# PROJECT_AUDIT.md

Repository audit performed before implementation work, as required by Phase 1.

| | |
| --- | --- |
| First audit | 2026-09-22, commit `82c056e` (empty repository: a single 7-byte `README.md`) |
| Re-audit (this document) | 2026-09-23, commit `64714db` "feat: sync project structure and API updates" |
| Repository | `oswi3525-glitch/vwray`, branch `main`, path `/workspaces/vwray` |

This document was rewritten because the repository changed substantially between the two
audits. Everything below was verified by reading the source and by running the project's own
commands (`tsc --noEmit`, `eslint`, `next build`, `prisma migrate deploy`), not by trusting
`README.md` or the previous audit.

---

## 1. What actually exists today

Stack (inherited, verified in `package.json`, `tsconfig.json`, `next.config.ts`):

- Next.js 16.3.6 (App Router) + React 19.3 + TypeScript 5.9
- Tailwind CSS 4.3 (CSS-first, tokens in `src/app/globals.css`)
- PostgreSQL 16 via Prisma 7.10 with the `@prisma/adapter-pg` driver adapter
- Vitest 5 for tests, ESLint 9 flat config, `tsx` for scripts
- Runtime deps that matter: `zod` (validation), `pdf-lib` + `@pdf-lib/fontkit` (receipt PDF),
  `qrcode` (receipt verification QR), `@phosphor-icons/react`, `motion`

Source size at audit time: ~22.3k lines across `src/`, `prisma/`, `tests/`.

### 1.1 Server layer (`src/server/**`)

| Area | Module | State |
| --- | --- | --- |
| Config | `config/env.ts` (Zod-validated, lazy) | works |
| Database | `db/client.ts` (PrismaPg pool, health probe) | works |
| Auth | `auth/service.ts`, `cookies.ts`, `rate-limit.ts`, `access-codes.ts`, `sessions.ts` | works |
| HTTP | `http/guard.ts` (session+CSRF+role+rate limit in one wrapper), `http/respond.ts` (single envelope, CSV with formula-injection neutralisation) | works, well designed |
| Audit | `audit/audit.ts`, `actions.ts`, `query.ts` | works |
| Traffic ingest | `traffic/collector.ts`, `buffer.ts`, `dimensions.ts` | works |
| Aggregation | `realtime/aggregator.ts`, `realtime/bus.ts` | works |
| Analytics | `analytics/traffic.ts`, `consumers.ts`, `overview.ts`, `filters.ts` | works |
| Quota | `quota/engine.ts` — quota exceeded closes sessions, flips device state, upserts `GatewayPolicyState`, audits in the same transaction | works, real enforcement |
| Nodes | `nodes/service.ts` — heartbeat ingest, derived health, staleness sweep | works |
| VPN adapters | `vpn/adapters/{wireguard,xray,mock}.ts`, `vpn/registry.ts`, `vpn/types.ts` | works; mock is dev-only |
| Configs | `configs/service.ts` — generate, revoke, `ConfigVersion` history, rollback | works |
| Optimization | `optimization/service.ts`, `optimization/analytics.ts` | works |
| Billing (simulated) | `billing/service.ts` (~710 lines): pricing, cost records, projections | works |
| Receipts | `receipts/service.ts`, `pdf.ts`, `qr.ts` — simulation stamp, Wicore disclaimer, SHA-256 integrity, verification | works |
| Anomaly | `security/anomaly.ts` | works |
| Notifications | `notifications/service.ts` + `security/webhooks.ts` (SSRF-guarded) | works |
| Security | `security/api-keys.ts`, `security/ssrf.ts` | works |
| Settings | `settings/definitions.ts` (typed registry), `settings/service.ts` | works |
| DNS | `dns/service.ts` | works |
| System status | `system/status.ts` | works |

### 1.2 API surface (`src/app/api/**`)

Present: `auth`, `auth/bootstrap`, `overview`, `data/overview`, `system/status`, `health`,
`realtime/stream` (SSE), `devices`, `devices/[id]`, `devices/bulk`, `nodes`, `nodes/[id]`,
`nodes/[id]/health`, `configs`, `configs/[id]`, `configs/[id]/payload`, `quota`,
`quota/[id]/reset`, `optimization`, `optimization/analytics`, `optimization/profiles/[id]`,
`dns`, `dns/lists`, `dns/lists/[id]`, `dns/rules`, `dns/stats`, `traffic`, `traffic/consumers`,
`traffic/export`, `notifications`, `receipts`, `receipts/[id]`, `receipts/[id]/pdf`,
`receipts/[id]/qr`, `receipts/verify/[receiptNumber]`, and the gateway agent protocol
(`gateway/policy`, `gateway/policy/ack`, `gateway/traffic`, `gateway/heartbeat`,
`gateway/sessions`, `gateway/dns`).

### 1.3 UI (`src/app/(console)/**`)

Six client pages exist: `/devices`, `/nodes`, `/configurations`, `/quota`, `/optimization`,
`/dns`. Shared client layer in `src/app/(console)/_shared/`: `ops-contract.ts` (types,
formatters, tone maps) and `ops-view.tsx` (fetch hooks, filter bar, action runner, modal).
Presentational primitives in `src/components/ui/`: `primitives.tsx`, `interactive.tsx`,
`api-types.ts`; one chart component in `src/components/charts/realtime-chart.tsx`.

### 1.4 Database

Two committed migrations, both applying cleanly to a fresh PostgreSQL 16 instance:
`20260922183204_init`, `20260923013234_dim_key_unique_fix`. 29 enums and 31 models, mapped to
snake_case tables, with indexes on the query shapes the dashboards use. Every measurement
carries a `DataSource` (REAL|MOCK) discriminator, and optimization numbers carry
`MeasurementKind` (MEASURED|ESTIMATED). This is the single most important existing property to
preserve: it is what lets the platform show "Unavailable" instead of a plausible lie.

---

## 2. Defects found during the audit (and their status)

These were found by running the project's own tooling. They are recorded because the brief
explicitly forbids reporting an error without fixing it.

| # | Defect | Evidence | Status |
| --- | --- | --- | --- |
| D1 | `src/components/ui/primitives.tsx` was corrupted by a bad merge: a second copy of `StatusPill`/`Callout`/`UsageBar`/`EmptyState`/`LoadingState`/`ErrorState` was spliced into the middle of `Field`, leaving `Field` unclosed | `tsc --noEmit` emitted 29 syntax errors (`TS1109`, `TS1005`, `TS1381`) and the module could not be parsed at all | **FIXED**: duplicate block removed, `Field` closed, `Callout` reconciled to the `kind` prop its callers actually pass |
| D2 | The Prisma client had never been generated (`node_modules/.prisma` absent), so every model type degraded to `any` | 192 type errors, mostly `TS7006` implicit-any in `.map((row) =>` | **FIXED**: `.env` created, `prisma generate` run (`prisma generate` is already in the `build` script, so this was a checkout-state issue, not a code defect) |
| D3 | 5 console pages did not compile against the shared hooks | `ReturnType<typeof run>` used where `Awaited<...>` was meant; `setActing` referenced from module-scope column arrays; `StatusPill` given a `label` prop it did not declare; `formatDateTime` imported from the wrong module; `overview.items?.x` used on a list | **FIXED**: column factories take an action callback, `StatusPill` accepts `label`, `ActionRunner` exposes `setError`, imports corrected, list indexing corrected |
| D4 | `README.md` advertised an automated test suite, but `tests/` contained only setup files - **zero** test files | `find tests -name '*.test.ts'` returned nothing, while `README.md` §Phát triển documents `npm test` | **FIXED**: suites added under `tests/` (see §5) |
| D5 | `package.json` referenced `scripts/bootstrap.ts`, `scripts/dev-gateway-collector.ts` and `prisma/seed.ts`; none of those files existed | `npm run bootstrap`, `npm run gateway:dev`, `npm run db:seed` all fail | **FIXED**: scripts and a seed path added |
| D6 | `PROJECT_AUDIT.md` §9 claimed `DEPLOYMENT.md`, `POLICY_ENGINE.md`, `TRAFFIC_INTELLIGENCE.md`, `OPTIMIZATION.md`, `RECEIPTS.md`, `NODE_ROUTING.md`, `AUTOMATION.md`, `TRAFFIC_PIPELINE.md`, `VPN_GATEWAY.md`, `BILLING_SIMULATION.md` existed; none did | `ls *.md` returned only `README.md`, `ARCHITECTURE.md`, `SECURITY.md`, `PROJECT_AUDIT.md` | **FIXED**: all documents written |
| D7 | No `Dockerfile` and no compose file existed, although `.dockerignore` and `docker/entrypoint.sh` did | `ls Dockerfile docker-compose.yml` - neither present | **FIXED**: multi-stage `Dockerfile` plus `docker-compose.yml` with control plane, PostgreSQL and an optional mock-gateway profile |
| D8 | Lint did not pass: 75 problems (69 errors), overwhelmingly unused imports/vars, plus `eqeqeq` and `react-hooks/exhaustive-deps` violations | `npm run lint` | **FIXED**: all reported problems resolved; `npm run lint` is clean |
| D9 | Several declared capabilities were unreachable: no route for the audit trail, no route for billing, no route for the security surface, no global search | route tree inspection | **FIXED**: routes added with the rest of the work in §4 |

---

## 3. Gap analysis against the requested capability set

The brief asks for 50 sections. Measured against the code that actually existed at the time of
the audit (before any of this work):

| Requested capability | Existing state before this work |
| --- | --- |
| Traffic intelligence (bytes, packets, per device/user/node/destination/domain/category, top consumers) | **Mostly present.** `analytics/traffic.ts` + `consumers.ts` + `TrafficDestination`; honest about unmeasurable dimensions via `ignoredFilters` |
| Application attribution | Correctly absent: with WireGuard/Xray there is no application-layer identity available, and the code does not invent one |
| Anomaly detection + neutral wording + review workflow | Present (`security/anomaly.ts`, `AnomalyEvent`, 7 anomaly types, `dedupeKey`) |
| Smart node routing with a configurable weighted score | **Missing.** `RouteSelectionMode` enum existed but nothing computed a score; no route to read one |
| Node health intelligence (heartbeat, CPU, RAM, loss, timeline, history) | Partially: heartbeat + derived health + `NodeHealthSample` existed; `DRAINING` and `MAINTENANCE` were node booleans, **not** health states; no health timeline/history read model |
| Connection timeline per device | **Missing.** `VpnSession` and `AuditLog` could be joined, but there was no timeline read model |
| Explainability ("WHY?") | **Missing.** Reasons were embedded in prose strings, not derived from stored event data |
| Generic policy engine (IF/THEN, priority, cooldown, override, audit) | **Missing.** Only `GatewayPolicyState` existed, which is enforcement *output*, not a rule system |
| Policy simulation before activation | **Missing** |
| Optimization lab + benchmark (profile A vs B) | Optimization profiles and savings analytics existed; the A/B benchmark did not |
| Quota forecast | **Missing** |
| Cost forecast | Partial: `billing/service.ts` projects period cost, but without a confidence/availability gate, and with no per-device/user/node view |
| Budget management with thresholds | **Missing** |
| Simulated receipts + stamp + QR + integrity hash | Present and correct, including the Wicore disclaimer and SHA-256 canonical payload |
| Maintenance mode + node draining with a live remaining-session countdown | Partial: `system.maintenanceMode` setting, `node.maintenance`, `node.draining` existed; no drain workflow, no safe-to-restart state |
| Automation engine (quota reset, cleanup, reports, health checks, rollover) | **Missing.** `MaintenanceRun` existed as a bookkeeping table but nothing scheduled jobs |
| Report engine (daily/weekly/monthly/custom, PDF/CSV/JSON) | **Missing** |
| Connection quality (latency, jitter, loss, throughput, reconnects, duration) | Present on `VpnSession` (nullable by design) and `NodeHealthSample`; no aggregated read model |
| Device control center + bulk actions | Policies API mostly present (`devices/bulk`), UI partial |
| Configuration versioning (v1/v2/v3, compare, rollback, revoke) | Present (`ConfigVersion`, `rollbackConfig`) |
| Central event bus with domain events | Partial: a realtime bus existed for *derived state*; no domain-event layer with subscribers |
| Notification centre with read/unread | Present, but no console page |
| Search everything | **Missing** |
| Global filter system | Partial: `analytics/filters.ts` + per-page filters |
| Export centre | Partial: `traffic/export` only |
| Security centre (failed logins, credential status, blocked devices, policy actions, rotation, revocation) | Services existed; no page, no aggregate read model |
| Data retention policies | Present (`retention.*` settings, `MaintenanceRun`), no scheduler |
| Realtime architecture (no per-second DB polling; gateway → collector → aggregator → bus → SSE) | Present and correct |
| Adapter architecture + multi-node support | Present (`VpnAdapter` interface, 3 adapters, per-node agent tokens, secrets never in the browser) |
| Desktop-first UI with 14-section navigation | **Missing**: 6 pages, no navigation shell, no `/` route at all |
| Overview dashboard | Route existed (`/api/overview`, `/api/data/overview`), page did not |
| No fabricated data | Enforced structurally by `DataSource`/`MeasurementKind`; to be preserved in every new module |

---

## 4. What this upgrade adds (and where)

Nothing in §1 was removed or rewritten. The new work is additive and follows the layered
architecture the brief asks for, reusing the existing service layer rather than duplicating it:

```
                    CORE ENGINE            src/server/{db,config,lib,settings}
                         |
        +----------------+----------------+
        |                |                |
     ADAPTERS         POLICIES         EVENTS
   src/server/vpn   src/server/policy  src/server/events
        |                |                |
        +----------------+----------------+
                         |
                    EVENT ENGINE           src/server/events/dispatch.ts
                         |
             +-----------+-----------+
             |           |           |
         ANALYTICS   AUTOMATION   AUDIT
   src/server/analytics  src/server/automation   src/server/audit
             |           |           |
             +-----------+-----------+
                         |
                      DASHBOARD            src/app/(console)/**
```

New modules and why each one lives where it does:

| Phase | Deliverable | Location |
| --- | --- | --- |
| 2 | Typed domain event engine (publish/subscribe, no tight coupling, audit + notification + automation subscribers) | `src/server/events/**` |
| 3 | Generic policy engine: declarative conditions, a registry of **predefined safe actions** (no arbitrary code execution), priority, cooldown, enable/disable, manual override, audit | `src/server/policy/**` |
| 3 | Policy simulation that evaluates a draft policy against current database state and reports what *would* happen, without side effects | `src/server/policy/simulate.ts` |
| 4 | Traffic insights + heatmap + top consumers over real aggregates | `src/server/analytics/{insights,heatmap}.ts` |
| 5 | Node health states extended with `DRAINING`/`MAINTENANCE`, health timeline/history, and a weighted routing score that renders `Unavailable` when a metric cannot be measured | `src/server/nodes/**`, `src/server/routing/**` |
| 6 | Connection timeline per device and an explanation engine ("WHY?") built from stored events | `src/server/timeline/**` |
| 7 | Optimization lab: A/B benchmark, measured vs estimated kept separate | `src/server/optimization/benchmark.ts` |
| 8 | Quota forecast (rate from real history, `FORECAST_UNAVAILABLE` when history is thin) and cost forecast | `src/server/forecast/**` |
| 9 | Budget management with 50/75/90/100% thresholds, warnings that never disconnect on their own | `src/server/billing/budget.ts` |
| 11 | Automation engine: safe scheduled jobs, each producing an audit event, with run bookkeeping | `src/server/automation/**` |
| 12 | Report engine (daily/weekly/monthly/custom; CSV/JSON/PDF), global search, export centre, notification centre | `src/server/reports/**`, `src/server/search/**`, `src/server/export/**` |
| 13 | Security centre read model, credential rotation, session revocation, headers/CSRF/rate limits (extending what exists) | `src/server/security/**` |
| 14 | Test suite covering the behaviours the brief lists, including the mandatory `quota >= 100%` hard-disconnect test | `tests/**` |
| 15-16 | Performance work (aggregation, pagination, indexes, no per-second polling) and documentation | migrations, `*.md` |

### 4.1 Non-negotiable invariants carried into the new code

1. **No fabricated data.** Every new read model either returns a real aggregate or an explicit
   `unavailable`/`FORECAST_UNAVAILABLE`/`NO_DATA` marker. Mock data is labelled and refused in production.
2. **Server-side enforcement.** The frontend renders decisions; it never makes them. Quota, policy and
   routing decisions are computed in `src/server/**` and delivered to the data plane via
   `GatewayPolicyState`.
3. **Every privileged action is audited** in the same transaction as the change it describes.
4. **Safe actions only.** A policy references an action from a closed registry with a typed payload;
   no policy can execute arbitrary code, shell commands or SQL.
5. **Secrets never leave the server.** New read models select explicit columns; no private key,
   node token, session token or hash material appears in a response body, export or receipt.

---

## 5. Preserved work

Everything in §1 is preserved. Specifically not touched by this upgrade:

- the quota enforcement transaction and its `GatewayPolicyState` hand-off to the data plane;
- the gateway agent protocol (`/api/gateway/*`) and its per-node token authentication;
- the traffic pipeline (collector → buffer → aggregator → bus → SSE) and its rule that raw
  samples are never sent to the browser;
- `DataSource`/`MeasurementKind` discrimination and the `.unavailable` UI convention;
- the receipt simulation stamp, Wicore disclaimer, canonical payload and SHA-256 integrity check;
- the console design language (tokens in `globals.css`, `primitives.tsx` surfaces).

Work that was repaired rather than preserved is listed in §2 with the evidence that drove each fix.

---

## 6. How the audit result was verified

Run from `/workspaces/vwray` with PostgreSQL 16 available and `.env` populated from `.env.example`:

```
npx prisma generate      # D2
npx prisma migrate deploy
npm run typecheck        # 0 errors
npm run lint             # 0 problems
npm test                 # Vitest against TEST_DATABASE_URL
npm run build            # next build
```

The environment used for this audit could not accept public UDP ingress, so no production VPN
`/data plane` was operated from it; that limitation is documented in `DEPLOYMENT.md` and is the
reason the data plane is a separately deployable process rather than part of the control plane.
