# Node Lifecycle Test Matrix

This matrix records only checks actually run in the current environment. `LOCAL` means
the code or build was checked without a live database; `BLOCKED` means the required
database or production service was unavailable.

| Test | Expected | Result |
| --- | --- | --- |
| Access code đúng | Login succeeds | BLOCKED: no database |
| Access code sai | Authentication rejected | BLOCKED: no database |
| Node register | Node persisted as REGISTERING | LOCAL: code/typecheck only |
| Node heartbeat | Authenticated heartbeat accepted | LOCAL: code/typecheck only |
| Node ONLINE | REGISTERING transitions to ONLINE | LOCAL: code/typecheck only |
| Node offline | ONLINE transitions to OFFLINE, record remains | LOCAL: code/typecheck only |
| Node revoke | Lifecycle transitions to REVOKED | LOCAL: code/typecheck only |
| REVOKED persisted | Refresh still returns node | LOCAL: migration/code only |
| Revoked token rejected | `NODE_REVOKED`, HTTP 403 | LOCAL: code/typecheck only |
| Restart revoked node | Agent stops heartbeat and does not re-enroll | LOCAL: node typecheck only |
| Device approve | PENDING transitions to APPROVED | BLOCKED: no database |
| MSF with ONLINE node | Start permitted | LOCAL: routing guard only |
| MSF with OFFLINE node | Start rejected | LOCAL: routing guard only |
| MSF with REVOKED node | Start rejected with revoked/unavailable reason | LOCAL: routing guard only |

No production result is claimed: `DATABASE_URL`, `AUTH_SECRET`, `ENCRYPTION_KEY`,
`NODE_ENROLLMENT_TOKEN`, and `CONTROL_PLANE_URL` were absent in this environment.