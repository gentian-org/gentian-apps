'use strict';

// Activepieces, the real container at the version the catalogue's chart pins,
// started the way that chart starts it, signed in to through the sidecar with
// the profile's own handler.
//
//   docker build -t sso-sidecar:e2e ..   &&   node --test e2e/activepieces.e2e.js
//
// E2E_ACTIVEPIECES_IMAGE names another image of the same build, for a docker
// that cannot unpack the published one (a rootless daemon refuses a file in
// it owned by an id outside its range).

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { Browser, frontDoor, keycloak } = require('./lib/browser');
const setup = require('./lib/setup');
const { signInOf, REPO } = require('./lib/profile');

const IMAGE = process.env.E2E_ACTIVEPIECES_IMAGE || 'docker.io/activepieces/activepieces:0.28.0';
const HOST = 'auto.acme.e2e.test';
const REALM = 'acme';
// The profile's own handler and lists: what is sent to the sign-in, what is
// refused at the front door.
const PROFILE = signInOf('profiles/activepieces/activepieces-me');
const HANDLER = PROFILE.handler;
const ENTRY_PATHS = PROFILE.entryPaths;
const DENY_PATHS = PROFILE.denyPaths;
const JWT_SECRET = 'e2e-only-jwt-secret-0123456789abcdef';

const ANNA = { email: 'anna@acme.e2e.test', firstName: 'Anna', lastName: "O'Example", password: 'pw-anna-e2e', subject: 'sub-anna', name: "Anna O'Example" };
const BEN = { email: 'ben@acme.e2e.test', firstName: 'Ben', lastName: 'Example', password: 'pw-ben-e2e', subject: 'sub-ben', name: 'Ben Example' };
const OWNER_EMAIL = 'config-account@activepieces.internal';
// A person at the platform who holds the address of the account the
// installation is created with.
const IMPOSTOR = { email: OWNER_EMAIL, firstName: 'Dora', lastName: 'Example', password: 'pw-dora-e2e', subject: 'sub-dora', name: 'Dora Example' };

let kc;
let sidecar;
let appUpstream;
let runtime;
const names = { pg: 'sso-e2e-ap-pg', redis: 'sso-e2e-ap-redis', app: 'sso-e2e-ap', sidecar: 'sso-e2e-ap-sidecar' };

function psql(sql) {
    return setup.docker('exec', names.pg, 'psql', '-U', 'activepieces', '-d', 'activepieces', '-At', '-c', sql);
}

// The files the chart mounts into the container: its nginx configuration, its
// entrypoint and the sign-in shim, taken from the chart as it is built.
function chartRuntime() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sso-e2e-ap-chart-'));
    // From the repository's root: the script applies its patches relative to it.
    execFileSync('bash', [path.join('scripts', 'build-activepieces-chart.sh'), '--out', out], { cwd: REPO, stdio: 'ignore' });
    const pkg = fs.readdirSync(out).find((f) => f.endsWith('.tgz'));
    execFileSync('tar', ['xzf', path.join(out, pkg), '-C', out, 'activepieces/files']);
    const files = path.join(out, 'activepieces', 'files');
    for (const f of fs.readdirSync(files)) fs.chmodSync(path.join(files, f), 0o555);
    return files;
}

function claims(token) {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
}

