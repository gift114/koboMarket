# KoboMarket storefront

The browser app is a React 19 + Vite client for the existing Express API. It lives in this directory so frontend dependencies do not get mixed into the API's Node package.

## Run locally

1. Start MongoDB and PostgreSQL, then start the API from the repository root:

   ```powershell
   cd backend
   npm run migrate
   npm run dev
   ```

2. In a second terminal, start the frontend:

   ```powershell
   cd frontend
   npm install
   npm run dev
   ```

3. Open http://localhost:5173. Vite forwards `/api` requests to `http://localhost:3000`, so the browser uses the backend through the development proxy.

To point the frontend at a different API origin, copy `.env.example` to `.env.local` and set `VITE_API_BASE_URL`, for example `https://api.example.com/api/v1`.

The frontend includes product discovery and details, registration/login/email verification, profile, cart, wallet funding/history, seller applications and listings, and admin vendor review. Order checkout is intentionally unavailable until the backend exposes order and escrow endpoints.

## Commands

- `npm run dev` — start the development server
- `npm run build` — create a production bundle in `dist/`
- `npm run lint` — run Oxlint
- `npm run preview` — preview the production bundle locally
