# Altaş Holdings staff hub

The staff hub uses its own D1 database, accounts and cookies. It does not accept or share Corendon credentials. The existing public website remains static. Cloudflare Pages Functions handle `/api/staff/*`.

## Activate on the existing Cloudflare Pages project

1. Create a D1 database named `altas-holdings-staff` in Cloudflare. In its console, execute migrations `0001_staff.sql` through `0006_rank_permissions.sql` in order. They preserve existing accounts and are safe to re-run. The activation workflow applies them automatically.
2. In the existing Pages project's Settings → Bindings, add a D1 binding named **STAFF_DB**, pointing to that database. Set the production binding; use a different database for previews if desired.
3. Add an encrypted Pages environment variable named **STAFF_SETUP_KEY**, with a randomly generated secret at least 32 characters long. Never commit the key. Keep it private until the Group CEO account is created.
4. Redeploy the Pages project so the binding and variable apply. Keep the existing root output directory and no build command. The Pages Git build must deploy the repository's `functions` directory; a dashboard drag-and-drop upload alone does not deploy Functions.
5. Open `/staff/`, choose **First-time Group CEO setup**, enter the private setup key, the Group CEO's name, email and a password of at least 6 characters. The database enforces only one owner.
6. Remove **STAFF_SETUP_KEY** from the Cloudflare project and redeploy. Setup is also automatically refused once an owner exists.

If the database is absent or uninitialised, the hub refuses sign-in and displays an activation message. No default password or public registration is provided.

## Using the hub

The Group CEO creates invitations in Staff management and privately shares the generated links. Links are single-use, expire after 48 hours and are bound to the invited email. The app does not send email. Creating a new invitation for the same email invalidates the previous link.

All active staff can read group announcements and resources and update tasks assigned to them. Feature permissions determine who can publish or delete announcements and resources, view the staff directory, see group tasks, or assign and update group work. Only the Group CEO can invite staff, revoke invitations, suspend/restore access, manage ranks and assignments, or read the activity log. Suspension revokes all sessions. Resource links point to externally hosted documents; the document owner's permissions still control the linked file itself.

