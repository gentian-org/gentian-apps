# Nextcloud base — follow-ups

- [ ] Direct (bind) mounting for Collabora document jails, instead of the
      `mount_jail_tree=false` copy fallback in `base-ce`/`base-od`. Seccomp
      `Unconfined` is already in place and is a real prerequisite, but not
      sufficient: `coolmount`'s mount namespace creation happens in a forked
      child that deliberately drops all capabilities first (mirroring the
      real per-document jail workers), so no container-level capability or
      AppArmor grant reaches it — tried and reverted `SYS_ADMIN` +
      `appArmorProfile: Unconfined`, neither helped. The actual blocker is
      Ubuntu 24.04's node-wide AppArmor restriction on unprivileged
      user-namespace creation; fixing it needs a node/cluster-level
      kernel/AppArmor policy change (broader blast radius than one profile),
      not a profile-level tweak.

- [ ] Move the portal-embedding chrome rules off core templates and onto the
      declared `theming` drop-in. `customization.md` scores Nextcloud
      `supportedRungs: [L0, L1, L3, L4]` and the profile sets
      `patch.allowed: false`, but `patch_nextcloud_layouts()` in the
      `before-starting` hook rewrites `core/templates/layout.{user,public}.php`
      — core source, i.e. an L5 shape at runtime. The L1 home for it is already
      declared and empty: `/var/www/html/themes/gentian` (drop-in `theming`,
      `tenantEditable: true`), with no `'theme' => 'gentian'` in config.
      Nextcloud's resource locator appends `themes/<theme>/core/css/server.css`
      after the core stylesheet, so the CSS block (see app-profile-guide.md
      §6f) belongs there and the template patch shrinks to the one line that
      sets `html.gentian-embedded` — iframe detection needs JS, so some
      injection point remains either way. Two things to settle before doing it:
      whether `themes/<theme>/core/templates/layout.user.php` is a better host
      than patching core (it is a full template copy, so it drifts on every
      Nextcloud major), and that `tenantEditable: true` on the drop-in does not
      let a tenant break their own portal embedding.
