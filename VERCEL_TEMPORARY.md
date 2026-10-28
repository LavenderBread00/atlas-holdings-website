# Temporary free Vercel entrance

EU.org remains the intended permanent domain (`altasholdings.eu.org`). This optional deployment provides a temporary Vercel address while that application is pending. The existing Cloudflare deployment and Corendon site remain in place.

Import this repository on Vercel using the `temporary-vercel` branch, framework Other and the free Hobby plan. The checked-in `vercel.json` builds the public files into `public/`; do not select a paid plan or paid domain. Request project name `atlasholdings` if available; the assigned address must be verified after deployment.

Vercel must expose `VERCEL_PROJECT_PRODUCTION_URL` to Functions (normally automatic). Alternatively set the non-secret `STAFF_HUB_HOST` to the exact production hostname, without `https://` or a path. The API rejects requests on other hosts, including unconfigured deployment previews. If the project later gains another custom hostname, update the configured hostname and redeploy before using the Staff Hub there.

The `api/staff/[...path].js` Function forwards only known staff actions to the existing HTTPS Cloudflare staff service. It checks the browser's production Origin before adapting POSTs to the upstream origin. Only the Altaş session cookie is forwarded; unrelated cookies are discarded. Invitation links are returned on the temporary origin. Responses are private/no-store. It requires no Cloudflare administrative token and copies no staff database into Vercel. Existing accounts and passwords are reused, but users sign in again on the new hostname.

The Cloudflare service still enforces password checks, staff permissions, invitation validity and rate limits. Authentication attempts arriving through the gateway share the upstream connection's IP limit (25 attempts per 15 minutes), while account and user-specific limits also remain enforced. This is a temporary entrance rather than an independent backend.

Validation before publication:

- `node --test tests/staff-auth.test.mjs tests/vercel-gateway.test.mjs`
- `node scripts/build-vercel.mjs`
- Verify deployment, homepage images, `/staff/`, `/api/staff/status` and a user-controlled sign-in on the assigned production address.
- Confirm access from the user's Türkiye connection; external deployment success alone cannot prove local ISP reachability.

The deployment has not been created merely by preparing this branch. A connected Vercel account is required.
