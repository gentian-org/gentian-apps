'use strict';

// The identity provider and the sidecar for an end-to-end run, set up the
// way the platform sets them up on a cluster.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

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
//
// backchannelDynamic is the platform's own setting for it
// (--hostname-backchannel-dynamic=true): asked under its name inside the
// network, it names its token and key addresses there, which is how an app
// that signs people in itself reaches them. aliases are further names it
// answers to inside the network.
async function startKeycloak({ name = `${NETWORK}-kc`, backchannelDynamic = false, aliases = [] } = {}) {
    tryDocker('network', 'create', NETWORK);
    if (!tryDocker('ps', '-q', '-f', `name=^${name}$`)) {
        tryDocker('rm', '-f', name);
        docker('run', '-d', '--name', name, '--network', NETWORK, ...aliases.flatMap((alias) => ['--network-alias', alias]),
            '-p', '127.0.0.1::8080',
            '-e', 'KC_BOOTSTRAP_ADMIN_USERNAME=admin', '-e', 'KC_BOOTSTRAP_ADMIN_PASSWORD=admin-e2e',
            '-e', 'KC_HTTP_RELATIVE_PATH=/auth', '-e', `KC_HOSTNAME=${IDP_BASE}`,
            '-e', `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=${backchannelDynamic}`, '-e', 'KC_HTTP_ENABLED=true', '-e', 'KC_PROXY_HEADERS=xforwarded',
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
//
// logoutUrl is where the realm tells the sidecar of a sign-out: the sidecar's
// own name inside the cluster. The client asks for no browser redirect at
// sign-out (frontchannelLogout false), so the realm posts there itself.
function sidecarClient(host, { logoutUrl } = {}) {
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
            ...(logoutUrl ? { 'saml_single_logout_service_url_post': logoutUrl } : {}),
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
async function ensureSidecarClient(kc, realm, host, { tenant = realm, logoutUrl } = {}) {
    const clientId = `https://${host}/sso`;
    const created = await kc.admin('POST', `/realms/${realm}/clients`, sidecarClient(host, { logoutUrl }));
    const clients = JSON.parse((await kc.admin('GET', `/realms/${realm}/clients?clientId=${encodeURIComponent(clientId)}`)).body);
    const id = clients[0].id;
    // A client an earlier run left at this address is made this run's: two
    // runs share one Keycloak, and the sign-out address is the one thing
    // about the client that differs between them.
    if (created.status === 409) {
        await kc.admin('PUT', `/realms/${realm}/clients/${id}`, {
            ...clients[0],
            attributes: { ...clients[0].attributes, 'saml_single_logout_service_url_post': logoutUrl || '' },
        });
    }
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

// Where the realm tells a sidecar of a sign-out: the sidecar's name inside the
// run's network, as a sidecar's Service is its name inside a cluster. What
// answers to that name here is a relay in front of the sidecar (e2e/lib/tap.js)
// that keeps what the realm posted.
function logoutUrlOf(name) {
    return `http://${name}-svc:8081/sso/logout`;
}

// A person signs out at the realm, as the front door's sign-out sends them:
// the realm's end-session address. The front door passes the session's ID
// token, so the realm asks nothing; without one it asks once, and the
// question is answered here.
async function signOutAtRealm(browser, realm) {
    let res = await browser.request('GET', `${IDP_BASE}/realms/${realm}/protocol/openid-connect/logout`);
    const form = /<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/.exec(res.body);
    if (!form) throw new Error(`the realm showed no sign-out question: ${res.status}`);
    const fields = {};
    for (const m of form[2].matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) fields[m[1]] = m[2];
    res = await browser.request('POST', new URL(form[1].replace(/&amp;/g, '&'), IDP_BASE).toString(), { form: fields, fromHost: IDP_HOST });
    if (res.status !== 200 && res.status !== 302) throw new Error(`the realm did not sign out: ${res.status}`);
    return res;
}

// The sidecar, with the settings the platform gives it for an app at host.
// It is told its sign-out address unless logout is false, which is a sidecar
// as the platform ran it before there was one.
function startSidecar({ name, host, realm, handlerFile, env = {}, kc, sessionMaxSeconds, logout = true }) {
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
        ...(logout ? { SSO_LOGOUT_URL: logoutUrlOf(name) } : {}),
        ...(sessionMaxSeconds ? { SSO_SESSION_MAX_SECONDS: String(sessionMaxSeconds) } : {}),
        ...env,
    };
    const args = ['run', '-d', '--name', name, '--network', NETWORK, '-p', '127.0.0.1::8081',
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '-v', `${handlerFile}:/usr/src/app/custom/handler.js:ro`];
    for (const [key, value] of Object.entries(settings)) args.push('-e', `${key}=${value}`);
    docker(...args, SIDECAR_IMAGE);
    const sidecar = { name, upstream: `http://127.0.0.1:${publishedPort(name, 8081)}` };
    if (logout) {
        const tap = `${name}-svc`;
        tryDocker('rm', '-f', tap);
        docker('run', '-d', '--name', tap, '--network', NETWORK, '-p', '127.0.0.1::8081',
            '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '-e', `TAP_TARGET=http://${name}:8081`, '-v', `${path.join(__dirname, 'tap.js')}:/tap.js:ro`,
            '--entrypoint', 'node', SIDECAR_IMAGE, '/tap.js');
        sidecar.logoutUrl = logoutUrlOf(name);
        sidecar.service = { name: tap, host: `${tap}:8081`, upstream: `http://127.0.0.1:${publishedPort(tap, 8081)}` };
    }
    return sidecar;
}

// removeSidecar removes a sidecar's containers.
function removeSidecar(name) {
    tryDocker('rm', '-f', name, `${name}-svc`);
}

// What the realm has posted to a sidecar's sign-out address so far.
async function signOutPosts(sidecar) {
    return JSON.parse((await call('GET', `${sidecar.service.upstream}/__posts`)).body);
}

// Posts a sign-out request to a sidecar the way the realm does: to its name
// inside the network, as a form.
function postSignOut(sidecar, samlRequest, { body } = {}) {
    return call('POST', `${sidecar.service.upstream}/sso/logout`, {
        headers: { host: sidecar.service.host, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: body || `SAMLRequest=${encodeURIComponent(samlRequest)}&BACK_CHANNEL_LOGOUT=BACK_CHANNEL_LOGOUT`,
    });
}

// waitForSignOut waits until the realm has posted count sign-outs to a
// sidecar and each was answered. The realm posts while it answers the
// browser, so this is short.
async function waitForSignOut(sidecar, count) {
    let posts = [];
    await waitFor(`sign-out number ${count} at ${sidecar.name}`, async () => {
        posts = await signOutPosts(sidecar);
        return posts.length >= count;
    }, 30);
    return posts;
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
    logoutUrlOf, signOutAtRealm, removeSidecar, signOutPosts, postSignOut, waitForSignOut, setAppAdmin, groupId, userId, rolesIn, appAdminsGroup, APP_ADMIN_ROLE, ROLE_ATTRIBUTE,
};