before(async () => {
    runtime = chartRuntime();
    kc = await setup.startKeycloak();
    await setup.ensureRealm(kc, REALM, [ANNA, BEN, IMPOSTOR]);
    await setup.ensureSidecarClient(kc, REALM, HOST, { logoutUrl: setup.logoutUrlOf(names.sidecar) });
    for (const person of [ANNA, BEN]) await setup.setAppAdmin(kc, REALM, person.email, false);
    for (const name of Object.values(names)) setup.removeSidecar(name);
    setup.docker('run', '-d', '--name', names.pg, '--network', setup.NETWORK,
        '-e', 'POSTGRES_USER=activepieces', '-e', 'POSTGRES_PASSWORD=ap-e2e', '-e', 'POSTGRES_DB=activepieces', 'postgres:16-alpine');
    setup.docker('run', '-d', '--name', names.redis, '--network', setup.NETWORK, 'redis:7-alpine');
    await setup.waitFor('PostgreSQL', async () => setup.tryDocker('exec', names.pg, 'pg_isready', '-U', 'activepieces') !== '', 60);
    setup.docker('run', '-d', '--name', names.app, '--network', setup.NETWORK, '-p', '127.0.0.1::80',
        '-v', `${runtime}:/etc/activepieces:ro`, '--entrypoint', '/bin/sh',
        '-e', `AP_FRONTEND_URL=https://${HOST}`, '-e', 'AP_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef',
        '-e', `AP_JWT_SECRET=${JWT_SECRET}`, '-e', 'AP_DB_TYPE=POSTGRES', '-e', `AP_POSTGRES_HOST=${names.pg}`,
        '-e', 'AP_POSTGRES_PORT=5432', '-e', 'AP_POSTGRES_DATABASE=activepieces', '-e', 'AP_POSTGRES_USERNAME=activepieces',
        '-e', 'AP_POSTGRES_PASSWORD=ap-e2e', '-e', 'AP_QUEUE_MODE=REDIS', '-e', `AP_REDIS_HOST=${names.redis}`,
        '-e', 'AP_REDIS_PORT=6379', '-e', 'AP_EXECUTION_MODE=UNSANDBOXED', '-e', 'AP_ENVIRONMENT=prod',
        '-e', 'AP_TELEMETRY_ENABLED=false', '-e', 'AP_PIECES_SOURCE=FILE', '-e', 'AP_PIECES_SYNC_MODE=NONE',
        IMAGE, '/etc/activepieces/entrypoint.sh');
    appUpstream = `http://127.0.0.1:${setup.publishedPort(names.app, 80)}`;
    await setup.waitFor('Activepieces', async () => (await setup.call('GET', `${appUpstream}/api/v1/flags`)).status === 200, 300);
    sidecar = setup.startSidecar({
        name: names.sidecar, host: HOST, realm: REALM, kc, handlerFile: HANDLER,
        env: {
            DB_HOST: names.pg, DB_PORT: '5432', DB_NAME: 'activepieces', DB_USER: 'activepieces', DB_PASSWORD: 'ap-e2e',
            SECRET_JWT_SECRET: JWT_SECRET, APP_URL: `http://${names.app}:80`,
        },
    });
    await setup.sidecarReady(sidecar);
});

after(() => {
    if (process.env.E2E_KEEP) return;
    for (const name of Object.values(names)) setup.removeSidecar(name);
    if (runtime) fs.rmSync(path.dirname(path.dirname(runtime)), { recursive: true, force: true });
});

function browserAs(door) {
    return new Browser({
        [setup.IDP_HOST]: keycloak(kc.upstream),
        [HOST]: frontDoor({ door, sidecar: sidecar.upstream, app: appUpstream, realm: REALM, entryPaths: ENTRY_PATHS, denyPaths: DENY_PATHS }),
    });
}

function api(browser, method, pathAndQuery, json) {
    const token = browser.storage[`https://${HOST}`].token;
    return browser.request(method, `https://${HOST}${pathAndQuery}`, { json, headers: { authorization: `Bearer ${token}` } });
}

let annaProject;

test('the first person to open Activepieces is in, as an ordinary member', async () => {
    const browser = browserAs({ person: ANNA });
    const res = await browser.navigate(`https://${HOST}/`, { credentials: { username: ANNA.email, password: ANNA.password } });
    assert.equal(res.status, 200, browser.log.join(' -> '));
    assert.equal(new URL(res.url).pathname, '/flows');

    const stored = browser.storage[`https://${HOST}`];
    assert.ok(stored && stored.token, 'the session is where Activepieces keeps it');
    const token = claims(stored.token);
    assert.equal(token.type, 'USER');
    assert.equal(token.iss, 'activepieces');
    assert.ok(token.exp - token.iat > 0 && token.exp - token.iat <= 3600, `the token lasts ${token.exp - token.iat}s`);
    const user = JSON.parse(stored.currentUser);
    assert.equal(user.email, ANNA.email);
    assert.equal(user.firstName, 'Anna');
    assert.equal(user.lastName, "O'Example");
    assert.equal(user.platformRole, 'MEMBER');
    assert.equal(user.token, undefined);
    annaProject = token.projectId;

    // No cookie carries the session, readable by script or otherwise.
    assert.deepEqual(browser.jar.filter((c) => c.host === HOST).map((c) => c.name), []);

    // Activepieces itself accepts the token.
    const flows = await api(browser, 'GET', `/api/v1/flows?projectId=${annaProject}&limit=10`);
    assert.equal(flows.status, 200, flows.body);
    const created = await api(browser, 'POST', '/api/v1/flows', { displayName: 'made in the test', projectId: annaProject });
    assert.ok([200, 201].includes(created.status), created.body);
});

