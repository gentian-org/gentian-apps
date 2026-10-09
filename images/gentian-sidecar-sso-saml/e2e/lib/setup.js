'use strict';

// The identity provider and the sidecar for an end-to-end run, set up the
// way the platform sets them up on a cluster.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');

const NETWORK = process.env.E2E_NETWORK || 'sso-e2e';
const KEYCLOAK_IMAGE = process.env.E2E_KEYCLOAK_IMAGE || 'quay.io/keycloak/keycloak:26.8.0';
const SIDECAR_IMAGE = process.env.E2E_SIDECAR_IMAGE || 'sso-sidecar:e2e';
const IDP_HOST = 'id.e2e.test';
const IDP_BASE = `https://${IDP_HOST}/auth`;

function docker(...args) {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryDocker(...args) {
    try {
        return docker(...args);
    } catch {
        return '';
    }
}

function publishedPort(container, port) {
    return docker('port', container, `${port}/tcp`).split('\n')[0].split(':').pop();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function call(method, url, { headers, body } = {}) {
    const target = new URL(url);
    return new Promise((resolve, reject) => {
        const req = http.request({ host: target.hostname, port: target.port, method, path: target.pathname + target.search, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function waitFor(what, probe, seconds = 180) {
    const deadline = Date.now() + seconds * 1000;
    let last;
    while (Date.now() < deadline) {
        try {
            if (await probe()) return;
        } catch (err) {
            last = err;
        }
        await sleep(2000);
    }
    throw new Error(`${what} did not come up in ${seconds}s${last ? ': ' + last.message : ''}`);
}

// Keycloak as the platform runs it: under /auth, told its public address, so
// every address it writes is the public one whoever asks.
async function startKeycloak() {
    tryDocker('network', 'create', NETWORK);
    const name = 'sso-e2e-kc';
    if (!tryDocker('ps', '-q', '-f', `name=^${name}$`)) {
        tryDocker('rm', '-f', name);
        docker('run', '-d', '--name', name, '--network', NETWORK, '-p', '127.0.0.1::8080',
            '-e', 'KC_BOOTSTRAP_ADMIN_USERNAME=admin', '-e', 'KC_BOOTSTRAP_ADMIN_PASSWORD=admin-e2e',
            '-e', 'KC_HTTP_RELATIVE_PATH=/auth', '-e', `KC_HOSTNAME=${IDP_BASE}`,
            '-e', 'KC_HOSTNAME_BACKCHANNEL_DYNAMIC=false', '-e', 'KC_HTTP_ENABLED=true', '-e', 'KC_PROXY_HEADERS=xforwarded',
            KEYCLOAK_IMAGE, 'start-dev');
    }
    const upstream = `http://127.0.0.1:${publishedPort(name, 8080)}`;
    const headers = { host: IDP_HOST, 'x-forwarded-proto': 'https' };
    await waitFor('Keycloak', async () => (await call('GET', `${upstream}/auth/realms/master`, { headers })).status === 200);

    // An administrator's token lasts a minute, and a run changes who is in
    // which group long after it began: a new one is fetched when the last is
    // half a minute old.
    let token = '';
    let tokenAt = 0;
    const admin = async (method, path, json) => {
        if (Date.now() - tokenAt > 30000) {
            const tokenRes = await call('POST', `${upstream}/auth/realms/master/protocol/openid-connect/token`, {
                headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
                body: 'grant_type=password&client_id=admin-cli&username=admin&password=admin-e2e',
            });
            token = JSON.parse(tokenRes.body).access_token;
            tokenAt = Date.now();
        }
        const res = await call(method, `${upstream}/auth/admin${path}`, {
            headers: { ...headers, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: json === undefined ? undefined : JSON.stringify(json),
        });
        if (res.status >= 400 && res.status !== 409) throw new Error(`${method} ${path}: ${res.status} ${res.body}`);
        return res;
    };
    return { name, upstream, admin, internal: `http://${name}:8080/auth` };
}

async function ensureRealm(kc, realm, people) {
    await kc.admin('POST', '/realms', { realm, enabled: true, ssoSessionMaxLifespan: 43200, accessTokenLifespan: 300 });
    for (const person of people) {
        await kc.admin('POST', `/realms/${realm}/users`, {
            username: person.email, email: person.email, emailVerified: true, enabled: true,
            firstName: person.firstName, lastName: person.lastName,
            credentials: [{ type: 'password', value: person.password, temporary: false }],
        });
    }
}

// The SAML client of an app's sign-in sidecar, as the platform composes it
// (gentian-os, crossplane/compositions/app-default.yaml): the sidecar's own
// address as its name, one address the answer may be posted to, the response
// and the assertion both signed, the person named by e-mail address.
function sidecarClient(host) {
    return {
        clientId: `https://${host}/sso`,
        name: `Sign-in sidecar at ${host}`,
        protocol: 'saml',
        enabled: true,
        redirectUris: [`https://${host}/sso/acs`],
        frontchannelLogout: false,
        fullScopeAllowed: false,
        attributes: {
            'saml.server.signature': 'true',
            'saml.assertion.signature': 'true',
            'saml.client.signature': 'false',
            'saml.encrypt': 'false',
            'saml.force.post.binding': 'true',
            'saml_force_name_id_format': 'true',
            'saml_name_id_format': 'email',
            'saml.signature.algorithm': 'RSA_SHA256',
            'saml.authnstatement': 'true',
            'saml_assertion_consumer_url_post': `https://${host}/sso/acs`,
        },
    };
}

// The role the realm lists for a person who administers the app, the
// attribute it is listed under, and the group whose members hold the
// platform's App Admin role in a tenant. The names are the platform's
// (gentian-os: app-default.yaml, internal/keycloak/groups.go) and the
// sidecar's (lib/signin.js).
const APP_ADMIN_ROLE = 'gentian-app-admin';
const ROLE_ATTRIBUTE = 'Role';
function appAdminsGroup(tenant) {
    return `gentian:tenant:${tenant}:app-admins`;
}

async function groupId(kc, realm, name) {
    await kc.admin('POST', `/realms/${realm}/groups`, { name });
    const found = JSON.parse((await kc.admin('GET', `/realms/${realm}/groups?search=${encodeURIComponent(name)}&exact=true`)).body);
    const group = found.find((g) => g.name === name);
    if (!group) throw new Error(`no group ${name} in ${realm}`);
    return group.id;
}

async function userId(kc, realm, email) {
    const found = JSON.parse((await kc.admin('GET', `/realms/${realm}/users?email=${encodeURIComponent(email)}&exact=true`)).body);
    if (found.length !== 1) throw new Error(`no person ${email} in ${realm}`);
    return found[0].id;
}

// What the platform composes for an app's sign-in sidecar: the client above,
// one role at it, that role granted to the tenant's app administrators'
// group, and a mapper that lists a person's roles at this client in the
// assertion. The scope the realm gives every new SAML client ("role_list")
// is left as the realm made it, as it is on a cluster.
async function ensureSidecarClient(kc, realm, host, { tenant = realm } = {}) {
    const clientId = `https://${host}/sso`;
    await kc.admin('POST', `/realms/${realm}/clients`, sidecarClient(host));
    const clients = JSON.parse((await kc.admin('GET', `/realms/${realm}/clients?clientId=${encodeURIComponent(clientId)}`)).body);
    const id = clients[0].id;
    await kc.admin('POST', `/realms/${realm}/clients/${id}/roles`, { name: APP_ADMIN_ROLE });
    const role = JSON.parse((await kc.admin('GET', `/realms/${realm}/clients/${id}/roles/${APP_ADMIN_ROLE}`)).body);
    const group = await groupId(kc, realm, appAdminsGroup(tenant));
    await kc.admin('POST', `/realms/${realm}/groups/${group}/role-mappings/clients/${id}`, [{ id: role.id, name: role.name }]);
    await kc.admin('POST', `/realms/${realm}/clients/${id}/protocol-mappers/models`, {
        name: 'app-admin', protocol: 'saml', protocolMapper: 'saml-role-list-mapper',
        config: { 'attribute.name': ROLE_ATTRIBUTE, 'attribute.nameformat': 'Basic', single: 'true' },
    });
    return id;
}

// setAppAdmin gives a person the platform's App Admin role in a tenant, or
// takes it away: membership of the tenant's app administrators' group, which
// is what a tenant's administrator changes in the admin console.
async function setAppAdmin(kc, realm, email, member, { tenant = realm } = {}) {
    const group = await groupId(kc, realm, appAdminsGroup(tenant));
    const user = await userId(kc, realm, email);
    await kc.admin(member ? 'PUT' : 'DELETE', `/realms/${realm}/users/${user}/groups/${group}`);
}

// The roles the realm listed in an answer it posted, read from the answer
// as a browser carried it.
function rolesIn(samlResponse) {
    const xml = Buffer.from(samlResponse, 'base64').toString('utf8');
    const out = [];
    const attribute = /<(?:\w+:)?Attribute\b[^>]*\bName="([^"]*)"[^>]*>([\s\S]*?)<\/(?:\w+:)?Attribute>/g;
    for (let m = attribute.exec(xml); m; m = attribute.exec(xml)) {
        const value = /<(?:\w+:)?AttributeValue\b[^>]*>([^<]*)</g;
        for (let v = value.exec(m[2]); v; v = value.exec(m[2])) out.push(`${m[1]}=${v[1]}`);
    }
    return out;
}

// The sidecar, with the settings the platform gives it for an app at host.
function startSidecar({ name, host, realm, handlerFile, env = {}, kc, sessionMaxSeconds }) {
    tryDocker('rm', '-f', name);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(handlerFile)).digest('hex');
    const settings = {
        SSO_ENTITY_ID: `https://${host}/sso`,
        SSO_ACS_URL: `https://${host}/sso/acs`,
        SSO_LOGIN_PATH: '/sso/login',
        SSO_IDP_ENTITY_ID: `${IDP_BASE}/realms/${realm}`,
        SSO_IDP_SSO_URL: `${IDP_BASE}/realms/${realm}/protocol/saml`,
        SSO_IDP_DESCRIPTOR_URL: `${kc.internal}/realms/${realm}/protocol/saml/descriptor`,
        SSO_REALM: realm,
        SSO_HANDLER_SHA256: digest,
        ...(sessionMaxSeconds ? { SSO_SESSION_MAX_SECONDS: String(sessionMaxSeconds) } : {}),
        ...env,
    };
    const args = ['run', '-d', '--name', name, '--network', NETWORK, '-p', '127.0.0.1::8081',
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '-v', `${handlerFile}:/usr/src/app/custom/handler.js:ro`];
    for (const [key, value] of Object.entries(settings)) args.push('-e', `${key}=${value}`);
    docker(...args, SIDECAR_IMAGE);
    return { name, upstream: `http://127.0.0.1:${publishedPort(name, 8081)}` };
}

async function sidecarReady(sidecar) {
    await waitFor(`the sidecar ${sidecar.name}`, async () => (await call('GET', `${sidecar.upstream}/readyz`)).status === 200, 60);
}

function logsOf(container) {
    try {
        return execFileSync('docker', ['logs', container], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
        return String(err.stdout || '') + String(err.stderr || '');
    }
}

module.exports = {
    NETWORK, IDP_HOST, IDP_BASE, docker, tryDocker, publishedPort, sleep, call, waitFor,
    startKeycloak, ensureRealm, ensureSidecarClient, sidecarClient, startSidecar, sidecarReady, logsOf,
    setAppAdmin, groupId, userId, rolesIn, appAdminsGroup, APP_ADMIN_ROLE, ROLE_ATTRIBUTE,
};
