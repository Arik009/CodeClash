# CodeClash

Local platform for live coding and quiz contests. The browser talks to an API. A separate judge runs each submission in its own container. MongoDB stores the contest data. Redis carries the judge queue.

## What you need

- Node.js 22 or newer, with npm
- Docker Desktop, running. On Windows, use the WSL2 backend
- Git

Submissions can be Python, JavaScript, C, C++17, Java 21, or Go. The judge pulls the matching image the first time that language runs (`python:3.12-alpine`, `node:22-alpine`, `gcc:14`, `eclipse-temurin:21-jdk-alpine`, `golang:1.23-alpine`), so the first submit in a language is slower. Java source must be a public class named `Main`.

## Run it

From this directory:

```bash
docker compose up -d
npm install
npm run seed
npm run dev
```

On Windows PowerShell the same four commands work.

Wait until MongoDB is ready before `npm run seed`. This is ready when `docker compose ps` shows `mongo` as healthy. The first start can take a minute while it creates the replica set and the database users.

Then open http://localhost:5173.

| | |
| --- | --- |
| Site | http://localhost:5173 |
| API | http://localhost:4000 |
| Health | http://localhost:4000/health |

Every seeded account uses the password `codeclash`:

| Role | Email |
| --- | --- |
| admin | `admin@codeclash.local` |
| setter | `meghna.raghavan@codeclash.dev`, `arnav.bhattacharya@codeclash.dev`, `daniel.novak@codeclash.dev` |
| organiser | `vikram.sethi@codeclash.dev`, `laura.bennett@codeclash.dev` |
| participant | 60 students, for example `diya.banerjee@students.codeclash.dev` or `lucas.moreau@students.codeclash.dev` |

`npm run dev` starts four processes in one terminal: the API, the judge, the test-hardening agent, and the client. Leave that terminal open. Stop them with Ctrl+C. The databases keep running until you stop Docker:

```bash
docker compose down
```

`docker compose down -v` also deletes the database volume. Run `npm run seed` again after that.

## What the seed creates

The seed is deterministic (fixed random seed) and can be run again at any time. It replaces only what it created earlier, which is marked `seeded: true`.

- **146 problems.** 26 written for CodeClash, with formal statements, input specs and large tests, and 120 real Codeforces problems imported from DeepMind CodeContests (see below). Each has a reference solution and at least one known wrong solution.
- **65 people.** 60 participants with ratings and practice history, 3 setters and 2 organisers.
- **Eight past contests**, all published and rated in date order, so the standings, first solves and rating changes are real outputs of the scoring code.
- **Warmup round**, live now. Its first 40 minutes are simulated; eight fresh submissions go through the real judge when you seed.
- **Autumn Open**, open for registration, starting in five days. **Winter Invitational** is a draft.
- **About 6,000 practice submissions** over the last 16 weeks, which fill the profile heatmap. About a quarter of participants are on a live solve streak.
- **60 quiz questions.**

Contest editorials stay hidden until that contest has ended or been published. Problems that belong to a contest show up in the problemset only once that contest is published.

### Imported problems

