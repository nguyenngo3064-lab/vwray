# PROJECT_AUDIT.md

Repository audit performed before any implementation work, as required by Phase 1.
Audit date: 2026-09-22
Repository: `oswi3525-glitch/vwray` (branch `main`, commit `82c056e` "Initial commit")
Audited path: `/workspaces/vwray`

---

## 1. Current architecture

The repository contained **no application code**. The complete tracked tree at audit time:

```
/workspaces/vwray
├── .git/
└── README.md          (7 bytes, content: "# vwray")
```

| Aspect | Finding |
| --- | --- |
| Framework | None. No `package.json`, no `next.config.*`, no bundler config. |
| Package manager | Undetermined by the repo. Resolved to **npm 11.19.0** (present in the environment). `pnpm` and `yarn` were also available but unused. |
| Language | None. No `tsconfig.json`, no TypeScript or JavaScript sources. |
| API routes | None. |
| Database | None. No ORM, no schema, no migrations, no connection configuration. |
| Authentication | None. |
| Components | None. No design system, no styling, no assets. |
| Environment variables | None. No `.env`, no `.env.example`. |
| Deployment config | None. No Dockerfile, no compose file, no platform manifests (`railway.json`, `render.yaml`, `Procfile`). |
| CI/CD | None. No `.github/workflows`. |
| Tests | None. No test runner, no test files. |
| Lint / format | None. No ESLint or Prettier config. |
| Reusable code | **None.** There is nothing to preserve. |
| License / ownership docs | None. |

Conclusion: this is a **greenfield build on an empty repository**. There is no legacy
behaviour to preserve and no migration risk from existing code. The "do not blindly
overwrite existing functionality" constraint from the brief is satisfied trivially and is
recorded here as a verified fact rather than an assumption.


### 1.1 Runtime capabilities verified in the build environment

These were probed during the audit because they gate design decisions:

| Capability | Result | Consequence for the build |
| --- | --- | --- |
| Node.js | `v24.21.0` | Modern runtime; native `node:crypto`, Web Streams and top-level `await` all available. |
| npm | `11.19.0` | npm used as the package manager, lockfile committed. |
| Docker engine | Present and usable (client `29.8.0`, daemon responding) | Docker artefacts are real and testable, not decorative. `postgres:16-alpine` pulled successfully. |
| PostgreSQL | Provisioned locally in a disposable container for development and verification | Primary transactional database, matching the production target. |
| Outbound network | Available (npm registry + GitHub reachable) | Dependencies, Prisma engines and the UI skill could be installed for real. |
| Public UDP ingress | **Not available** in this environment | A production VPN data plane cannot be honestly operated from here. This is documented as a platform limitation and is the reason the data plane is a separate, deployable process rather than part of the control plane. |

---

## 2. Existing stack

None. The stack was therefore **chosen**, not inherited, and is recorded in
`ARCHITECTURE.md`. Summary of the decision:

- **Frontend:** Next.js 16 (App Router, React Server Components) + TypeScript 5.9.
- **Styling:** Tailwind CSS v4 (CSS-first config) with a token layer in `src/app/globals.css`.
- **Backend:** Next.js route handlers in the same repository (a separate service would add
  operational cost with no benefit at this scale), organised as thin HTTP adapters over a
  framework-independent service layer in `src/server/**`.
- **Database:** PostgreSQL 16 via Prisma 7 (`prisma/schema.prisma`, migrations committed).
- **Realtime:** Server-Sent Events over an in-process aggregator bus, with a Redis pub/sub
  adapter path documented for multi-instance deployments.
- **Validation:** Zod at every trust boundary (HTTP input, gateway ingest, settings).

ChromaDB was explicitly **not** used as a transactional store, per the brief. A semantic
store is not required by any current feature; the audit records it as an optional future
side-car for semantic log search only, and no feature depends on it.

---

## 3. Existing routes

None existed. The route surface implemented by this project is documented in
`ARCHITECTURE.md` §5 and `README.md`. Every route is new.

---

## 4. Existing database

None. The schema was designed from the brief's §37 minimum model list. All 26 models are
new. Migration strategy: Prisma Migrate with committed SQL migrations under
`prisma/migrations/`, so production deploys use `prisma migrate deploy` (never `db push`).

---

## 5. Existing authentication

None. Authentication was designed from scratch with these non-negotiables from the brief:

- First boot generates a cryptographically random access code, printed **once** to server
  logs, stored only as a scrypt hash + salt.
- Sessions are opaque random tokens, stored hashed, rotated on privilege change.
- Passwords, keys, tokens and private VPN credentials are never logged.
- Rate limiting and brute-force lockout on the credential and session surfaces.

---

## 6. Existing reusable components

None. No UI primitives, tokens, or utilities existed to reuse.

---

## 7. Problems discovered

Because the repository is empty, "problems" are the gaps that would otherwise have become
problems, plus real defects found in surrounding tooling:

1. **No entry point, no lockfile, no reproducible install.** Fixed by committing
   `package.json` + `package-lock.json` with exact pinned versions.
2. **No secret management story.** Fixed with `.env.example`, a git-ignored `.env`, and an
   `ENCRYPTION_KEY` used for AES-256-GCM encryption of VPN credential material at rest.
3. **The brief's platform assumption is unsafe as stated.** "Support Railway/Render for the
   control plane" is fine; running a UDP VPN gateway there is not generally possible.
   Addressed by a hard architectural split (control plane vs data plane) and explicit
   documentation in `DEPLOYMENT.md`, rather than by pretending a cloud PaaS is a gateway.
