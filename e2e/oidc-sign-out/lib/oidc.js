'use strict';

// What an app that signs people in itself (OIDC) needs around it for an
// end-to-end run, set up the way the platform sets it up on a cluster:
//
//   - Keycloak as the platform runs it, answering inside the network under
//     the Service name profiles call it by;
//   - the app's client at the tenant's realm, as the platform's Composition
//     registers it from the profile (gentian-os,
//     crossplane/compositions/app-default.yaml) -- with the address the
//     realm tells the app of a sign-out at built the way the Composition
//     builds it: from the Service and port of the profile's own entry, in
//     the tenant's namespace, and the path the profile declares;
//   - that Service: a name inside the network that passes every request on
//     to the app's container as it came, and keeps what the realm posted.
//
// The network is outside the private address ranges on purpose. Several apps
// believe a caller from a private range to be their reverse proxy and then
// ignore the Host header; here nobody is believed, so an app that checks the
// name it is called by is shown the name the realm really calls.

const SIDECAR_E2E = '../../../images/gentian-sidecar-sso-saml/e2e/lib';

process.env.E2E_NETWORK = process.env.E2E_OIDC_NETWORK || `${process.env.E2E_NETWORK || 'sso-e2e'}-oidc`;
const setup = require(`${SIDECAR_E2E}/setup`);
const { Browser, keycloak } = require(`${SIDECAR_E2E}/browser`);
const { REPO } = require(`${SIDECAR_E2E}/profile`);

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
// The sidecar's own development dependency: one YAML parser for both runs.
const YAML = require(path.join(REPO, 'images', 'gentian-sidecar-sso-saml', 'node_modules', 'yaml'));

const SUBNET = process.env.E2E_OIDC_SUBNET || '100.64.87.0/24';
// Keycloak's Service on a cluster, which profiles name in their settings.
const IDP_SERVICE = 'gentian-idp-keycloak-keycloakx-http.kernel-authentication.svc.cluster.local';
const TAP_IMAGE = process.env.E2E_SIDECAR_IMAGE || 'sso-sidecar:e2e';

const TENANT = 'acme';
const NAMESPACE = `tenant-${TENANT}`;
const KERNEL_DOMAIN = 'e2e.test';
const DOMAIN = `${TENANT}.${KERNEL_DOMAIN}`;

async function startKeycloak() {
    setup.tryDocker('network', 'create', '--subnet', SUBNET, setup.NETWORK);
    return setup.startKeycloak({ backchannelDynamic: true, aliases: [IDP_SERVICE] });
}

// The realm's public address, reachable inside the network as it is inside a
// cluster: by its public name, over TLS. An app that is told the realm's
// public address and reads the realm's own description of itself there
// needs it. Answers the certificate, for the app to trust as it trusts the
// cluster's. host is that name: another cluster's realm is at another.
function startPublicIdp(kc, host = setup.IDP_HOST) {
    const name = host === setup.IDP_HOST ? `${setup.NETWORK}-idp-tls` : `${setup.NETWORK}-idp-tls-${host}`;
    const dir = path.join(os.tmpdir(), `${name}-tls`);
    if (!setup.tryDocker('ps', '-q', '-f', `name=^${name}$`) || !fs.existsSync(path.join(dir, 'cert.pem'))) {
        setup.tryDocker('rm', '-f', name);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', `/CN=${host}`,
            '-addext', `subjectAltName=DNS:${host}`,
            '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
        fs.chmodSync(dir, 0o755);
        for (const f of ['key.pem', 'cert.pem']) fs.chmodSync(path.join(dir, f), 0o644);
        setup.docker('run', '-d', '--name', name, '--network', setup.NETWORK, '--network-alias', host,
            '--read-only', '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges', '--user', '0:0',
            '-e', `FRONT_TARGET=http://${kc.name}:8080`, '-e', `FRONT_HOST=${host}`,
            '-v', `${dir}:/tls:ro`, '-v', `${path.join(__dirname, 'tls-front.js')}:/tls-front.js:ro`,
            '--entrypoint', 'node', TAP_IMAGE, '/tls-front.js');
    }
    return { name, certificate: path.join(dir, 'cert.pem') };
}

