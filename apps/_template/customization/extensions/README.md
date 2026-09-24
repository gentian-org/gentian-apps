# Writing a plugin (rung L3)

A plugin extends this app **from inside**: it can add API routes, contribute
configuration defaults, react to events, and render UI into declared slots — without
forking the app.

Use L3 when the feature must live inside the app's own surface. If it can stand alone,
build a companion app (L2) instead: companions bind only to the published API and
survive major upgrades untouched.

## The contract

`backend/app/extensions/api.py` is public API:

```python
EXTENSION_API_VERSION = "1.0.0"   # semver
SUPPORTED_MAJOR_VERSIONS = (1,)   # N-2 support
```

- **minor** bumps are additive; your plugin keeps working.
- **major** bumps are breaking, announced one minor ahead.
- Anything under `app.extensions.proposed` is unstable — do not ship it to tenants.

A plugin declaring an unsupported major is **refused at load**, with the reason
reported at `GET /api/v1/extensions`. It is never partially loaded.

## Minimal plugin

See [`example_plugin/`](example_plugin/). Three parts:

1. A class with `api_version` and whichever hooks you need — all hooks are optional.
2. An entry point under `gentian.app.<app-id>.plugins` in your `pyproject.toml`.
3. Optionally, a UI bundle registering contributions against named slots.

```toml
[project.entry-points."gentian.app.gentian-app.plugins"]
example = "gentian_example_plugin:ExamplePlugin"
```

## Hooks

| Hook | Purpose | Notes |
|---|---|---|
| `register_routes(router)` | add HTTP routes | mounted at `/api/v1/ext/<plugin-name>` — no collisions |
| `register_settings()` | contribute config defaults | sits **below** every other layer; cannot override operator or tenant config |
| `on_event(event, payload)` | react to app events | must not raise; exceptions are logged and swallowed |

## Frontend slots

```tsx
import { register } from '@/extensions/registry'

register({
  name: 'example',
  apiVersion: '1.0.0',
  slots: {
    'dashboard.widgets': [{ id: 'example-widget', order: 50, component: ExampleWidget }],
  },
})
```

Declared slots: `dashboard.widgets`, `nav.primary`, `settings.sections`, `item.actions`.
Each contribution renders inside an error boundary, so a broken plugin degrades to a
missing widget rather than a blank page.

## Rules

- **Never import from outside the declared contract.** Reaching into app internals is
  how a plugin becomes a fork you cannot upgrade.
- **Pin the app versions you test against** and record them in `testMatrix`.
- **Write a `Customization` record** before the code — required from L2 up.
- **No secrets in plugin config.** Credentials arrive via ESO, not via settings.
