# CodeClash

Local platform for live coding and quiz contests. The browser talks to an API. A separate judge runs each submission in its own container. MongoDB stores the contest data. Redis carries the judge queue.

## What you need

- Node.js 22 or newer, with npm
- Docker Desktop, running. On Windows, use the WSL2 backend
- Git

Submissions can be Python or JavaScript. The judge pulls the matching image the first time that language runs (`python:3.12-alpine`, `node:22-alpine`), so the first submit in a language is slower.

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

`npm run dev` starts three processes in one terminal: the API, the judge, and the client. Leave that terminal open. Stop them with Ctrl+C. The databases keep running until you stop Docker:

```bash
docker compose down
```

`docker compose down -v` also deletes the database volume. Run `npm run seed` again after that.

## What the seed creates

The seed is deterministic (fixed random seed) and can be run again at any time. It replaces only what it created earlier, which is marked `seeded: true`.

- **26 problems** written for CodeClash, with formal statements, input specs and large tests. Each has a reference solution and a known wrong solution.
- **65 people.** 60 participants with ratings and practice history, 3 setters and 2 organisers.
- **Library cup**, a past contest, published so its standings and first solves are real outputs of the scoring code.
- **Warmup round**, live now. Its first 40 minutes are simulated; eight fresh submissions go through the real judge when you seed.
- **About 6,000 practice submissions** over the last 16 weeks.

Contest editorials stay hidden until that contest has ended or been published.

A new account has to confirm its email before it can take a seat or submit. In local development the confirmation token is shown on the sign-up screen. There is no mail server.

## Where to click

- **Contests** lists rounds. A live round has a seat and a timer.
- **Problemset** is practice. Run samples checks the visible examples and stores nothing. Submit judges the hidden tests.
- **Authoring** (setter or admin) drafts a problem. **New problem** opens in the pane on the right.
- **Control** (organiser or admin) creates a contest, moves it through registration, running, freeze, end, and publish, and can cancel it.
- **Admin** is people and the audit log.

In the editor, Ctrl+Enter submits. The palette icon in the header changes the theme. The choice is saved in this browser.

## Configuration

You do not need a `.env` file for the local demo. The API and the judge use the same defaults as `.env.example`.

Each of those processes reads `.env` from its own folder (`server/`, `judge/`), not from the repository root. To change a value, copy the example into the folders you want to override:

```bash
# macOS or Linux
cp .env.example server/.env
cp .env.example judge/.env
```

```powershell
# Windows PowerShell
Copy-Item .env.example server\.env
Copy-Item .env.example judge\.env
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

Do not commit `.env`. It is listed in `.gitignore`.

## Tests

These do not need the Docker stack:

```bash
npm run lint
npm run typecheck
npm test
npx playwright test
```

`BROWSER_CHANNEL=msedge npx playwright test` uses installed Edge instead of downloading Chromium.

These need `npm run dev` already running:

```bash
node tests/failure/run.mjs redis mongo   # failure drills; see tests/failure/README.md
```
