# Altaş Holdings staff hub

The staff hub uses its own D1 database, accounts and cookies. It does not accept or share Corendon credentials. The existing public website remains static. Cloudflare Pages Functions handle `/api/staff/*`.

## Activate on the existing Cloudflare Pages project

1. Create a D1 database named `altas-holdings-staff` in Cloudflare. In its console, execute `migrations/0001_staff.sql`.
2. In the existing Pages project's Settings → Bindings, add a D1 binding named **STAFF_DB**, pointing to that database. Set the production binding; use a different database for previews if desired.
3. Add an encrypted Pages environment variable named **STAFF_SETUP_KEY**, with a randomly generated secret at least 32 characters long. Never commit the key. Keep it private until the chairman account is created.
4. Redeploy the Pages project so the binding and variable apply. Keep the existing root output directory and no build command. The Pages Git build must deploy the repository's `functions` directory; a dashboard drag-and-drop upload alone does not deploy Functions.
5. Open `/staff/`, choose **First-time chairman setup**, enter the private setup key, the chairman's name, email and a password of at least 12 characters. The database enforces only one chairman.
6. Remove **STAFF_SETUP_KEY** from the Cloudflare project and redeploy. Setup is also automatically refused once a chairman exists.

If the database is absent or uninitialised, the hub refuses sign-in and displays an activation message. No default password or public registration is provided.

## Using the hub

The chairman creates invitations in Staff management and privately shares the generated links. Links are single-use, expire after 48 hours and are bound to the invited email. The app does not send email. Creating a new invitation for the same email invalidates the previous link.

All active staff can read group announcements and resources. Only the chairman can publish/delete content, list staff email addresses, invite staff, or suspend/restore access. Suspension revokes all sessions. Resource links point to externally hosted documents; the document owner's permissions still control the linked file itself.

Sessions use hashed random tokens stored in D1 and a Secure, HttpOnly, SameSite=Strict host cookie. Normal sessions expire after 12 hours; Remember me sessions expire after 30 days. Passwords are salted PBKDF2-SHA256 with 100,000 iterations (Cloudflare Web Crypto's supported maximum). Password changes revoke every old session. Mutations require a matching Origin and JSON content type. Authentication attempts and writes have database-backed rate limits.

## Account recovery

Self-service email recovery is not implemented. Staff must contact the chairman for assistance. If an account password is lost, a trusted Cloudflare administrator can remove that account's sessions and account record using the D1 console, after reassigning/deleting its authored announcements if any. Then the chairman issues a new invitation. Do not reuse or overwrite password hashes by hand. For a lost chairman account, an administrator must deliberately restore access through a reviewed database recovery; there is no public bypass.

## Validation

Run `node --test tests/staff-auth.test.mjs` from the repository root. These tests use Node's in-memory SQLite via a D1-compatible adapter and exercise the production request handler. The Cloudflare binding, deployed Pages Functions and browser layout still require verification in the deployed environment.
