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

Sign in with the seeded admin:

- email: `admin@codeclash.local`
- password: `codeclash`

`npm run dev` starts four processes in one terminal: the API, the judge, the test-hardening agent, and the client. Leave that terminal open. Stop them with Ctrl+C. The databases keep running until you stop Docker:

```bash
docker compose down
```

`docker compose down -v` also deletes the database volume. Run `npm run seed` again after that.

## What the seed creates

- 26 problems, with tests and tags
- 20 quiz questions
- **Warmup round**, already live. Register for a seat, then submit
- **Library cup**, already published, so its problems are in the problemset

Contest editorials stay hidden until that contest has ended or been published. Practice problems that were never in an unpublished contest show up immediately.

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
| `AGENT_PROVIDER` | `fake` (default), `gemini`, or `anthropic` |
| `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | Only needed if you leave the fake provider. Keep them in `.env`, never in git |

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
```

## Useful commands

```bash
npm run backup                        # dump both databases into backups/; keeps the newest 7
npm run backup -- restore <file>      # restore codeclash and codeclash_audit (drops them first)
npm run rescore -w server             # recompute stored standings after a scoring change
```
