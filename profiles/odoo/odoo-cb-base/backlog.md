# Odoo SSO Backlog

## Goal: Eliminate Keycloak Popup for Embedded Odoo Apps

Currently, Odoo embedded apps require an intermediate popup window to bootstrap the Keycloak session (due to mobile Safari/ITP blocking third-party cookies in iframes). To achieve seamless, zero-click SSO that adheres strictly to Gentian OS architecture principles, we will migrate Odoo from standard OIDC to the generic `portal-bridge` protocol.

## Implementation Plan

### 1. Update Gentian UI for Deep Linking Support
- **File**: `gentian-ui/frontend/src/auth/portalBridge.ts`
- **Action**: Currently, `portalBridgeLaunchUrl` drops original app URL parameters (like Odoo's `#action=...`). Update the utility to pass the original URL components via a `redirect` query parameter to `/portal-sso.html`. Update calls in `DesktopPage.tsx` and `MobilePage.tsx` to pass the full `appUrl`.
- **Reasoning**: This ensures any app using `portal-bridge` can have deep links preserved.

### 2. Implement `portal-bridge` in Odoo via `gentian_os`
- **File**: `odoo-modules/gentian_os/controllers/web_client.py`
- **Action**: Add a new generic controller `@http.route('/portal-sso.html', type='http', auth='none')`.
- **Logic**:
  1. The controller receives the one-time ticket via the `t` query parameter (e.g., `?t=<ticket>&redirect=<target_view>`).
  2. Odoo makes a server-to-server HTTP request to the portal's public ticket redemption endpoint: `GET https://desk.{tenant_domain}/api/v1/session/bridge/redeem/{t}`.
  3. Upon successful validation, the endpoint returns the user's `email` (and groups).
  4. Odoo matches the email to `res.users` and logs the user in (setting `session.uid`, etc.).
  5. Finally, redirect the user to the view specified in the `redirect` query parameter.
- **Reasoning**: This completely encapsulates the logic within the `gentian_os` module and does not require Odoo-specific logic in the `gentian-ui` core.

### 3. Update Odoo AppProfiles
- **Files**: `gentian-apps/profiles/odoo/odoo-cb-*/profile.yaml` (Base and module profiles)
- **Action**: Change `gentianos.io/portal-auth-mode: oidc` to `gentianos.io/portal-auth-mode: portal-bridge`.
- **Reasoning**: This declaratively instructs the generic Gentian UI to use the `portal-bridge` flow for Odoo instead of popping up the Keycloak window.

## Architectural Integrity
This solution is highly elegant and respects the Gentian OS architecture:
- No hardcoded `if "odoo" in profile` logic in the platform core.
- No SSO sidecar proxies needed (saving resources and complexity).
- Immune to mobile Safari Intelligent Tracking Prevention (ITP) issues.
- Adheres entirely to existing platform patterns.

---

## Future Backlog: Direct GitHub Sync for Private Repositories

Currently, the `git-sync` sidecar clones from a local git daemon mirror (`git://192.168.0.100:9418/odoo-modules`) to bypass namespace egress block and private repository authentication. We should investigate transitioning this to sync directly from the remote GitHub repository (`https://github.com/gentian-org/odoo-modules.git`).

### Plan
1. Add custom egress NetworkPolicy exceptions to allow the sidecar pods to connect to GitHub (port 22 for SSH or 443 for HTTPS).
2. Update the `git-modules` sidecar chart to mount an SSH private key or Personal Access Token from a Secret.
3. Configure `profile.yaml` to point to GitHub directly instead of the host VM's git daemon.