// The tenant's realm with its people, as the platform holds them (gentian-os,
// internal/registrar/identity/people.go and
// internal/controller/keycloak_gentian_groups.go):
//
//   - a person's username is their workspace address, which is what they
//     sign in with and where their mailbox is;
//   - the account's e-mail field holds another address, a private one, which
//     the realm mails a password reset to;
//   - the realm's own "email" scope reads the username, so that the claim
//     "email" is the workspace address. A profile's pack has a mapper of its
//     own for that claim, and of two mappers that write one claim the realm
//     lets either win: both have to read the username;
//   - a person's account name in an app is the attribute "uid", which the
//     packs' mappers read.
async function ensureRealm(kc, realm, people) {
    await kc.admin('POST', '/realms', { realm, enabled: true, ssoSessionMaxLifespan: 43200, accessTokenLifespan: 300 });
    const profile = JSON.parse((await kc.admin('GET', `/realms/${realm}/users/profile`)).body);
    if (profile.unmanagedAttributePolicy !== 'ENABLED') {
        await kc.admin('PUT', `/realms/${realm}/users/profile`, { ...profile, unmanagedAttributePolicy: 'ENABLED' });
    }
    const scopes = JSON.parse((await kc.admin('GET', `/realms/${realm}/client-scopes`)).body);
    const scope = scopes.find((s) => s.name === 'email');
    const mapper = scope.protocolMappers.find((m) => m.name === 'email');
    await kc.admin('PUT', `/realms/${realm}/client-scopes/${scope.id}/protocol-mappers/models/${mapper.id}`,
        { ...mapper, config: { ...mapper.config, 'user.attribute': 'username' } });
    for (const person of people) {
        if (person.recovery === person.address) throw new Error(`${person.uid}: the recovery address has to differ from the workspace address`);
        await kc.admin('POST', `/realms/${realm}/users`, {
            username: person.address, email: person.recovery, emailVerified: true, enabled: true,
            firstName: person.firstName, lastName: person.lastName,
            attributes: { uid: [person.uid] },
            credentials: [{ type: 'password', value: person.password, temporary: false }],
        });
    }
}

// A person of the realm, found by what they sign in with.
async function personId(kc, realm, person) {
    const found = JSON.parse((await kc.admin('GET', `/realms/${realm}/users?username=${encodeURIComponent(person.address)}&exact=true`)).body);
    if (found.length !== 1) throw new Error(`no person ${person.address} in ${realm}`);
    return found[0].id;
}

// What every mapper that writes the claim "email" for a client reads: the
// client's own mappers and those of each scope it is given. The realm lets
// either of two such mappers win, so what an app is told is only certain
// when they all read the same.
async function emailSources(kc, realm, clientUuid) {
    const base = `/realms/${realm}`;
    const effective = JSON.parse((await kc.admin('GET', `${base}/clients/${clientUuid}/evaluate-scopes/protocol-mappers?scope=openid`)).body);
    const sources = [];
    for (const m of effective) {
        const owner = m.containerType === 'client' ? `clients/${clientUuid}` : `client-scopes/${m.containerId}`;
        const model = JSON.parse((await kc.admin('GET', `${base}/${owner}/protocol-mappers/models/${m.mapperId}`)).body);
        if (model.config && model.config['claim.name'] === 'email') sources.push({ from: m.containerName, reads: model.config['user.attribute'] });
    }
    return sources;
}

function fill(text, extra = {}) {
    const values = {
        TENANT_DOMAIN: DOMAIN, TENANT_NAMESPACE: NAMESPACE, TENANT_ID: TENANT, KERNEL_DOMAIN, ...extra,
    };
    return text.replace(/\$\{([A-Z_]+)\}/g, (whole, name) => (name in values ? values[name] : whole));
}

// A profile as a cluster holds it: its text with the placeholders the
// platform fills in filled in, and the OIDC pack beside it.
function profileOf(profileDir) {
    const dir = path.join(REPO, profileDir);
    const raw = YAML.parse(fs.readFileSync(path.join(dir, 'profile.yaml'), 'utf8'));
    const app = raw.metadata.name;
    const profile = YAML.parse(fill(fs.readFileSync(path.join(dir, 'profile.yaml'), 'utf8'), { APP_ID: app }));
    const catalogFile = path.join(dir, 'oidc-catalog.yaml');
    const catalog = fs.existsSync(catalogFile) ? YAML.parse(fs.readFileSync(catalogFile, 'utf8')) : null;
    return { app, spec: profile.spec, raw: raw.spec, catalog, dir };
}

