'use strict';

// What an app's profile says about its sign-in, read from the profile itself:
// the end-to-end run uses the lists a cluster would use, not a copy of them.

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const REPO = path.join(__dirname, '..', '..', '..', '..');

function signInOf(profileDir) {
    const dir = path.join(REPO, profileDir);
    const profile = YAML.parse(fs.readFileSync(path.join(dir, 'profile.yaml'), 'utf8'));
    const sidecar = profile.spec.requires.services.identity.sidecar;
    if (!sidecar) throw new Error(`${profileDir} declares no requires.services.identity.sidecar`);
    const entry = profile.spec.expose.find((e) => e.surface === 'gateway' && e.authMode === 'oidc' &&
        (!sidecar.exposure || e.name === sidecar.exposure));
    return {
        handler: path.join(dir, 'assets', 'sign-in-handler.js'),
        entryPaths: sidecar.entryPaths || [],
        denyPaths: entry.denyPaths || [],
        secrets: sidecar.secrets || [],
        database: Boolean(sidecar.database),
        appPort: sidecar.appPort,
    };
}

module.exports = { signInOf, REPO };
