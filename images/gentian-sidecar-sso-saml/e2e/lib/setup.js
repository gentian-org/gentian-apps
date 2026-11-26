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
// The platform's Keycloak extension, which carries the mapper that asks the
// rights store for a person's roles on an app (gentian-os,
// kernel/extensions/keycloak-event-listener).
const LISTENER_IMAGE = process.env.E2E_LISTENER_IMAGE || 'ghcr.io/gentian-org/keycloak-event-listener:develop';
const KEY_ID = 'e2e';
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

// One request on a connection of its own (agent: false). A run starts
// containers and runs commands in them with calls that hold this process
// still, sometimes for longer than a server keeps an idle connection open;
// a connection kept for the next request would then be one the server has
// closed, and the request on it fails with "socket hang up".
function call(method, url, { headers, body } = {}) {
    const target = new URL(url);
    return new Promise((resolve, reject) => {
        const req = http.request({ agent: false, host: target.hostname, port: target.port, method, path: target.pathname + target.search, headers }, (res) => {
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

// The extension's jar and the key Keycloak signs its questions with, in a
// directory of their own, readable by Keycloak's user in the container.
function listenerFiles() {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sso-e2e-kc-'));
    fs.chmodSync(dir, 0o755);
    fs.mkdirSync(path.join(dir, 'providers'), { mode: 0o755 });
    const holder = `${NETWORK}-listener-${process.pid}`;
    tryDocker('rm', '-f', holder);
    docker('create', '--name', holder, LISTENER_IMAGE);
    try {
        docker('cp', `${holder}:/providers/gentian-keycloak-event-listener.jar`, path.join(dir, 'providers'));
    } finally {
        tryDocker('rm', '-f', holder);
    }
    fs.chmodSync(path.join(dir, 'providers', 'gentian-keycloak-event-listener.jar'), 0o644);
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(path.join(dir, 'listener.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o644 });
    fs.writeFileSync(path.join(dir, 'listener.pub'), publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
    return dir;
}

// The stand-in for the rights store (rights.js), in a container on the
// network, where Keycloak asks it; the run sets who holds what through its
// port on this host.
let rightsUpstream;

function holderKey(tenant, app, person) {
    return `${tenant}/${app}/${person}`;
}

async function startRights(name, files) {
    if (!tryDocker('ps', '-q', '-f', `name=^${name}$`)) {
        tryDocker('rm', '-f', name);
        docker('run', '-d', '--name', name, '--network', NETWORK, '-p', '127.0.0.1::8080',
            '-e', `KEY_ID=${KEY_ID}`,
            '-v', `${path.join(__dirname, 'rights.js')}:/stand-in/rights.js:ro`,
            '-v', `${path.join(files, 'listener.pub')}:/stand-in/listener.pub:ro`,
            '--entrypoint', 'node', SIDECAR_IMAGE, '/stand-in/rights.js');
    }
    rightsUpstream = `http://127.0.0.1:${publishedPort(name, 8080)}`;
    await waitFor('the rights stand-in', async () => (await call('DELETE', `${rightsUpstream}/holders/probe`)).status === 204, 30);
}

async function setHolder(key, member) {
    const res = await call(member ? 'PUT' : 'DELETE', `${rightsUpstream}/holders/${encodeURIComponent(key)}`);
    if (res.status !== 204) throw new Error(`the rights stand-in answered ${res.status}`);
}

// Keycloak as the platform runs it: under /auth, told its public address, so
// every address it writes is the public one whoever asks, and with the
// platform's extension, which asks the stand-in above for a person's roles.
//
// backchannelDynamic is the platform's own setting for it
// (--hostname-backchannel-dynamic=true): asked under its name inside the
// network, it names its token and key addresses there, which is how an app
// that signs people in itself reaches them. aliases are further names it
// answers to inside the network.
async function startKeycloak({ name = `${NETWORK}-kc`, backchannelDynamic = false, aliases = [] } = {}) {
    tryDocker('network', 'create', NETWORK);
    const rightsName = `${name}-rights`;
    let files = tryDocker('inspect', name, '-f', '{{index .Config.Labels "e2e.listener-files"}}');
    if (!tryDocker('ps', '-q', '-f', `name=^${name}$`) || !files || !fs.existsSync(files)) {
        tryDocker('rm', '-f', name);
        files = listenerFiles();
        tryDocker('rm', '-f', rightsName);
        const rightsURL = `http://${rightsName}:8080/`;
        docker('run', '-d', '--name', name, '--network', NETWORK, ...aliases.flatMap((alias) => ['--network-alias', alias]),
            '--label', `e2e.listener-files=${files}`,
            '-v', `${path.join(files, 'providers')}:/opt/keycloak/providers:ro`,
            '-v', `${path.join(files, 'listener.pem')}:/etc/gentian/listener/listener.pem:ro`,
            '-e', `KC_SPI_EVENTS_LISTENER_GENTIAN_DIRECTOR_DIRECTOR_URL=${rightsURL}`,
            '-e', `KC_SPI_EVENTS_LISTENER_GENTIAN_DIRECTOR_KEY_ID=${KEY_ID}`,
            '-e', 'KC_SPI_EVENTS_LISTENER_GENTIAN_DIRECTOR_PRIVATE_KEY_FILE=/etc/gentian/listener/listener.pem',
            '-e', `KC_SPI_PROTOCOL_MAPPER_GENTIAN_APP_ROLES_URL=${rightsURL}`,
            '-e', `KC_SPI_PROTOCOL_MAPPER_GENTIAN_APP_ROLES_KEY_ID=${KEY_ID}`,
            '-e', 'KC_SPI_PROTOCOL_MAPPER_GENTIAN_APP_ROLES_PRIVATE_KEY_FILE=/etc/gentian/listener/listener.pem',
            '-p', '127.0.0.1::8080',
            '-e', 'KC_BOOTSTRAP_ADMIN_USERNAME=admin', '-e', 'KC_BOOTSTRAP_ADMIN_PASSWORD=admin-e2e',
            '-e', 'KC_HTTP_RELATIVE_PATH=/auth', '-e', `KC_HOSTNAME=${IDP_BASE}`,
            '-e', `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=${backchannelDynamic}`, '-e', 'KC_HTTP_ENABLED=true', '-e', 'KC_PROXY_HEADERS=xforwarded',
            KEYCLOAK_IMAGE, 'start-dev');
    }
    await startRights(rightsName, files);
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

// The name the sidecar knows the app's administrator by, and the attribute
// the realm lists it under (gentian-os: internal/apprender/identity_signin.go;
// the sidecar's lib/signin.js).
const APP_ADMIN_ROLE = 'gentian-app-admin';
const ROLE_ATTRIBUTE = 'GentianAppRole';

async function userId(kc, realm, email) {
    const found = JSON.parse((await kc.admin('GET', `/realms/${realm}/users?email=${encodeURIComponent(email)}&exact=true`)).body);
    if (found.length !== 1) throw new Error(`no person ${email} in ${realm}`);
    return found[0].id;
}

// What the platform composes for an app's sign-in sidecar: the client above,
// the mapper that asks the rights store for the roles the person holds on
// the app and lists them as GentianAppRole in the app's names (gentian-saml-app-roles),
// and the mapper that names the person by username. The scope the realm
// gives every new SAML client ("role_list") is left as the realm made it, as
// it is on a cluster. app is the app's profile name, as the mapper asks it.
async function ensureSidecarClient(kc, realm, host, { tenant = realm, app = appOf(host), logoutUrl } = {}) {
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
    await kc.admin('POST', `/realms/${realm}/clients/${id}/protocol-mappers/models`, {
        name: 'app-roles', protocol: 'saml', protocolMapper: 'gentian-saml-app-roles',
        config: {
            'attribute.name': ROLE_ATTRIBUTE, 'gentian.tenant': tenant, 'gentian.app': app,
            'gentian.roles': JSON.stringify({ [app]: { admin: [APP_ADMIN_ROLE] } }),
        },
    });
    await kc.admin('POST', `/realms/${realm}/clients/${id}/protocol-mappers/models`, {
        name: 'name-id', protocol: 'saml', protocolMapper: 'saml-user-attribute-nameid-mapper',
        config: { 'user.attribute': 'username', 'mapper.nameid.format': 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' },
    });
    return id;
}

// The app's profile name a sidecar at host stands for, unless a run names one.
function appOf(host) {
    return host.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

// setAppAdmin gives a person the app's admin role in a tenant, or takes it
// away, in the rights store: what a position such as app-administrator,
// given in the admin console, comes to. app '*' is every app of the tenant.
// The realm learns it at the person's next sign-in, when the mapper asks.
async function setAppAdmin(kc, realm, email, member, { tenant = realm, app = '*' } = {}) {
    await setHolder(holderKey(tenant, app, await userId(kc, realm, email)), member);
}

// setTenantAdmin gives a person the tenant's own admin role, or takes it:
// administering the tenant, which is not administering its apps.
async function setTenantAdmin(kc, realm, email, member, { tenant = realm } = {}) {
    await setHolder(holderKey(tenant, '', await userId(kc, realm, email)), member);
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
    logoutUrlOf, signOutAtRealm, removeSidecar, signOutPosts, postSignOut, waitForSignOut, setAppAdmin, setTenantAdmin, appOf, userId, rolesIn, APP_ADMIN_ROLE, ROLE_ATTRIBUTE,
};
