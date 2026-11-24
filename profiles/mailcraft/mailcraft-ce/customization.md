# Customization ladder — MailCraft (family `mailcraft`)

**Grade: unknown** · not characterized against the rubric.

Framework: [gentian-os/docs/guides/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/guides/app-customization.md).

A static WebAssembly app with no server side of its own. The image adds a small server (`images/app-host`, jmap mode) that serves the build and a script naming the person's account at the workspace's JMAP mail server.

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | barely | `spec.extraValues` → `charts/mailcraft` (replicas, resources, `jmap.session`) |
| **L1** Drop-in | no | nothing is read at run time |
| **L2** Companion | yes | the host script names the account and hands the token through upstream's host contract (`window.mailcraftJmap`, `docs/jmap.md` upstream) |
| **L3** Extension | no | none used here |
| **L4** Repackage | yes | first-party chart and image (`charts/mailcraft`, `images/mailcraft`), `chartOwnership: gentian-owned` |
| **L5** Patch | no | the release's web build is served unchanged |
| **L6** Fork | no | not permitted |
