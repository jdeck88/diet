# Diet Log

Small PIN-protected web app for turning spoken or typed food notes into rows in a Google Sheet.

## Run

```bash
npm start
```

The app defaults to `http://127.0.0.1:5174` and PIN `2004`.

The server reads credentials from local environment variables first, then falls back to sibling project env files:

- `../dff-workflow-builder/.env` for `OPENAI_API_KEY` and `OPENAI_WORKFLOW_MODEL`
- `../dashboards-poultry/.env`
- `../timesheets/server/.env` for `GOOGLE_SERVICE_ACCOUNT_JSON`

The default write target is spreadsheet `14DM8zSoCnO-Q2CTSZTGbpBoS-stbFqtx0W9bbDFEyog`, tab `test`.

## Netlify

This repo is configured for Netlify with `public` as the static publish directory and `netlify/functions/api.mjs` handling `/api/*`.

Set these Netlify environment variables:

```bash
APP_PIN=2004
SESSION_SECRET=replace-this-with-a-long-random-value
OPENAI_API_KEY=...
GOOGLE_SERVICE_ACCOUNT_JSON=...
DIET_SPREADSHEET_ID=14DM8zSoCnO-Q2CTSZTGbpBoS-stbFqtx0W9bbDFEyog
DIET_SHEET_TAB_NAME=test
```

Netlify build command:

```bash
npm run check
```

Netlify publish directory:

```bash
public
```