Sessions use hashed random tokens stored in D1 and a Secure, HttpOnly, SameSite=Strict host cookie. Normal sessions expire after 12 hours; Remember me sessions expire after 30 days. Passwords are salted PBKDF2-SHA256 with 100,000 iterations (Cloudflare Web Crypto's supported maximum). Password changes revoke every old session. Mutations require a matching Origin and JSON content type. Authentication attempts and writes have database-backed rate limits.

## Account recovery

The sign-in screen provides **Forgot your password?** guidance. Recovery uses private, single-use links, not automatic email. It preserves account IDs, roles, staff assignments and existing work. A link is checked without being consumed; submitting a valid new password atomically consumes the link, updates the salted hash, revokes all old sessions and records an audit entry. The user then signs in normally. Expired links, token hashes, inactive accounts and replayed links are refused. Requests require matching Origin, JSON and rate limits.

For a lost **Group CEO** password, a trusted repository administrator can run **Recover Holdings CEO Account** from main. Generate a cryptographically random 32-byte token privately, calculate its SHA-256 hash, and give the workflow only the account email, hash and expiry (Unix milliseconds, at most 24 hours ahead). The workflow uses the existing encrypted Cloudflare API token and the production `STAFF_DB` binding, and refuses accounts without the active owner role. Never commit the raw token, a password or an API key. Share the private `/staff/#reset=RAW_TOKEN` link only with the account owner. A reviewed `.github/recovery/chairman.json` containing only the email, hash, creation and expiry can also trigger this operation; remove the request after it is prepared. Replaying the same request cannot reactivate a used link.

Ordinary staff recovery still requires administrator assistance. The public site cannot issue recovery tokens or change an account by knowing its email. There is no default password or public password-reset bypass. The original setup key never resets an existing CEO account.

## Validation

Run `node --test tests/staff-auth.test.mjs` from the repository root. These tests use Node's in-memory SQLite via a D1-compatible adapter and exercise the production request handler. The Cloudflare binding, deployed Pages Functions and browser layout still require verification in the deployed environment.

## Ranks and management tools

In **Ranks & permissions**, the Group CEO can create or rename ranks and choose feature permissions. Group Chief Executive Officer is the protected owner position. The default Holdings Staff rank cannot gain management permissions. New accounts start as Holdings Staff, and no existing staff member is automatically promoted.

The default group hierarchy is Group Chief Executive Officer, Group Chief Financial Officer, Group Chief Operating Officer, Group Chief Technology Officer, Group Chief Strategy Officer, Group Chief Corporate Services Officer, Group Company Secretary, Deputy Company Secretary, Managing Director, then Holdings Staff. The Group CEO position belongs to the existing owner account. The eight other leadership positions use the feature defaults below and are unassigned until the Group CEO chooses staff. They do not grant CEO-only controls. The new migration replaces only unused, untouched generic rank definitions; assigned or renamed legacy ranks and custom ranks retain their existing assignments and permissions. Rerunning it preserves later permission edits.

Expand **Discord role order** in the ranks screen to view and copy the current website hierarchy. Discord role names do not synchronize account access. Subsidiary-affiliation tags (such as Corendon Airlines Roblox), community roles and bots belong below the staff hierarchy and are not Holdings staff ranks. No external group's company tags are added as Altaş subsidiaries.

Use **Staff directory** to search by name, email, rank or department and assign a rank and department to an existing account. Invitations initially create a standard staff account. Assign a rank after the invitation is accepted. Rank permissions are checked on every authenticated request; demotion takes effect even in existing sessions. Refresh the portal to update its visible menus and badge.

Use **Tasks** to assign a title, details, priority and optional due date to an active staff member. Ranks with View group tasks see the latest 200 tasks across the group; everyone else sees only their own latest 200 tasks. Assignees and ranks with Assign and update group tasks can change progress between To do, In progress and Completed. Group task visibility alone does not allow changing another person’s task. The overview shows counts for the loaded tasks, announcements and resources.

**Management activity** records the latest 100 rank, staff access, invitation, content and task changes from this update onwards. Invitation secrets and passwords are never included in the activity log. The log is CEO-only.


The CEO migration binds the existing owner to the `group-ceo` position without changing account IDs, passwords, sessions or other staff assignments. The internal legacy `chairman` permission key remains for compatibility; it is never shown as a website rank. The CEO position is protected from assignment to staff or alteration through the rank editor.

## Feature permissions by rank

Every invited staff account can read shared announcements and resources, view/update its own tasks, and manage its own password. The CEO keeps full access, staff/account management, rank/permission management and the activity log. Discord roles do not authenticate or authorize Staff Hub accounts.

| Rank | Directory | Group task view | Assign/update group tasks | Manage announcements | Manage resources |
| --- | --- | --- | --- | --- | --- |
| Group Chief Executive Officer | Yes | Yes | Yes | Yes | Yes |
| Group Chief Financial Officer | Yes | Yes | Yes | No | Yes |
| Group Chief Operating Officer | Yes | Yes | Yes | Yes | Yes |
| Group Chief Technology Officer | Yes | Yes | Yes | No | Yes |
| Group Chief Strategy Officer | Yes | Yes | Yes | Yes | Yes |
| Group Chief Corporate Services Officer | Yes | Yes | Yes | Yes | Yes |
| Group Company Secretary | Yes | Yes | No | Yes | Yes |
| Deputy Company Secretary | Yes | No | No | No | Yes |
| Managing Director | Yes | Yes | Yes | Yes | Yes |
| Holdings Staff | No | No | No | No | No |

The CEO can change the five feature checkboxes for any editable rank in Ranks & permissions. Assigning tasks requires the directory and group task view; the editor applies those dependencies. The default Holdings Staff rank stays standard, and the protected CEO position cannot be assigned or edited. Custom and assigned legacy ranks retain their prior feature access on first migration. Migration 0006 uses INSERT OR IGNORE so later CEO edits survive redeployments.

All reads and writes enforce current permissions server-side on every request. Dashboard refreshes also update the visible controls, task scope and My account → Your access summary without signing out. A denied feature request refreshes the current rank’s visible access. Shared content is shared with all invited staff; this update does not add department-private document storage or audience targeting.