`server/data/codecontests.json.gz` holds 120 problems from the [DeepMind CodeContests dataset](https://github.com/google-deepmind/code_contests) (CC BY 4.0), which in turn come from Codeforces. Each problem page shows its source, for example "Source: Codeforces 1582F1, via DeepMind CodeContests (CC BY 4.0)". `server/data/CODECONTESTS-ATTRIBUTION.md` lists what was changed and how problems were chosen.

`scripts/import-codecontests.mjs` rebuilds that file from the dataset's parquet files. It keeps only problems where two of the dataset's correct solutions agree on every test in our own sandbox, and where the dataset's wrong solutions actually fail.

A new account has to confirm its email before it can take a seat or submit. In local development the confirmation token is shown on the sign-up screen. There is no mail server.

## Where to click

- **Contests** lists rounds. A live round has a seat and a timer.
- **Problemset** is practice. Run samples checks the visible examples and stores nothing. Submit judges the hidden tests.
- **Authoring** (setter or admin) drafts a problem. **New problem** opens in the pane on the right.
- **Control** (organiser or admin) creates a contest, moves it through registration, running, freeze, end, and publish, opens quiz questions, and can cancel or rejudge.
- **Admin** is people, workers, and the audit log.
- **Guide** is the operator reference.
- Your name in the header opens **Profile**: rating, solve streak, display name, and password.

In the editor, Ctrl+Enter submits. The palette icon in the header changes the theme. The choice is saved in this browser.

## Test hardening

In Authoring, **Harden tests** checks whether a problem's tests are strong enough. The agent process runs it in the background:

1. **Mutants.** Small deliberate bugs are made in the reference solution: an off-by-one in a loop bound or constant, a flipped comparison or operator, swapped `min` and `max`, a removed `break`, or a 64-bit type narrowed to 32 bits. A mutant that the current tests do not catch is a hole in the tests.
2. **Attacks.** If the problem has an input spec, the engine generates boundary, random and maximum-size inputs, gets the expected output from the reference, and keeps the inputs that kill surviving mutants. Mutants that agree with the reference on every generated input are reported as probably equivalent instead of being counted against the tests.
3. **Score.** The run reports the share of non-equivalent mutants killed, plus whether any test is near the maximum input size.
4. **Optional AI.** With a provider configured, a model plans extra attacks and suggests inputs for survivors. Without one, everything above still runs and the run shows the AI as disabled.

Every proposed test waits for the setter's approval, and an approval is applied in a single transaction.

### Input spec

One line per input line, for example:

```text
n int 1..2*10^5
a int[n] -10^9..10^9
s str[1..10^5] ()
lines m: u int 1..n, v int 1..n
sum n <= 2*10^5
```

The Spec tab validates every existing test against the spec and can draft one from the statement's constraints.

## Configuration

You do not need a `.env` file for the local demo. The API, judge, and agent use the same defaults as `.env.example`.

Each of those processes reads `.env` from its own folder (`server/`, `judge/`, `agent/`), not from the repository root. To change a value, copy the example into the folders you want to override:

```bash
# macOS or Linux
cp .env.example server/.env
cp .env.example judge/.env
cp .env.example agent/.env
```

```powershell
# Windows PowerShell
Copy-Item .env.example server\.env
Copy-Item .env.example judge\.env
Copy-Item .env.example agent\.env
```

| Variable | What it does |
| --- | --- |
| `MONGO_URL` | Contest database. Default matches the Docker user `app` / `codeclash` |
| `AUDIT_MONGO_URL` | Append-only audit database. The app user cannot update or delete those rows |
| `REDIS_URL` | Judge queue. Default `redis://127.0.0.1:6379` |
| `JWT_SECRET` | Required in production, at least 16 characters. Local development has a built-in fallback |
| `PORT` | API port. Default `4000` |
| `CLIENT_ORIGIN` | Browser origin allowed by CORS. Default `http://localhost:5173` |
| `JUDGE_SLOTS` | How many submissions this judge runs at once. Default `4` |
| `JUDGE_BATCH` | `1` compiles once and runs every test in one container. Default `0` (one container per test) |
| `AGENT_PROVIDER` | Empty (no AI, default), `anthropic`, `gemini`, or `openai` |
| `AGENT_MODEL` | Model name for that provider |
| `AGENT_BASE_URL` | Any OpenAI-compatible server, such as a local Ollama at `http://localhost:11434/v1` |
| `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY` | Only for the provider you pick. Keep them in `.env`, never in git |
| `AGENT_RUN_TOKEN_CAP`, `AGENT_MONTHLY_TOKEN_CAP` | Tokens one hardening run may spend, and the monthly ceiling. Defaults `20000` and `200000` |

Do not commit `.env`. It is listed in `.gitignore`.

## Tests

These do not need the Docker stack, except the container-escape cases, which skip themselves when Docker is unavailable:

```bash
npm run lint
npm run typecheck
npm test
npx playwright test
```

`BROWSER_CHANNEL=msedge npx playwright test` uses installed Edge instead of downloading Chromium.

These need `npm run dev` already running:

```bash
node tests/smoke/live.mjs
node tests/smoke/ui.mjs
npm run verify:catalog -w server         # every catalog reference passes, every wrong solution fails
node tests/load/run.mjs                  # k6 in Docker; results in tests/load/results/k6.md
node tests/load/judge-batch.mjs          # judge timing with and without JUDGE_BATCH
node tests/failure/run.mjs redis mongo   # failure drills; see tests/failure/README.md
```

Latest numbers: the read API held 100 requests per second with a p95 of 45 ms, and 50 users refreshing the leaderboard got a p95 of 24 ms, with no failed requests. Batch judging was 5.9 times faster for Python, 10.5 times for C++ and 6.7 times for Java on 12 tests (`tests/load/results/`).

## Useful commands

```bash
npm run backup                        # dump both databases into backups/; keeps the newest 7
npm run backup -- restore <file>      # restore codeclash and codeclash_audit (drops them first)
npm run rescore -w server             # recompute stored standings after a scoring change
```
