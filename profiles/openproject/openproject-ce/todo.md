# OpenProject community profile — follow-ups

- [ ] E2E: port `e2e-tests/tests/test_openproject-ce*.py` to use `openproject-ce` profile name
- [ ] Optional Nextcloud WebDAV integration binding on demo tenant
- [ ] First deploy: confirm on a cluster what the end-to-end run shows in docker — the seeder and the web pod reach the platform's object store through `valueMapping.s3` alone (endpoint as a URL, path style, no `s3.host`).
- [ ] The chart's collaboration server (`hocuspocus`, on by default in chart 12) is deployed and not routed: `/hocuspocus` leads to the web pod. Route it or switch it off.
