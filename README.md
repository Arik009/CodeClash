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

The seed creates one account, `admin@codeclash.local`, with the password `codeclash`.

`npm run dev` starts three processes in one terminal: the API, the judge, and the client. Leave that terminal open. Stop them with Ctrl+C. The databases keep running until you stop Docker:

```bash
docker compose down
```

`docker compose down -v` also deletes the database volume. Run `npm run seed` again after that.

A new account has to confirm its email before it can take a seat or submit. In local development the confirmation token is shown on the sign-up screen. There is no mail server.

## Where to click

- **Problemset** is practice. Run samples checks the visible examples and stores nothing. Submit judges the hidden tests.

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
```
