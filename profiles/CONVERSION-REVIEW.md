# Conversion review

33 profiles converted, 100 items a person has to decide.

## activepieces-me

- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it
- requires.privileges.egress/egress-1: write the reason the tenant administrator will read, and give it a name that says where it goes
- tile/activepieces-me: no SVG, so the placeholder was used. The old profile named the built-in glyph 'analytics'. Draw this component's own art into assets/tile.svg and re-run gentian-apps' scripts/sync-profile-tile.py

## docmost-ce

- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it

## element-ce

- trustTier was absent; set to experimental, the tier that claims nothing
- catalogueVersion was absent; version set to 0.0.0
- package: dropped compositionRef 'app-element' — the composition that renders an app is chosen by the claim, and nothing reads this field
- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it
- expose/web: dropped ingress annotations ['nginx.ingress.kubernetes.io/proxy-body-size', 'nginx.ingress.kubernetes.io/proxy-read-timeout', 'nginx.ingress.kubernetes.io/proxy-send-timeout'] — body size and timeouts are the gateway's policy now
- expose/matrix: dropped ingress annotations ['nginx.ingress.kubernetes.io/proxy-body-size', 'nginx.ingress.kubernetes.io/proxy-read-timeout', 'nginx.ingress.kubernetes.io/proxy-send-timeout'] — body size and timeouts are the gateway's policy now
- browserProxy /matrix -> http://synapse-web.{namespace}.svc/_matrix/ was DROPPED. The portal no longer proxies for apps, and an exposure's backend must be a Service in the tenant's namespace. If this route is still needed, the app has to serve that path itself or ship a Service for it
- tile/element-ce: no SVG, so the placeholder was used. The old profile named the built-in glyph 'chat'. Draw this component's own art into assets/tile.svg and re-run gentian-apps' scripts/sync-profile-tile.py

## gentian-subscriptions-me

- trustTier was absent; set to experimental, the tier that claims nothing
- catalogueVersion was absent; version set to 0.0.0
- package: dropped deploymentMethod 'api' — delivery is read from which package kind is present and can no longer contradict it
- portalTiles: an API-delivered entry has no Service, so there is no exposure to hang its tile on. The tile opens package.api.baseUrl through the portal-proxy runtime; decide how that is declared before this profile ships, or the entry installs and is invisible

## mathesar-ce

- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it
- tile/mathesar-ce: no SVG, so the placeholder was used. The old profile named the built-in glyph 'database'. Draw this component's own art into assets/tile.svg and re-run gentian-apps' scripts/sync-profile-tile.py

## nextcloud-calendar-ce

- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it

## nextcloud-collectives-ce

- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it

## nextcloud-contacts-ce

- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it

## nextcloud-deck-ce

- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it

## nextcloud-forms-ce

- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it

## nextcloud-mail-ce

- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it

## nextcloud-richdocuments-ce

- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it

## nextcloud-spreed-ce

- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it

## nextcloud-tasks-ce

- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it

## nextcloud-base-ce

- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it
- requires.privileges.podSecurity/gentian-disallow-privilege-escalation-co: write the reason the security officer will read
- requires.privileges.podSecurity/gentian-restrict-capabilities-collabora: write the reason the security officer will read
- requires.privileges.podSecurity/gentian-require-seccomp-collabora: write the reason the security officer will read
- expose/web: dropped ingress annotations ['gentianos.io/gateway-buffer-limit', 'gentianos.io/gateway-request-timeout'] — body size and timeouts are the gateway's policy now
- expose/collabora: dropped ingress annotations ['gentianos.io/gateway-buffer-limit', 'gentianos.io/gateway-escaped-slashes-action', 'gentianos.io/gateway-frame-ancestors', 'gentianos.io/gateway-request-timeout'] — body size and timeouts are the gateway's policy now

## nextcloud-base-od

- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it
- expose/web: dropped ingress annotations ['nginx.ingress.kubernetes.io/proxy-body-size', 'nginx.ingress.kubernetes.io/proxy-read-timeout', 'nginx.ingress.kubernetes.io/proxy-send-timeout'] — body size and timeouts are the gateway's policy now

## odoo-accounting-ce

- package: dropped chart — an addon activates inside its base and runs nothing of its own; these are from the standalone era
- package: dropped compositionRef 'app-odoo' — the composition that renders an app is chosen by the claim, and nothing reads this field
- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it

## odoo-calendar-ce

- package: dropped chart — an addon activates inside its base and runs nothing of its own; these are from the standalone era
- package: dropped compositionRef 'app-odoo' — the composition that renders an app is chosen by the claim, and nothing reads this field
- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it

## odoo-contacts-ce

- package: dropped chart — an addon activates inside its base and runs nothing of its own; these are from the standalone era
- package: dropped compositionRef 'app-odoo' — the composition that renders an app is chosen by the claim, and nothing reads this field
- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it

