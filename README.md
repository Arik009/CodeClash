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
