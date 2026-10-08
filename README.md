# CodeClash

Local platform for live coding and quiz contests. The browser talks to an API. MongoDB stores the contest data. Redis carries the judge queue.

## What you need

- Node.js 22 or newer, with npm
- Docker Desktop, running. On Windows, use the WSL2 backend
- Git

## Run it

From this directory:

```bash
docker compose up -d
npm install
npm run dev
```

On Windows PowerShell the same three commands work.

Wait until MongoDB is ready before `npm run dev`. This is ready when `docker compose ps` shows `mongo` as healthy. The first start can take a minute while it creates the replica set and the database users.

Then open http://localhost:5173.

| | |
| --- | --- |
| Site | http://localhost:5173 |
| API | http://localhost:4000 |
| Health | http://localhost:4000/health |

`npm run dev` starts two processes in one terminal: the API and the client. Leave that terminal open. Stop them with Ctrl+C. The databases keep running until you stop Docker:

```bash
docker compose down
```

`docker compose down -v` also deletes the database volume.

## Configuration

You do not need a `.env` file for the local demo. The API uses the same defaults as `.env.example`.

The API reads `.env` from its own folder (`server/`), not from the repository root. To change a value, copy the example there:

```bash
# macOS or Linux
cp .env.example server/.env
```

```powershell
# Windows PowerShell
Copy-Item .env.example server\.env
```

| Variable | What it does |
| --- | --- |
| `MONGO_URL` | Contest database. Default matches the Docker user `app` / `codeclash` |
| `REDIS_URL` | Judge queue. Default `redis://127.0.0.1:6379` |
| `PORT` | API port. Default `4000` |
| `CLIENT_ORIGIN` | Browser origin allowed by CORS. Default `http://localhost:5173` |

Do not commit `.env`. It is listed in `.gitignore`.

## Tests

These do not need the Docker stack:

```bash
npm run lint
npm run typecheck
npm test
```
