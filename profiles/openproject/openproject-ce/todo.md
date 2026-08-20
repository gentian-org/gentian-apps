# OpenProject community profile — follow-ups

- [ ] E2E: port `e2e-tests/tests/test_openproject-ce*.py` to use `openproject-ce` profile name
- [ ] Verify `openproject-ce/openproject-ce:16-slim` OIDC claim mapping vs `open_desk` image
- [ ] Optional Nextcloud WebDAV integration binding on demo tenant
- [ ] App administrator provisioner (privileged in-app role) when operator supports OpenProject OCS/API
- [ ] First deploy: verify object storage still works after the S3 contract change (gentian-apps `ca59db0`). Endpoint, bucket, region and access key now arrive through `valueMapping.s3` instead of being literals, and `s3.host` — previously set to the same value as `s3.endpoint` — is no longer set at all, because only one endpoint key can be mapped. The upstream chart is third-party, so whether it reads `host` as well as `endpoint` is unverified. If it does, raise it upstream rather than substituting a hostname back in here. See the comment beside `s3:` in `profile.yaml`.
