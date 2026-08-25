# Taskboard thin API

A small REST/JSON API that lets **external assistants** (your VA's agent, Claude,
GPT, etc.) read and write Task Board tasks **without any Firebase credentials**.
The Cloud Function holds the privileged access server-side (Firebase Admin SDK)
and exposes only a validated task surface, gated by a static API key.

It writes to the **same** Realtime Database paths as `index.html`, preserving the
invariants the web app relies on, so open app sessions update live and nothing
corrupts.

> This is deploy-ready source, not an auto-deployed service. Firebase Functions
> deploy from your `philinity-893d2` functions project — merging this to GitHub
> does **not** deploy it (same as the rules file). See **Deploy** below.

---

## Auth

Every request needs the API key, sent either way:

```
Authorization: Bearer <TASKS_API_KEY>
# or
X-API-Key: <TASKS_API_KEY>
```

- `TASKS_API_KEY` — full read + write.
- `TASKS_API_READONLY_KEY` — optional; GET only (writes return `403`). Hand this
  to assistants that should only *look*.

No Firebase login, no Google account, no rules exposure — just the key.

---

## Endpoints

Base URL after deploy:
`https://us-central1-philinity-893d2.cloudfunctions.net/tasksApi`

| Method & path              | Does                                                        |
|----------------------------|-------------------------------------------------------------|
| `GET /meta`                | Valid categories, people (assignees), and priorities        |
| `GET /tasks`               | List active tasks. Filters: `?cat=`, `?assignee=`, `?priority=` |
| `GET /tasks/:id`           | One task                                                    |
| `POST /tasks`              | Create a task                                               |
| `PATCH /tasks/:id`         | Update `text` / `cat` / `assignee` / `priority`            |
| `POST /tasks/:id/complete` | Complete → moves it into the completion log                |
| `DELETE /tasks/:id`        | Hard-delete (no log entry). Prefer `complete`.             |
| `GET /history?limit=200`   | Completion log, newest first                                |

All responses: `{ "ok": true, "data": ... }` or
`{ "ok": false, "error": { "code", "message" } }`.

### Create body

```json
{ "text": "Call the plumber", "cat": "followup", "assignee": "Phil", "priority": "high" }
```

Only `text` is required. `cat` defaults to the first category; `priority`
defaults to `medium`; `assignee` defaults by category (Trinity/Austen/Phil),
mirroring the app.

### Examples

```bash
BASE=https://us-central1-philinity-893d2.cloudfunctions.net/tasksApi
KEY=your-key-here

curl -s $BASE/meta -H "Authorization: Bearer $KEY"

curl -s $BASE/tasks -H "Authorization: Bearer $KEY"

curl -s -X POST $BASE/tasks -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Order flag brackets","cat":"followup","priority":"high"}'

curl -s -X PATCH $BASE/tasks/105 -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"priority":"low"}'

curl -s -X POST $BASE/tasks/105/complete -H "Authorization: Bearer $KEY"
```

---

## Deploy

From your Firebase functions project for `philinity-893d2` (the one that already
serves `askAI`):

1. Copy `index.js` in as a codebase, or paste the `tasksApi` export alongside
   your existing functions and merge `package.json` dependencies.
2. Set the key(s):
   ```bash
   firebase functions:secrets:set TASKS_API_KEY
   firebase functions:secrets:set TASKS_API_READONLY_KEY   # optional
   ```
3. Deploy just this function:
   ```bash
   firebase deploy --only functions:tasksApi
   ```

---

## App-compatibility notes (why this is safe)

Writes mirror `index.html` exactly:

- **New id** is allocated atomically from `taskboard/nextId` (transaction), like
  the client's `nextId++`.
- New task id is **prepended** into `taskboard/taskOrder/{cat}` so it lands on
  top of the column, same as the app.
- **Complete** prepends to `taskboard/completionLog` and nulls `tasks/{id}`,
  matching the app's move-to-log behavior.
- Each task is written at its own `tasks/{id}` child — never a wholesale
  `tasks` overwrite — so it plays nicely with the rules and other writers.

**Concurrency:** if the web app is open with a stale cache at the instant the API
adds a task, the app's next full `save()` could theoretically re-null a
just-added task before its live listener catches up. This is the same small
window that already exists between two human editors; in practice the RTDB
listener delivers the new task within ~1s. Not a concern for normal use.

## Not included (say the word to add)

- Per-consumer keys / usage logging / rate limiting (Cloud Functions gives basic
  concurrency limits; no per-key throttle here).
- A natural-language `POST /ask` endpoint (a headless, server-side upgrade of the
  in-app `askAI`). REST was chosen as the deterministic foundation first.
- An MCP wrapper so assistants can call these as native tools.
