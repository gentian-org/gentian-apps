# Branches, artefacts and releases

## Branches

| Branch | What it is | Who writes to it |
|--------|------------|------------------|
| `develop` | Where work lands. | Everybody, by pull request or push. |
| `main` | What is released. It moves only when a tested `develop` is merged into it, and a release is a tag on it. | The release, nobody else. |
| `v05` | The branch the new architecture was built on. **Frozen**: it was merged into `develop` and stays only because documents and open work refer to it. | Nobody. |

## What CI publishes from where

Every check runs on every branch and every pull request: profile and bundle validation, the
catalogue build, chart lint and packaging, image builds. What differs is what is pushed.

| | `main` | `develop` | any other branch, any pull request |
|---|---|---|---|
| Image | under the names the build states — its version, `latest`, the commit sha | `develop-<sha7>` only | built, not pushed |
| Chart | the version in `Chart.yaml` (`charts/activepieces/UPSTREAM` for Activepieces) | `<version>-develop.<sha7>`, immutable, and `<version>-develop`, moving, its `appVersion` naming the immutable one | packaged or linted, not pushed |
| Catalogue | `https://gentian-org.github.io/gentian-apps/` | `https://gentian-org.github.io/gentian-apps/develop/` | built and checked, not published |

`<sha7>` is the first seven characters of the commit. A develop name can never be a release's
name, so a build of `develop` cannot overwrite anything a released catalogue pins. The naming is
[gentian-ui](https://github.com/gentian-org/gentian-ui)'s.

A chart from `develop` whose only image is built here (the git-modules sidecar, `nextcloud-mcp`) names
that commit's `develop-<sha7>` image instead of the tag in its `values.yaml`.

The sign-in sidecar (`images/gentian-sidecar-sso-saml`) has no chart: the platform runs it, and
names the build it runs. gentian-os is pointed at a new build of it the same way a profile is
pointed at a new chart, in a commit there.

**A profile pins a chart by version, and a profile on `develop` pins a released one.** A chart
changed on `develop` is therefore not what a develop cluster installs until either the profile
is pointed, in a later commit, at the `<version>-develop.<sha7>` that CI published for the chart
change, or the change is released from `main` under its plain version. A profile must be back on
a plain version before `develop` is merged into `main`: a released catalogue names released
charts only.

## Two catalogues, one site

GitHub Pages gives a repository one site, and a deployment replaces all of it. Each deployment
therefore carries both catalogues: the branch that was pushed is built at that commit, the other
at its head. A push to `develop` additionally compares the root it built from `main` with what is
being served, file by file, and stops if anything differs — the released catalogue changes when
`main` does and at no other time.

The `github-pages` environment must allow both `main` and `develop` to deploy (Settings →
Environments → github-pages → Deployment branches and tags). Where it does not, the run says so
and publishes nothing rather than failing.

Until this workflow is on `main` as well, a push to `main` publishes the root alone and the
develop catalogue is gone until the next push to `develop`.

A catalogue is relocatable: nothing in it names its own address. A cluster reads
`<address>/index.yaml` and `<address>/profiles/<name>.yaml`, and admits a bundle by the digest
the index states, so the same files serve from either path.

## Releases

**A platform release is one tag, `vX.Y.Z`, on gentian-os, gentian-ui and gentian-apps.** The three
tags mark what was tested together: that platform, those UIs, this catalogue. In this repository
the tag goes on the `main` commit the catalogue was published from. Nothing is built from the
tag — `main` already published the artefacts — so the workflow has no tag trigger.

The catalogue may move between platform releases: an app is added or updated on `main` without a
new platform. So a newer catalogue has to stay readable by an older platform, and the rule that
keeps it so has two halves:

- **A platform refuses what it does not know.** A bundle holding an object of a kind or a name
  the platform does not allow is refused whole, never installed in part
  ([profile-bundles.md](profile-bundles.md)).
- **A new bundle feature lands on the platform first.** It may be used in a profile on `main`
  only once a released platform reads it; until then it lives on `develop`, which is what
  development clusters read.