4. **Fresh installs fail on the latest Prisma tag.** `prisma@latest` currently resolves to
   `8.0.0-rc.15` (a release candidate), and `typescript@latest` resolves to `7.0.2`. An
   unpinned install would ship an RC into a production build. Fixed by pinning
   `prisma@7.10.0` and `typescript@5.9.3`.
5. **`eslint-config-next@16.3.6` peers `eslint >=9`, while `eslint@latest` is `10.11.0`.**
   An unpinned install produces a peer conflict. Fixed by pinning `eslint@9.39.5`.
6. **`@tailwindcss/postcss` is required for Tailwind v4.** Using the legacy `tailwindcss`
   PostCSS plugin silently produces no styles. Fixed in `postcss.config.mjs`.

---

## 8. Security risks

| ID | Risk | Status |
| --- | --- | --- |
| S1 | Plaintext credentials at rest | Mitigated: scrypt for access codes/passwords, SHA-256 for session tokens, AES-256-GCM for VPN secrets. |
| S2 | Session fixation / theft | Mitigated: opaque server-side sessions, `HttpOnly` + `SameSite=Lax` + `Secure` cookies, rotation, revocation, absolute + idle expiry. |
| S3 | CSRF on state-changing routes | Mitigated: double-submit CSRF token bound to the session, enforced on all mutating methods by a shared route wrapper. |
| S4 | Brute force on the access code | Mitigated: per-IP and per-identifier attempt ledger, lockout window, audit events. |
| S5 | SSRF via webhooks / node endpoints | Mitigated: URL validation rejects private, loopback and link-local targets, DNS re-resolution, no redirect following, no arbitrary command execution. |
| S6 | Command injection | Mitigated by construction: this codebase never shells out with user input. Gateway integration is HTTP plus an explicit adapter API. |
| S7 | SQL injection | Mitigated: Prisma parameterised queries only, plus Zod-validated, typed filters. |
| S8 | Secret leakage to the frontend | Mitigated: secrets live in `server-only` modules; the client never receives private keys, API secrets or hash material. |
| S9 | Mock traffic polluting production analytics | Mitigated: a `DataSource` discriminator on every traffic/session/cost record, mock ingestion hard-disabled in production, and an unmissable DEV badge in the UI. |
| S10 | Unauthenticated gateway ingest | Mitigated: per-node API tokens (hashed at rest), node-scoped authorisation, timestamp skew rejection, payload validation. |
| S11 | Clickjacking / XSS / MIME sniffing | Mitigated: CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, HSTS in production, via middleware. |

---

## 9. Missing infrastructure

All of the following were missing and have been created:

- Environment configuration template (`.env.example`) and a validated runtime config module.
- Prisma schema, migrations and a seed/bootstrap path.
- Health and observability endpoints (`/api/health`) with request IDs and structured logs.
- Realtime transport (SSE) plus the aggregation layer that makes it responsible.
- Data-plane agent protocol (`/api/gateway/*`) and a runnable development agent.
- Retention/cleanup jobs and backup/restore documentation.
- Dockerfile + compose stack that separates the control plane from the gateway and mock
  gateway profiles.
- Test suite (Vitest) covering auth, authorisation, quota hard-limit, billing, receipts,
  optimization, device lifecycle, validation and aggregation.
- Documentation set: `README.md`, `ARCHITECTURE.md`, `SECURITY.md`, `DEPLOYMENT.md`,
  `TRAFFIC_PIPELINE.md`, `BILLING_SIMULATION.md`, `VPN_GATEWAY.md`.

---

## 10. Recommended migration path

1. **Phase 0 (this audit).** Empty repo confirmed; stack selected and pinned.
2. **Phase 1.** Foundation: config, design tokens, Prisma schema + migration, crypto,
   settings and audit services, authentication with first-boot access code.
3. **Phase 2.** Domain: devices, nodes, configs/credentials, adapter interface plus
   WireGuard, Xray and (development-only) mock adapters.
4. **Phase 3.** Traffic: collector, aggregator, SSE transport, realtime and history UI.
5. **Phase 4.** Quota engine and server-side/data-plane hard-limit enforcement.
6. **Phase 5.** Optimization profiles, DNS filtering, savings analytics with honest
   measured-vs-estimated labelling.
7. **Phase 6.** Billing simulation, cost records, projections gated on real history.
8. **Phase 7.** Receipts, PDF, QR verification, simulation stamp with the Wicore disclaimer.
9. **Phase 8.** Anomaly detection, node health, notifications, audit log review UI.
10. **Phase 9.** Responsive/accessibility/performance pass on the console UI.
11. **Phase 10.** Tests, Docker, deployment docs, production build verification.

**Rollback path:** every phase is additive and each database change is a committed
migration. Because the starting point is empty, reverting to "the previous state" means
reverting this branch; there is no user data to lose.

---

## 11. Preserved work

Nothing existed to preserve. The only pre-existing file, `README.md`, was replaced with a
full project README because it contained a single word and no information; its original
one-line content is recorded verbatim in §1 above.

One asset was added rather than preserved: the `Leonxlnx/taste-skill` pack, installed with
`npx skills add Leonxlnx/taste-skill --agent '*' -y` into `.agents/skills/**` (and mirrored
into `agent/skills/**` by the installer), pinned in `skills-lock.json`. Design decisions in
this repository follow that pack; see `ARCHITECTURE.md` §9 for the design read and the dial
settings actually applied.

