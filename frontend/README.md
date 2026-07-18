# frontend

React + Vite frontend for the AurigaSQL chat and canvas UI.

## Backend contract

This frontend must talk only to the BFF layer, not directly to internal backend services.

Current request path:

- Browser app: `http://localhost:5173`
- BFF: `http://localhost:6003`
- Internal runtime behind the BFF: in-process `runtime` plus source-specific data sessions

That BFF is implemented in FastAPI at [../backend/api/app.py](../backend/api/app.py).

## Environment

Copy `.env.example` values into your local Vite env file if you need a different BFF base URL.

- `VITE_BFF_BASE_URL`
  Default: `http://localhost:6003`
  Purpose: the only backend base URL the frontend should call

If this variable is unset, the frontend falls back to `http://localhost:6003`.

## Development

Install dependencies and start the frontend:

```bash
npm install
npm run dev
```

Run the Electron desktop shell during development:

```bash
npm run dev:desktop
```

Build an unpacked desktop app for local smoke testing:

```bash
npm run pack:desktop
```

This rebuilds the bundled backend before packaging. On macOS it creates an
unsigned unpacked app for functional smoke testing; signing and notarization are
part of the release build path.

Build distributable desktop installers:

```bash
npm run dist:desktop
```

Validation command:

```bash
npm run typecheck && npm test
```

If the UI cannot load databases or start chats, make sure the backend services are running:

```bash
bash backend/scripts/start_services.sh
```

## Upgrade guidance

- Keep the frontend coupled only to the BFF contract.
- If backend services change ports, routes, or payloads, prefer adapting the BFF first.
- If the BFF contract changes, update `src/api/*` together with the corresponding backend routers and schemas.
