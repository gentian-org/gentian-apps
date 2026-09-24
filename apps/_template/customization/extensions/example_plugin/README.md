# Example plugin

A working, minimal plugin for an app built from `gentian-app-template`.

```bash
pip install -e customization/extensions/example_plugin
uvicorn app.main:app --reload
curl localhost:8000/api/v1/ext/example/greeting
curl localhost:8000/api/v1/extensions | jq
```

The second call shows the plugin under `extensions.loaded`. If it appears under
`failed` instead, the message says why — usually an `api_version` outside the host's
supported majors.
