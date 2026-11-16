# DineSync Backend

Express API for the DineSync restaurant operations app. This repository is deployed as a Render Web Service; the frontend is in [fronted-pro-](https://github.com/satyam3433/fronted-pro-).

## Local setup

```sh
npm ci
Copy-Item .env.example .env
npm start
```

The local demo flag in `.env.example` accepts any non-empty credentials and signs in as the Captain. Turn `DINESYNC_DEMO_AUTH` off to test the configured accounts. This flag is rejected in production.

Run API integration tests with `npm test`.

## Deploy to Render

1. Create a **Web Service** from `satyam3433/Backend-pro`, using the repository root.
2. Set Build Command to `npm ci` and Start Command to `npm start`.
3. In Supabase, open **SQL Editor** and create the private state table:

   ```sql
   create table if not exists public.dinesync_state (
     id integer primary key check (id = 1),
     version bigint not null default 0,
     data jsonb not null
   );
   alter table public.dinesync_state enable row level security;
   ```

   Do not add public/anonymous access policies for this table.
4. Rotate any Supabase secret key or database password that has been shared in chat or committed. Create a fresh server-only **secret API key**. The database password and publishable key are not used by this backend.
5. Add these environment variables in Render:

   | Key | Value |
   | --- | --- |
   | `NODE_ENV` | `production` |
   | `DINESYNC_DEMO_AUTH` | `false` |
   | `SUPABASE_URL` | Your Supabase project URL. |
   | `SUPABASE_SECRET_KEY` | Fresh server-only Supabase secret API key. |
   | `JWT_SECRET` | New random value with at least 32 random bytes. |
   | `ADMIN_EMAIL` | Initial administrator email. |
   | `ADMIN_PASSWORD` | Unique password, at least 12 characters. |
   | `CAPTAIN_EMAIL` | Initial Captain email. |
   | `CAPTAIN_PASSWORD` | Unique password, at least 12 characters. |

6. Deploy. On first startup, DineSync seeds the Supabase row and creates the Admin and Captain accounts.
7. Verify `https://YOUR-SERVICE.onrender.com/api/auth/me` returns `401` while signed out. Copy the Render service hostname into the `/api/:path*` rewrite in the Vercel frontend repo, then deploy the frontend.

No Render disk is needed; production data is stored in Supabase. Do not use the example passwords or signing secret in production. Never commit `.env` or real credentials. Keep the Supabase secret key in Render only, never Vercel or frontend code. Production login requires the configured email and password.
