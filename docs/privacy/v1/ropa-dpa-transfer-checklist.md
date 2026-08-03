# Host privacy, RoPA, DPA, and transfer worksheet

<!-- GENERATED TEMPLATE by scripts/generate-privacy-integration.js. Copy before filling. -->

Based on **privacy-data-flow-retention/v1** revision 1. This is an engineering template, not legal advice.

Do not edit this generated template in place. Copy it into the deployment record,
replace every `[HOST: ...]` field, add application-specific rows, record approvers,
and review it when package versions, configuration, vendors, regions, purposes,
or retention periods change.

## Deployment identity

- Service/deployment: [HOST: name and environment]
- Controller: [HOST: legal entity and contact]
- Processor (if applicable): [HOST: legal entity and instructions]
- DPO/privacy contact: [HOST: contact]
- Security/operations owner: [HOST: contact]
- Package versions/configuration evidence: [HOST: immutable release/config reference]
- Review date / next review / approver: [HOST: dates and names]

## RoPA processing inventory

| Ecosystem activity | Enabled? | Deployment purpose and lawful basis | Data/subjects actually used | Recipients and regions | Retention and deletion evidence | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| `http-and-websocket-transit` | [HOST: yes/no] | [HOST: purpose + basis] | [HOST: minimise/extend manifest categories] | [HOST: systems/vendors/regions] | [HOST: exact period, trigger, purge proof, backup timing] | [HOST: owner] |
| `browser-connection-resume` | [HOST: yes/no] | [HOST: purpose + basis] | [HOST: minimise/extend manifest categories] | [HOST: systems/vendors/regions] | [HOST: exact period, trigger, purge proof, backup timing] | [HOST: owner] |
| `adapter-in-process-replay` | [HOST: yes/no] | [HOST: purpose + basis] | [HOST: minimise/extend manifest categories] | [HOST: systems/vendors/regions] | [HOST: exact period, trigger, purge proof, backup timing] | [HOST: owner] |
| `adapter-session-and-dedup` | [HOST: yes/no] | [HOST: purpose + basis] | [HOST: minimise/extend manifest categories] | [HOST: systems/vendors/regions] | [HOST: exact period, trigger, purge proof, backup timing] | [HOST: owner] |
| `browser-offline-mutation-queue` | [HOST: yes/no] | [HOST: purpose + basis] | [HOST: minimise/extend manifest categories] | [HOST: systems/vendors/regions] | [HOST: exact period, trigger, purge proof, backup timing] | [HOST: owner] |
| `development-inspection` | [HOST: yes/no] | [HOST: purpose + basis] | [HOST: minimise/extend manifest categories] | [HOST: systems/vendors/regions] | [HOST: exact period, trigger, purge proof, backup timing] | [HOST: owner] |
| `realtime-in-process-state-and-erasure` | [HOST: yes/no] | [HOST: purpose + basis] | [HOST: minimise/extend manifest categories] | [HOST: systems/vendors/regions] | [HOST: exact period, trigger, purge proof, backup timing] | [HOST: owner] |
| `durable-replay` | [HOST: yes/no] | [HOST: purpose + basis] | [HOST: minimise/extend manifest categories] | [HOST: systems/vendors/regions] | [HOST: exact period, trigger, purge proof, backup timing] | [HOST: owner] |
| `durable-idempotency` | [HOST: yes/no] | [HOST: purpose + basis] | [HOST: minimise/extend manifest categories] | [HOST: systems/vendors/regions] | [HOST: exact period, trigger, purge proof, backup timing] | [HOST: owner] |
| `durable-dead-letters` | [HOST: yes/no] | [HOST: purpose + basis] | [HOST: minimise/extend manifest categories] | [HOST: systems/vendors/regions] | [HOST: exact period, trigger, purge proof, backup timing] | [HOST: owner] |
| `durable-tasks-jobs-and-alarms` | [HOST: yes/no] | [HOST: purpose + basis] | [HOST: minimise/extend manifest categories] | [HOST: systems/vendors/regions] | [HOST: exact period, trigger, purge proof, backup timing] | [HOST: owner] |
| `cluster-ephemeral-state` | [HOST: yes/no] | [HOST: purpose + basis] | [HOST: minimise/extend manifest categories] | [HOST: systems/vendors/regions] | [HOST: exact period, trigger, purge proof, backup timing] | [HOST: owner] |
| `logs-metrics-and-traces` | [HOST: yes/no] | [HOST: purpose + basis] | [HOST: minimise/extend manifest categories] | [HOST: systems/vendors/regions] | [HOST: exact period, trigger, purge proof, backup timing] | [HOST: owner] |
| `application-and-backup-copies` | [HOST: yes/no] | [HOST: purpose + basis] | [HOST: minimise/extend manifest categories] | [HOST: systems/vendors/regions] | [HOST: exact period, trigger, purge proof, backup timing] | [HOST: owner] |
| [HOST: application-specific activity] | [HOST] | [HOST] | [HOST] | [HOST] | [HOST] | [HOST] |

## Retention and erasure controls

- [ ] Every enabled activity has an exact retention period/trigger; capacity-only and `ttl=0` defaults are not presented as deadlines.
- [ ] Offline persistence uses an account-specific `persistKey`, a positive `maxAge`, and sign-out/account-switch clearing.
- [ ] Replay and dead-letter stores use positive TTLs where personal data is possible.
- [ ] `forgetUserId` and durable `purgeUser` are configured and tested for each applicable store.
- [ ] `FORGET_STORE_FAILED`, timeouts, and partial deletion keep the request open and trigger a retry/escalation.
- [ ] Adapter replay/session/dedup, jobs, alarms, application stores, downstream side effects, and custom stores have explicit deletion legs.
- [ ] Browser storage, logs, metrics, traces, support exports, replicas, caches, and backups have explicit deletion or put-beyond-use rules.
- [ ] Completion evidence contains no unnecessary personal data and names every successful, failed, and non-applicable leg.

Erasure runbook/evidence location: [HOST: controlled link]

## Processor, DPA, and subprocessor review

Repeat for hosting, proxy/CDN, Redis, Postgres, logging, metrics, tracing, SIEM,
backups, push, webhook, support, analytics, and any application recipient.

| Provider/recipient | Role and service | Data/subjects | DPA and instructions | Subprocessors/change notice | Security/access/deletion | Regions | Owner/evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [HOST: provider] | [HOST: processor/subprocessor/independent recipient] | [HOST] | [HOST: DPA/version/instructions] | [HOST: list + notice/objection] | [HOST: controls and deletion SLA] | [HOST] | [HOST] |

## International transfer review

| Transfer route | Exporter/importer and countries | Data/purpose | Mechanism | Supplementary measures | Transfer assessment/evidence | Revalidation trigger |
| --- | --- | --- | --- | --- | --- | --- |
| [HOST: service/data flow] | [HOST] | [HOST] | [HOST: adequacy/SCC/other] | [HOST: encryption/key control/minimisation] | [HOST: controlled link] | [HOST: date/vendor/legal change] |

## Approval

- Privacy/legal review: [HOST: approver/date/findings]
- Security review: [HOST: approver/date/findings]
- Engineering/operations review: [HOST: approver/date/drill evidence]
- Residual risks and accepted exceptions: [HOST: owner/expiry/mitigation]