## odoo-crm-ce

- package: dropped chart — an addon activates inside its base and runs nothing of its own; these are from the standalone era
- package: dropped compositionRef 'app-odoo' — the composition that renders an app is chosen by the claim, and nothing reads this field
- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it

## odoo-employees-ce

- package: dropped chart — an addon activates inside its base and runs nothing of its own; these are from the standalone era
- package: dropped compositionRef 'app-odoo' — the composition that renders an app is chosen by the claim, and nothing reads this field
- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it

## odoo-inventory-ce

- package: dropped chart — an addon activates inside its base and runs nothing of its own; these are from the standalone era
- package: dropped compositionRef 'app-odoo' — the composition that renders an app is chosen by the claim, and nothing reads this field
- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it

## odoo-mrp-ce

- package: dropped chart — an addon activates inside its base and runs nothing of its own; these are from the standalone era
- package: dropped compositionRef 'app-odoo' — the composition that renders an app is chosen by the claim, and nothing reads this field
- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it

## odoo-pos-ce

- package: dropped chart — an addon activates inside its base and runs nothing of its own; these are from the standalone era
- package: dropped compositionRef 'app-odoo' — the composition that renders an app is chosen by the claim, and nothing reads this field
- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it

## odoo-project-ce

- package: dropped chart — an addon activates inside its base and runs nothing of its own; these are from the standalone era
- package: dropped compositionRef 'app-odoo' — the composition that renders an app is chosen by the claim, and nothing reads this field
- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it

## odoo-purchase-ce

- package: dropped chart — an addon activates inside its base and runs nothing of its own; these are from the standalone era
- package: dropped compositionRef 'app-odoo' — the composition that renders an app is chosen by the claim, and nothing reads this field
- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it

## odoo-sales-ce

- package: dropped chart — an addon activates inside its base and runs nothing of its own; these are from the standalone era
- package: dropped compositionRef 'app-odoo' — the composition that renders an app is chosen by the claim, and nothing reads this field
- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it

## odoo-base-ce

- package: dropped compositionRef 'app-odoo' — the composition that renders an app is chosen by the claim, and nothing reads this field
- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it
- requires.privileges.egress/egress-1: write the reason the tenant administrator will read, and give it a name that says where it goes
- requires.privileges.egress/egress-2: write the reason the tenant administrator will read, and give it a name that says where it goes
- expose/web: dropped ingress annotations ['gentianos.io/gateway-request-timeout'] — body size and timeouts are the gateway's policy now
- tile/odoo-admin: allowedGroup was 'App Admins'; relation is can_launch, which is entitlement to the app. Narrow it if that group meant something else

## open-webui

- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it
- secrets.derived: derived secrets rotate silently if the formula or its inputs change; move to generated unless something external recomputes the value
- tile/open-webui: no SVG, so the placeholder was used. The old profile named the built-in glyph 'chat'. Draw this component's own art into assets/tile.svg and re-run gentian-apps' scripts/sync-profile-tile.py
- tile/open-webui-admin: no SVG, so the placeholder was used. The old profile named the built-in glyph 'chat'. Draw this component's own art into assets/tile.svg and re-run gentian-apps' scripts/sync-profile-tile.py
- tile/open-webui-admin: allowedGroup was 'Tenant Admins'; relation is can_launch, which is entitlement to the app. Narrow it if that group meant something else

## openproject-ce

- package: dropped compositionRef 'app-openproject' — the composition that renders an app is chosen by the claim, and nothing reads this field
- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it
- expose/web: dropped ingress annotations ['gentianos.io/gateway-buffer-limit', 'gentianos.io/gateway-request-timeout'] — body size and timeouts are the gateway's policy now
- browserProxy /api -> http://openproject-ce.{namespace}.svc/api/v3/ was DROPPED. The portal no longer proxies for apps, and an exposure's backend must be a Service in the tenant's namespace. If this route is still needed, the app has to serve that path itself or ship a Service for it
- tile/openproject-ce: no SVG, so the placeholder was used. The old profile named the built-in glyph 'projects'. Draw this component's own art into assets/tile.svg and re-run gentian-apps' scripts/sync-profile-tile.py

## xwiki-ce

- package: dropped deploymentMethod 'crossplane' — delivery is read from which package kind is present and can no longer contradict it
- expose/web: dropped ingress annotations ['gentianos.io/gateway-buffer-limit', 'gentianos.io/gateway-request-timeout'] — body size and timeouts are the gateway's policy now
- tile/xwiki-ce: no SVG, so the placeholder was used. The old profile named the built-in glyph 'wiki'. Draw this component's own art into assets/tile.svg and re-run gentian-apps' scripts/sync-profile-tile.py