test('the platform is the one Activepieces made itself, with none of its switches touched', () => {
    assert.equal(psql('select count(*) from platform'), '1');
    assert.equal(psql('select u.email from platform p join "user" u on u.id = p."ownerId"'), 'config-account@activepieces.internal');
    const switches = psql('select "ssoEnabled", "embeddingEnabled", "manageProjectsEnabled", "projectRolesEnabled", "customAppearanceEnabled", "gitSyncEnabled", "auditLogEnabled", "apiKeysEnabled", "customDomainsEnabled" from platform');
    assert.equal(switches, 'f|f|f|f|f|f|f|f|f');
});

test('nobody has a password and nobody but the platform\'s own account administers it', () => {
    assert.equal(psql("select count(*) from \"user\" where password <> ''"), '0');
    assert.equal(psql(`select "platformRole" from "user" where email = '${ANNA.email}'`), 'MEMBER');
    assert.equal(psql("select string_agg(email, ',') from \"user\" where \"platformRole\" = 'ADMIN'"), 'config-account@activepieces.internal');
});

test('a second person gets an account and a project of their own, and not the first person\'s', async () => {
    const browser = browserAs({ person: BEN });
    const res = await browser.navigate(`https://${HOST}/`, { credentials: { username: BEN.email, password: BEN.password } });
    assert.equal(new URL(res.url).pathname, '/flows', browser.log.join(' -> '));
    const token = claims(browser.storage[`https://${HOST}`].token);
    assert.notEqual(token.projectId, annaProject);
    assert.equal(psql(`select count(*) from project p join "user" u on u.id = p."ownerId" where u.email = '${BEN.email}'`), '1');
    const own = await api(browser, 'GET', `/api/v1/flows?projectId=${token.projectId}&limit=10`);
    assert.equal(own.status, 200);
    assert.equal(JSON.parse(own.body).data.length, 0);
    const others = await api(browser, 'GET', `/api/v1/flows?projectId=${annaProject}&limit=10`);
    const seen = others.status === 200 ? JSON.parse(others.body).data.length : 0;
    assert.equal(seen, 0, 'the second person sees none of the first person\'s flows');
});

test('opening the app again makes no second account and asks for nothing', async () => {
    const browser = browserAs({ person: ANNA });
    await browser.navigate(`https://${HOST}/`, { credentials: { username: ANNA.email, password: ANNA.password } });
    browser.log.length = 0;
    const res = await browser.navigate(`https://${HOST}/`);
    assert.equal(new URL(res.url).pathname, '/flows');
    assert.ok(!browser.log.some((line) => line.includes('login-actions')), browser.log.join(' -> '));
    assert.equal(psql(`select count(*) from "user" where email = '${ANNA.email}'`), '1');
    assert.equal(psql(`select count(*) from project p join "user" u on u.id = p."ownerId" where u.email = '${ANNA.email}'`), '1');
    assert.equal(claims(browser.storage[`https://${HOST}`].token).projectId, annaProject);
});

