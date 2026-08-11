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
