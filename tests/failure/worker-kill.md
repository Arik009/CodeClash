# Failure scripts

These need the local stack running (`docker compose up`, server, judge).

1. Kill the judge process while a submission is `claimed`. Start the judge again. The stream entry is reclaimed, the old token commits nothing, and the submission has one verdict. The same compare-and-set is asserted by `server/src/domain/domain.test.ts` (`ignores a stale claim token`).
2. `docker restart` the Redis container. The server `/health` fails until Redis is back. Queued submissions remain in MongoDB and are judged after the worker reconnects.
3. `docker restart` the Mongo container. In-flight requests return 500. After it is healthy, `seatInvariants` still hold because they live in the replica set.
4. Set `AGENT_PROVIDER=fake` or block outbound HTTPS. A harden run ends as `no_proposals` and the problem version stays unpublished until the setter runs the publish check by hand.

Before/after judge timing: run one submission with a fresh container per test (the default loop in `judge/src/index.ts`), record `judgedAt - submittedAt`, then compare with a single container that runs every test (the early-exit path already stops at the first failure). Write both numbers into the D3 performance note.