test('every page is served with the shim that leads a browser without a session to the sign-in', async () => {
    const browser = browserAs({ person: ANNA });
    const page = await browser.request('GET', `https://${HOST}/flows`);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('<head><script src="/gentian/sign-in.js"></script>'), page.body.slice(0, 300));
    const shim = await browser.request('GET', `https://${HOST}/gentian/sign-in.js`);
    assert.equal(shim.status, 200);
    assert.match(shim.headers['content-type'], /javascript/);
    assert.ok(shim.body.includes("var login = '/sso/login'"));
    const json = await browser.request('GET', `https://${HOST}/api/v1/flags`);
    assert.ok(!json.body.includes('sign-in.js'), 'only pages are touched');
});

test('Activepieces\' own sign-in pages and calls lead to the platform\'s sign-in or nowhere', async () => {
    const browser = browserAs({ person: ANNA });
    for (const p of ['/sign-in', '/sign-up']) {
        const res = await browser.request('GET', `https://${HOST}${p}`);
        assert.equal(res.status, 302, p);
        assert.equal(res.headers.location, '/sso/login');
    }
    for (const p of ['/api/v1/authentication/sign-in', '/api/v1/authentication/sign-up', '/api/v1/authn/saml/acs', '/api/v1/otp']) {
        const res = await browser.request('POST', `https://${HOST}${p}`, { json: { email: ANNA.email, password: 'whatever-it-is' } });
        assert.equal(res.status, 403, p);
    }
});

test('an account switched off in Activepieces is not signed in', async () => {
    psql(`update "user" set status = 'INACTIVE' where email = '${BEN.email}'`);
    const browser = browserAs({ person: BEN });
    const res = await browser.navigate(`https://${HOST}/`, { credentials: { username: BEN.email, password: BEN.password } });
    assert.equal(res.status, 403);
    assert.equal(browser.storage[`https://${HOST}`], undefined);
    psql(`update "user" set status = 'ACTIVE' where email = '${BEN.email}'`);
});

// Who administers Activepieces: who holds the platform's App Admin role, and
// nobody else.

async function signIn(person, extraHeaders) {
    const browser = browserAs({ person });
    if (extraHeaders) {
        const request = browser.request.bind(browser);
        browser.request = (method, url, options = {}) => request(method, url, { ...options, headers: { ...(options.headers || {}), ...extraHeaders } });
    }
    const res = await browser.navigate(`https://${HOST}/${extraHeaders ? '?appAdmin=true' : ''}`, { credentials: { username: person.email, password: person.password } });
    assert.equal(new URL(res.url).pathname, '/flows', browser.log.join(' -> '));
    return { browser, user: JSON.parse(browser.storage[`https://${HOST}`].currentUser) };
}

function roleOf(person) {
    return psql(`select "platformRole" from "user" where email = '${person.email}'`);
}

// The installation's list of all accounts, which Activepieces gives only to
// an administrator of the installation.
async function mayAdminister(browser) {
    const res = await api(browser, 'GET', '/api/v1/users');
    assert.ok([200, 403].includes(res.status), `the list of accounts answered ${res.status}: ${res.body}`);
    return res.status === 200;
}

test('a person who holds the App Admin role administers Activepieces, and nobody else does', async () => {
    await setup.setAppAdmin(kc, REALM, ANNA.email, true);
    const anna = await signIn(ANNA);
    assert.equal(anna.user.platformRole, 'ADMIN');
    assert.equal(roleOf(ANNA), 'ADMIN');
    assert.equal(await mayAdminister(anna.browser), true);
    // She works in the project she had.
    assert.equal(claims(anna.browser.storage[`https://${HOST}`].token).projectId, annaProject);

    const ben = await signIn(BEN);
    assert.equal(ben.user.platformRole, 'MEMBER');
    assert.equal(await mayAdminister(ben.browser), false);
    assert.equal(psql("select string_agg(email, ',' order by email) from \"user\" where \"platformRole\" = 'ADMIN'"), [ANNA.email, OWNER_EMAIL].sort().join(','));
    // The installation is still its own account's, and nobody has a password.
    assert.equal(psql('select u.email from platform p join "user" u on u.id = p."ownerId"'), OWNER_EMAIL);
    assert.equal(psql("select count(*) from \"user\" where password <> ''"), '0');
});

