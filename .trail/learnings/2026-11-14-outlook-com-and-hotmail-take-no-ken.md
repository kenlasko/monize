---
title: Outlook.com and Hotmail take no password on IMAP; a clearer error for that was built and declined
author: Ken
date: 2026-11-14
branch: main
id: l-9b1a8cb6
scope: repo
status: active
src: agent
touches:
  - docker-compose.dev.yml
---

## Decided
Outlook.com / Hotmail (consumer Microsoft accounts) refuse every password login on IMAP, app passwords included. Tested live on 2026-11-14: outlook.office365.com and imap-mail.outlook.com (993 TLS, 143 STARTTLS) advertise only `AUTH=XOAUTH2 LOGINDISABLED`. The password form cannot work for them. Gmail still accepts app passwords, so "Gmail works, Outlook doesn't" is expected, not a bug.

A change that replaced imapflow's "Login is disabled; authentication failed" with a sentence pointing to Connect with Microsoft, forwarding or file import (plus a user-guide section) was built, then dropped by Ken: "we don't need these updates". Don't re-propose it unasked.

## Tried and ruled out
- Other Microsoft hosts and ports: same capabilities.
- Telling consumer users to register an Entra / Azure app, or to ask an admin to: they have no access to Entra.

## Watch out
Switching branches while the dev backend runs can leave truncated or stale locale JSON in backend/dist: the watcher copies files mid-write, and the app dies with I18nError "Invalid JSON file". The sources are fine. Restart the backend container.

In the code: imapflow throws AuthenticationFailure('Login is disabled') when LOGINDISABLED is set and neither AUTH=PLAIN nor AUTH=LOGIN is offered. Fix for the dist race: docker compose -f docker-compose.dev.yml restart backend.
