# Taskboard — conventions for Claude Code (read before editing)

A Philinity web app: a single `index.html` (HTML + inline JS, Firebase Realtime
Database backend, Google sign-in), hosted on GitHub Pages.

## Versioning — SINGLE SOURCE OF TRUTH
- The version is defined ONCE: `<meta name="app-rev" content="X.Y">` near the
  top of `index.html`.
- The footer (`vX.Y`) and the login screen (`Version X.Y`) are filled from that
  meta tag at runtime (see the `DOMContentLoaded` injector). NEVER hard-code the
  version anywhere else.
- The cache-bust bootstrap reads the same meta tag.
- **Every change to client code MUST bump the meta tag** (e.g. 6.8 → 6.9).
  Bumping it is how we confirm the new `index.html` is actually live.

## Cache-bust
- Keep the cache-bust bootstrap (meta `app-rev` + a one-time `?v={rev}` reload
  keyed on `localStorage.tb_lastRev`). It pushes a new version to users without
  a manual hard-refresh.

## Pull-request hygiene
- Open a PR per unit of work and SHARE THE LINK as soon as you push.
- Do NOT push new commits expecting them to attach to an already-merged PR. If
  the previous PR is merged, open a NEW PR for the new commit immediately.
- Never create a PR unless asked; flag any force-push of a shared branch.

## Access / roles
- Login roster + roles live at `taskboard/access/{emailKey}` (admin / moderator
  / user), managed in-app via the footer's "👥 People" modal. This is SEPARATE
  from `taskboard/people` (assignee names).
- Both ROOT admin UIDs are hard-coded admin (lockout-proof) in client and rules.
- The deployable Firebase rules for taskboard live in the **autoflag-installs**
  repo at `access-model/PIECE3-rules-to-deploy.json` (one ruleset for all apps).
  Change only the `taskboard` block there; coordinate via `RULES-COORDINATION.md`.