// Where the realm tells the app of a sign-out, built as the platform's
// Composition builds it: the Service and port of the entry the profile
// names, in the tenant's namespace, and the path the profile declares.
// Nothing else of the address is the profile's to say.
function signOutAddress(profile) {
    const declared = profile.spec.requires.services.identity.oidc.backchannelLogout;
    if (!declared) throw new Error(`${profile.app} declares no identity.oidc.backchannelLogout`);
    const entry = profile.spec.expose.find((e) => e.name === declared.exposure);
    if (!entry) throw new Error(`${profile.app}: backchannelLogout names entry ${declared.exposure}, which the profile does not have`);
    if (entry.backend.component) throw new Error(`${profile.app}: entry ${entry.name} routes to another component`);
    if (!/^\/[A-Za-z0-9._~/-]*$/.test(declared.path)) throw new Error(`${profile.app}: ${declared.path} is not a plain path`);
    const host = `${entry.backend.service}.${NAMESPACE}.svc.cluster.local`;
    return {
        entry, host, port: entry.backend.port, path: declared.path,
        // The address always names the port, so the realm's client writes it
        // in the Host header, port 80 included.
        hostHeader: `${host}:${entry.backend.port}`,
        url: `http://${host}:${entry.backend.port}${declared.path}`,
        publicHost: `${entry.subDomain}.${DOMAIN}`,
    };
}

// The app's client at the realm, as the Composition registers it, and the
// scope and mappers of the profile's OIDC pack.
async function registerClient(kc, realm, profile, { secret, signOutUrl }) {
    const oidc = profile.spec.requires.services.identity.oidc;
    await kc.admin('POST', `/realms/${realm}/clients`, {
        clientId: oidc.clientId,
        name: oidc.name || oidc.clientId,
        protocol: 'openid-connect',
        enabled: true,
        publicClient: oidc.accessType !== 'CONFIDENTIAL',
        ...(oidc.accessType === 'CONFIDENTIAL' ? { secret } : {}),
        standardFlowEnabled: true,
        directAccessGrantsEnabled: Boolean(oidc.directAccessGrantsEnabled),
        serviceAccountsEnabled: false,
        redirectUris: oidc.redirectUris || [],
        webOrigins: ['+'],
        attributes: {
            'post.logout.redirect.uris': (oidc.postLogoutRedirectUris || []).join('##'),
            ...(signOutUrl ? { 'backchannel.logout.url': signOutUrl, 'backchannel.logout.session.required': 'true' } : {}),
        },
    });
    const found = JSON.parse((await kc.admin('GET', `/realms/${realm}/clients?clientId=${encodeURIComponent(oidc.clientId)}`)).body);
    const id = found[0].id;

    const pack = profile.catalog && profile.catalog.spec.packs[oidc.oidcPackRef || oidc.clientId];
    if (pack && pack.scopeName) {
        await kc.admin('POST', `/realms/${realm}/client-scopes`, {
            name: pack.scopeName, protocol: 'openid-connect', attributes: { 'include.in.token.scope': 'true' },
            protocolMappers: (pack.mappers || []).map((name) => {
                const template = profile.catalog.spec.mapperTemplates[name];
                return { name, protocol: 'openid-connect', protocolMapper: template.protocolMapper, config: template.config };
            }),
        });
        const scopes = JSON.parse((await kc.admin('GET', `/realms/${realm}/client-scopes`)).body);
        const scope = scopes.find((s) => s.name === pack.scopeName);
        await kc.admin('PUT', `/realms/${realm}/clients/${id}/default-client-scopes/${scope.id}`);
    }
    return id;
}

// The app's Service: the name the realm calls, in front of the app's
// container. It keeps what was posted (see the sidecar's e2e/lib/tap.js).
function startService({ name, address, target }) {
    setup.tryDocker('rm', '-f', name);
    setup.docker('run', '-d', '--name', name, '--network', setup.NETWORK, '--network-alias', address.host,
        '-p', `127.0.0.1::${address.port}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '-e', `TAP_TARGET=${target}`, '-e', `TAP_PORT=${address.port}`,
        '-v', `${path.join(REPO, 'images', 'gentian-sidecar-sso-saml', 'e2e', 'lib', 'tap.js')}:/tap.js:ro`,
        '--entrypoint', 'node', TAP_IMAGE, '/tap.js');
    return { name, upstream: `http://127.0.0.1:${setup.publishedPort(name, address.port)}` };
}

async function posts(service) {
    return JSON.parse((await setup.call('GET', `${service.upstream}/__posts`)).body);
}

// Waits until the realm has told the app of count sign-outs, and answers
// what it posted.
async function waitForPosts(service, count) {
    let got = [];
    await setup.waitFor(`sign-out notice number ${count}`, async () => {
        got = await posts(service);
        return got.length >= count;
    }, 30);
    return got;
}

// The claims of a logout token the realm posted.
function logoutTokenOf(post) {
    const token = new URLSearchParams(post.body).get('logout_token');
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
}

module.exports = {
    setup, Browser, keycloak, YAML, REPO,
    TENANT, NAMESPACE, DOMAIN, KERNEL_DOMAIN, IDP_SERVICE,
    startKeycloak, startPublicIdp, ensureRealm, personId, emailSources, fill, profileOf, signOutAddress, registerClient,
    startService, posts, waitForPosts, logoutTokenOf,
};
