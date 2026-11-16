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
3. Add a persistent disk mounted at `/var/data`. Set `DINESYNC_DATA_DIR=/var/data/dinesync`.
4. Configure these environment variables in Render:

   | Key | Value |
   | --- | --- |
   | `NODE_ENV` | `production` |
   | `DINESYNC_DEMO_AUTH` | `false` |
   | `JWT_SECRET` | Unique random value with at least 32 random bytes. |
   | `ADMIN_EMAIL` | Initial administrator email. |
   | `ADMIN_PASSWORD` | Unique password, at least 12 characters. |
   | `CAPTAIN_EMAIL` | Initial Captain email. |
   | `CAPTAIN_PASSWORD` | Unique password, at least 12 characters. |
   | `DINESYNC_DATA_DIR` | `/var/data/dinesync` |

5. Keep the Render service at one instance while using JSON-file storage. On first startup, DineSync creates starter data and the two accounts on the persistent disk.
6. Deploy and verify `https://YOUR-SERVICE.onrender.com/api/auth/me` returns `401` while signed out.
7. Copy the Render service hostname into the `/api/:path*` rewrite in the Vercel frontend repo, then deploy the frontend.

Do not use the example passwords or signing secret in production. Never commit `.env` or real credentials. Since this is an operations app, production login requires the configured email and password.
