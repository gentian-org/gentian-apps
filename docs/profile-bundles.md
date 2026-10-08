# Profile bundles

What a profile's directory becomes when the catalogue is published, and what it may hold. For
profile authors. The cluster's side of the same rules is in gentian-os,
[docs/custom-catalogues.md](https://github.com/gentian-org/gentian-os/blob/main/docs/custom-catalogues.md).

## One profile, one file, one fingerprint

A cluster installs an app from one file, `profiles/<name>.yaml` of the published catalogue, at one
digest. That file is the profile's **bundle**: the `ComponentProfile` first and, after it, every
other object the app needs on a cluster — its **companions**. The digest in `index.yaml` is the
sha256 of the whole file, so an install is pinned to the profile and to everything that travels with
it.

A profile with no companions is published byte for byte as its `profile.yaml`.

Nothing else from a profile's directory reaches a cluster. There is no other path: what is not in
the bundle is not there.

## The sources

Everything stays in the profile's directory, `profiles/[<family>/]<name>/`:

| File | Becomes |
|---|---|
| `profile.yaml` | the bundle's first document, unchanged |
| `composition.yaml` | a `Composition` companion |
| `oidc-catalog.yaml` | an `OIDCPackCatalog` companion |
| `customizations/<record>.yaml` | a `Customization` companion |
| files under `assets/`, named by a `configMapGenerator` | a `ConfigMap` companion |
| `listing.yaml` | `listings/<name>.yaml` beside the bundles, for the App Store; not in the bundle |
| `*.md`, tile art, anything not listed | nothing; it stays in the repository |

`kustomization.yaml` is the list. `scripts/build-catalogue-source.py` reads it and puts into the
bundle exactly what it names:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - profile.yaml
  - customizations/sign-in-sidecar.yaml
configMapGenerator:
  - name: openproject-ce.sign-in-handler
    files:
      - handler.js=assets/sign-in-handler.js
generatorOptions:
  disableNameSuffixHash: true
  labels:
    gentianos.io/profile-name: openproject-ce
    gentianos.io/asset: sign-in-handler
```

The file is read, not run: only `resources`, `configMapGenerator` (`name` and `files`) and
`generatorOptions.labels` mean anything, and the build fails on any other key. Each file under
`resources` holds one object and goes in unchanged, comments included. Companions follow the
profile ordered by kind and then by name, so the same tree always gives the same bytes and the same
digest. `kubectl kustomize <dir>` still renders the directory, and CI still runs it.

The family's `AppPackage` presets (`profiles/<family>/packages/`) are not companions. Nothing on a
cluster reads a preset; they are published under `packages/` for the App Store.

## What a bundle may hold

Four kinds, each with the one name it may have. The cluster refuses the whole bundle for anything
else, and the build refuses it first.

| Kind | Name | Also |
|---|---|---|
| `Composition` | `app-<profile>`, at most one | composes `XApp`; `spec.package.composition` in the profile names it |
| `OIDCPackCatalog` | `<profile>-oidc`, at most one | every pack is keyed by a `clientId` or `oidcPackRef` the profile states; no `serviceClient` |
| `ConfigMap` | `<profile>.<asset>` | label `gentianos.io/asset: <asset>`; text files only |
| `Customization` | `<profile>.<record>` | `spec.target.profile` is the profile; `spec.scope: profile` |

Every companion:

- carries the label `gentianos.io/profile-name: <profile>` and no other label (a ConfigMap: that and
  `gentianos.io/asset`);
- states no namespace. A ConfigMap or a Customization is applied where the cluster applies its
  catalogue. A composition that reads a companion finds it by its labels, never by a namespace;
- states no annotations, owner, finalizer or status.

The bundle may be at most 180 KiB.

A companion in one bundle is that profile's alone. An add-on that needs what its base brings uses
the base's: an add-on is active only inside its base, whose bundle is on the cluster with it.

## Who may bring companions

A catalogue that a cluster's administrator added for the whole cluster. This catalogue is one. A
bundle served from a tenant's own catalogue is its profile and nothing else — a profile written for
such a catalogue must work with `app-default` and without an OIDC pack.

A `Composition` creates objects with the rights of the cluster's providers. An administrator who
adds this catalogue trusts every Composition in it as they trust the platform's own; treat a change
to a `composition.yaml` accordingly.

## Checking a bundle

```bash
python3 scripts/build-catalogue-source.py --check     # every bundle, against the rules above
python3 scripts/build-catalogue-source.py --out dist/catalogue
```

The second leaves the published files in `dist/catalogue/profiles/`. gentian-os tests copies of
these against the director's and the operator's own checks
(`internal/profilebundle/testdata/bundles`); when a bundle's companions change shape, refresh them
there.
