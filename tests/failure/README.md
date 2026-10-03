# Failure drills

`run.mjs` breaks one dependency at a time on the local stack and checks that the system
recovers without losing or double-judging work. Start the stack first:

```bash
docker compose up -d && npm run dev    # in another terminal
npm run seed -w server
node tests/failure/run.mjs redis mongo
JUDGE_RESTART=touch node tests/failure/run.mjs judge
```

Containers are restarted with `docker restart`, never removed, so no data is lost.

| drill | what happens | what must hold |
| --- | --- | --- |
| `redis` | Redis restarts while a practice submission is in flight | `/health` recovers; the submission is judged exactly once (the server re-sends queued work older than two minutes) |
| `mongo` | the Mongo replica set restarts | `/health` recovers; every contest's `reserved` count equals its active seats; new submissions are judged |
| `judge` | the judge is killed with `SIGKILL` while it holds a claim | after the restart the stream entry is reclaimed (`XAUTOCLAIM`, 60 s idle) and the submission gets one verdict; the old claim token commits nothing |

The stale-token compare-and-set is also covered by `server/src/domain/domain.test.ts`
(`ignores a stale claim token`).

## Last run (2026-10-03, Windows 11, Docker Desktop, seeded database)

```
PASS  redis: /health recovers
PASS  redis: the in-flight submission is judged once · judged AC
PASS  mongo: /health recovers
PASS  mongo: seat counts match active seats
PASS  mongo: new submissions are judged after the restart
PASS  judge: the claimed submission gets one verdict after restart · judged AC
       (judge killed with the submission running; verdict after about 75 s)
```

Without an AI provider key the hardening engine still runs every deterministic phase; the
run reports `aiStatus: DISABLED`, and its proposals wait for the setter's approval as usual.