test('withdrawing the role takes it away in Activepieces at the next sign-in', async () => {
    const before = await signIn(ANNA);
    assert.equal(await mayAdminister(before.browser), true);
    await setup.setAppAdmin(kc, REALM, ANNA.email, false);
    const after = await signIn(ANNA);
    assert.equal(after.user.platformRole, 'MEMBER');
    assert.equal(roleOf(ANNA), 'MEMBER');
    assert.equal(await mayAdminister(after.browser), false);
    // The token she still had from before is no administrator's either:
    // Activepieces reads the role when it is asked.
    assert.equal(await mayAdminister(before.browser), false);
    assert.equal(psql("select string_agg(email, ',') from \"user\" where \"platformRole\" = 'ADMIN'"), OWNER_EMAIL);
});

test('an administrator made inside Activepieces who does not hold the role is one until the next sign-in', async () => {
    psql(`update "user" set "platformRole" = 'ADMIN' where email = '${BEN.email}'`);
    const ben = await signIn(BEN);
    assert.equal(ben.user.platformRole, 'MEMBER');
    assert.equal(roleOf(BEN), 'MEMBER');
});

test('nothing a browser sends makes an administrator of Activepieces', async () => {
    const ben = await signIn(BEN, { 'x-gentian-app-admin': 'true', 'x-gentian-roles': setup.APP_ADMIN_ROLE, role: 'ADMIN' });
    assert.equal(ben.user.platformRole, 'MEMBER');
    assert.equal(roleOf(BEN), 'MEMBER');
    // Activepieces' own call for it is not a member's to make.
    const id = psql(`select id from "user" where email = '${BEN.email}'`);
    const self = await api(ben.browser, 'POST', `/api/v1/users/${id}`, { platformRole: 'ADMIN' });
    assert.equal(self.status, 403, self.body);
    assert.equal(roleOf(BEN), 'MEMBER');
});

// Signing out at the platform. Activepieces 0.28.0 has nothing a handler
// could end a session with: its token is checked by its signature and its
// end alone (authentication/lib/access-token-manager.ts), against nothing in
// its database. So the handler has no onLogout, and what this shows is what
// is true: the realm tells the sidecar, the sidecar answers it, and the
// token goes on until the end the sidecar gave it, which is at most an hour.
test('signing out at the platform does not end Activepieces\' token, which lasts its hour at most', async () => {
    const browser = browserAs({ person: ANNA });
    await browser.navigate(`https://${HOST}/`, { credentials: { username: ANNA.email, password: ANNA.password } });
    const token = browser.storage[`https://${HOST}`].token;
    const left = claims(token).exp - Math.floor(Date.now() / 1000);
    assert.ok(left > 0 && left <= 3600, String(left));

    const posted = (await setup.signOutPosts(sidecar)).length;
    await setup.signOutAtRealm(browser, REALM);
    const posts = await setup.waitForSignOut(sidecar, posted + 1);
    assert.equal(posts[posts.length - 1].status, 200);
    assert.match(setup.logsOf(names.sidecar), /"event":"no-sign-out-handling"/);

    // The token itself still opens Activepieces...
    const still = await setup.call('GET', `${appUpstream}/api/v1/flows?projectId=${claims(token).projectId}&limit=10`,
        { headers: { host: HOST, authorization: `Bearer ${token}` } });
    assert.equal(still.status, 200);
    // ...and a page load leads to the realm, which asks who the person is.
    const again = await browser.navigate(`https://${HOST}/`);
    assert.match(again.body, /kc-form-login/);
});

test('a person at the platform who holds the installation account\'s address is not signed in as it', async () => {
    const browser = browserAs({ person: IMPOSTOR });
    const res = await browser.navigate(`https://${HOST}/`, { credentials: { username: IMPOSTOR.email, password: IMPOSTOR.password } });
    assert.equal(res.status, 403, browser.log.join(' -> '));
    assert.equal(browser.storage[`https://${HOST}`], undefined);
});

test('the sidecar\'s log names nobody', () => {
    const logs = setup.logsOf(names.sidecar);
    assert.match(logs, /"event":"signed-in"/);
    assert.doesNotMatch(logs, /anna|ben@|dora|Example/i);
});
