'use strict';

// Docmost, the real container at the version the catalogue pins, signed in to
// through the sidecar with the profile's own handler.
//
//   docker build -t sso-sidecar:e2e ..   &&   node --test e2e/docmost.e2e.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { Browser, frontDoor, keycloak } = require('./lib/browser');
const setup = require('./lib/setup');
const { signInOf, postInstallOf } = require('./lib/profile');
const { refusedSignOuts } = require('./lib/signout');

const IMAGE = 'docker.io/docmost/docmost:0.95.0';
const HOST = 'docs.acme.e2e.test';
const REALM = 'acme';
// The profile's own handler and lists: what is sent to the sign-in, what is
// refused at the front door.
const PROFILE = signInOf('profiles/docmost/docmost-ce');
const HANDLER = PROFILE.handler;
const ENTRY_PATHS = PROFILE.entryPaths;
const DENY_PATHS = PROFILE.denyPaths;
const APP_SECRET = 'e2e-only-0123456789abcdef0123456789abcdef';
// The tenant, which here has the realm's name, and the profile's
// post-install job as the platform would run it for that tenant.
const TENANT = REALM;
const INSTALL = postInstallOf('profiles/docmost/docmost-ce', { tenant: TENANT, domain: 'acme.e2e.test', namespace: 'tenant-acme', app: 'docmost-ce' });
const OWNER_EMAIL = 'config-account@docmost.internal';

const ANNA = { email: 'anna@acme.e2e.test', firstName: 'Anna', lastName: "O'Example", password: 'pw-anna-e2e', subject: 'sub-anna', name: "Anna O'Example" };
const BEN = { email: 'ben@acme.e2e.test', firstName: 'Ben', lastName: 'Example', password: 'pw-ben-e2e', subject: 'sub-ben', name: 'Ben Example' };
const CARL = { email: 'carl@acme.e2e.test', firstName: 'Carl', lastName: 'Example', password: 'pw-carl-e2e', subject: 'sub-carl', name: 'Carl Example' };
// A person at the platform who holds the address of the account the
// workspace is created with.
const IMPOSTOR = { email: OWNER_EMAIL, firstName: 'Dora', lastName: 'Example', password: 'pw-dora-e2e', subject: 'sub-dora', name: 'Dora Example' };

let kc;
let installed;
let sidecar;
let appUpstream;
const names = { pg: 'sso-e2e-docmost-pg', redis: 'sso-e2e-docmost-redis', app: 'sso-e2e-docmost', sidecar: 'sso-e2e-docmost-sidecar' };

function psql(sql) {
    return setup.docker('exec', names.pg, 'psql', '-U', 'docmost', '-d', 'docmost', '-At', '-c', sql);
}

// The profile's post-install job: its own image and its own script, with the
// environment the platform gives such a job (the app's database and its
// generated secrets), on the network where Docmost answers under the name the
// script calls it by. Answers what it printed.
let scriptDir;
function runInstallJob() {
    if (!scriptDir) {
        scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sso-e2e-docmost-job-'));
        fs.writeFileSync(path.join(scriptDir, 'run.sh'), INSTALL.script);
        fs.chmodSync(scriptDir, 0o755);
        fs.chmodSync(path.join(scriptDir, 'run.sh'), 0o644);
    }
    return setup.docker('run', '--rm', '--network', setup.NETWORK, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '-v', `${scriptDir}:/scripts:ro`, '--entrypoint', '/bin/sh',
        '-e', `DB_HOST=${names.pg}`, '-e', 'DB_PORT=5432', '-e', 'DB_NAME=docmost', '-e', 'DB_USER=docmost', '-e', 'DB_PASSWORD=dm-e2e',
        '-e', `APP_SECRET=${APP_SECRET}`, INSTALL.image, '/scripts/run.sh');
}

// What exists, counted: the run asserts that a second time makes nothing.
function counts() {
    const [users, groups, groupUsers, spaces, spaceMembers] = psql(
        'select (select count(*) from users), (select count(*) from groups where deleted_at is null), (select count(*) from group_users), ' +
        '(select count(*) from spaces where deleted_at is null), (select count(*) from space_members where deleted_at is null)').split('|').map(Number);
    return { users, groups, groupUsers, spaces, spaceMembers };
}

before(async () => {
    kc = await setup.startKeycloak();
    await setup.ensureRealm(kc, REALM, [ANNA, BEN, CARL, IMPOSTOR]);
    for (const person of [ANNA, BEN, CARL]) await setup.setAppAdmin(kc, REALM, person.email, false);
    await setup.ensureSidecarClient(kc, REALM, HOST, { logoutUrl: setup.logoutUrlOf(names.sidecar) });
    for (const name of Object.values(names)) setup.removeSidecar(name);
    setup.docker('run', '-d', '--name', names.pg, '--network', setup.NETWORK,
        '-e', 'POSTGRES_USER=docmost', '-e', 'POSTGRES_PASSWORD=dm-e2e', '-e', 'POSTGRES_DB=docmost', 'postgres:16-alpine');
    setup.docker('run', '-d', '--name', names.redis, '--network', setup.NETWORK, 'redis:7-alpine');
    await setup.waitFor('PostgreSQL', async () => setup.tryDocker('exec', names.pg, 'pg_isready', '-U', 'docmost') !== '', 60);
    // Under the name its Service has on a cluster, which the job calls it by.
    setup.docker('run', '-d', '--name', names.app, '--network', setup.NETWORK, '--network-alias', 'docmost-ce', '-p', '127.0.0.1::3000',
        '-e', `APP_URL=https://${HOST}`, '-e', `APP_SECRET=${APP_SECRET}`,
        '-e', `DATABASE_URL=postgresql://docmost:dm-e2e@${names.pg}:5432/docmost`,
        '-e', `REDIS_URL=redis://${names.redis}:6379`, '-e', 'STORAGE_DRIVER=local', '-e', 'DISABLE_TELEMETRY=true', IMAGE);
    appUpstream = `http://127.0.0.1:${setup.publishedPort(names.app, 3000)}`;
    await setup.waitFor('Docmost', async () => (await setup.call('GET', `${appUpstream}/api/health`)).status === 200, 240);
    sidecar = setup.startSidecar({
        name: names.sidecar, host: HOST, realm: REALM, kc, handlerFile: HANDLER,
        env: {
            DB_HOST: names.pg, DB_PORT: '5432', DB_NAME: 'docmost', DB_USER: 'docmost', DB_PASSWORD: 'dm-e2e',
            SECRET_APP_SECRET: APP_SECRET, APP_URL: `http://${names.app}:3000`,
        },
    });
    await setup.sidecarReady(sidecar);
    // The install: the job runs once Docmost is up, before anybody opens it.
    assert.equal(INSTALL.image, IMAGE);
    installed = runInstallJob();
});

after(() => {
    if (scriptDir) fs.rmSync(scriptDir, { recursive: true, force: true });
    if (process.env.E2E_KEEP) return;
    for (const name of Object.values(names)) setup.removeSidecar(name);
});

function browserAs(door) {
    return new Browser({
        [setup.IDP_HOST]: keycloak(kc.upstream),
        [HOST]: frontDoor({ door, sidecar: sidecar.upstream, app: appUpstream, realm: REALM, entryPaths: ENTRY_PATHS, denyPaths: DENY_PATHS }),
    });
}

async function whoAmI(browser) {
    const res = await browser.request('POST', `https://${HOST}/api/users/me`, { json: {} });
    return { status: res.status, body: res.status === 200 ? JSON.parse(res.body) : null };
}

async function signIn(person) {
    const browser = browserAs({ person });
    const res = await browser.navigate(`https://${HOST}/`, { credentials: { username: person.email, password: person.password } });
    return { browser, res };
}

// The spaces Docmost shows a person, by their addresses.
async function spacesOf(browser) {
    const res = await browser.request('POST', `https://${HOST}/api/spaces`, { json: { limit: 100 } });
    assert.equal(res.status, 200, res.body);
    return JSON.parse(res.body).data.items.map((s) => s.slug).sort();
}

test('after the install the tenant has its workspace, its group and its shared space, and nobody was asked anything', () => {
    assert.match(installed, /workspace made/);
    assert.match(installed, /group made/);
    assert.match(installed, /space made/);
    assert.equal(psql('select name from workspaces'), 'Docmost');
    assert.equal(psql('select email, role, password is null from users'), `${OWNER_EMAIL}|owner|t`);
    // The group, named after the tenant, made by the workspace's own account.
    assert.equal(psql("select g.name, u.email from groups g join users u on u.id = g.creator_id where not g.is_default and g.deleted_at is null"),
        `${TENANT}|${OWNER_EMAIL}`);
    // The space, named after the tenant, shared for writing with the group
    // every member is in.
    assert.equal(psql(`select s.name, g.is_default, m.role from spaces s join space_members m on m.space_id = s.id and m.group_id is not null join groups g on g.id = m.group_id where s.slug = '${TENANT}'`),
        `${TENANT}|t|writer`);
});

test('the install job, run again, makes nothing', () => {
    const before = counts();
    const out = runInstallJob();
    assert.doesNotMatch(out, /made/);
    assert.deepEqual(counts(), before);
});

test('the first person to open Docmost is in, as a member, and meets no setup page', async () => {
    const browser = browserAs({ person: ANNA });
    const res = await browser.navigate(`https://${HOST}/`, { credentials: { username: ANNA.email, password: ANNA.password } });
    assert.equal(res.status, 200, browser.log.join(' -> '));
    assert.equal(new URL(res.url).pathname, '/home');

    const cookie = browser.cookie(HOST, 'authToken');
    assert.match(cookie.raw, /; Path=\/; Max-Age=\d+; Secure; SameSite=Lax; HttpOnly$/);

    const me = await whoAmI(browser);
    assert.equal(me.status, 200);
    const user = me.body.data.user;
    assert.equal(user.email, ANNA.email);
    assert.equal(user.name, ANNA.name);
    assert.equal(user.role, 'member');
    assert.equal(me.body.data.workspace.name, 'Docmost');
});

test('nobody has a password, the account that owns the workspace included', () => {
    assert.equal(psql('select count(*) from users'), '2');
    assert.equal(psql('select count(*) from users where password is not null'), '0');
    assert.equal(psql("select role from users where email = 'config-account@docmost.internal'"), 'owner');
});

test('the session ends when the sidecar said it would, in the token and in Docmost\'s own record', () => {
    const left = Number(psql("select extract(epoch from (expires_at - now()))::int from user_sessions order by created_at desc limit 1"));
    assert.ok(left > 3500 && left <= 3600, String(left));
});

test('a second person gets an account of their own', async () => {
    const browser = browserAs({ person: BEN });
    const res = await browser.navigate(`https://${HOST}/`, { credentials: { username: BEN.email, password: BEN.password } });
    assert.equal(new URL(res.url).pathname, '/home', browser.log.join(' -> '));
    const me = await whoAmI(browser);
    assert.equal(me.body.data.user.email, BEN.email);
    assert.equal(me.body.data.user.role, 'member');
    assert.equal(psql('select count(*) from users'), '3');
});

test('from the first sign-in a person has a space of their own, is in the tenant\'s group, and sees the shared space', async () => {
    // Anna signed in above. Her space: named after her, at her address's
    // first part, made by the workspace's account, and she administers it.
    assert.equal(psql(`select s.name, m.role, c.email from spaces s join space_members m on m.space_id = s.id join users u on u.id = m.user_id join users c on c.id = s.creator_id where s.slug = 'anna' and u.email = '${ANNA.email}'`),
        `${ANNA.name}|admin|${OWNER_EMAIL}`);
    assert.equal(psql(`select count(*) from group_users gu join groups g on g.id = gu.group_id join users u on u.id = gu.user_id where g.name = '${TENANT}' and u.email in ('${ANNA.email}', '${BEN.email}')`), '2');

    // What each of them is shown: Docmost's own first space, the tenant's
    // shared space, and their own -- not the other's.
    const anna = await signIn(ANNA);
    assert.deepEqual(await spacesOf(anna.browser), ['acme', 'anna', 'general']);
    const ben = await signIn(BEN);
    assert.deepEqual(await spacesOf(ben.browser), ['acme', 'ben', 'general']);

    // Ben may write in the shared space and cannot open Anna's.
    const shared = psql(`select id from spaces where slug = '${TENANT}'`);
    const page = await ben.browser.request('POST', `https://${HOST}/api/pages/create`, { json: { spaceId: shared, title: 'made in the test' } });
    assert.equal(page.status, 200, page.body);
    const annas = psql("select id from spaces where slug = 'anna'");
    const info = await ben.browser.request('POST', `https://${HOST}/api/spaces/info`, { json: { spaceId: annas } });
    assert.ok([403, 404].includes(info.status), `Ben asked for Anna's space and was answered ${info.status}`);
    const intruding = await ben.browser.request('POST', `https://${HOST}/api/pages/create`, { json: { spaceId: annas, title: 'not here' } });
    assert.ok([403, 404].includes(intruding.status), `Ben wrote to Anna's space and was answered ${intruding.status}`);
});

test('a second sign-in makes no second space, no second membership and no second account', async () => {
    const before = counts();
    for (const person of [ANNA, BEN, ANNA]) {
        const { res } = await signIn(person);
        assert.equal(new URL(res.url).pathname, '/home');
    }
    assert.deepEqual(counts(), before);
});

test('a space a person deleted is not made again', async () => {
    // Ben removes his own space; he is in the tenant's group, which is what
    // says his first sign-in is behind him.
    psql("delete from spaces where slug = 'ben'");
    const { browser } = await signIn(BEN);
    assert.deepEqual(await spacesOf(browser), ['acme', 'general']);
    assert.equal(psql("select count(*) from spaces where slug = 'ben'"), '0');
});

test('a person who signs in before the tenant\'s group exists gets it at the next sign-in, and nothing twice', async () => {
    // The group is gone -- an administrator of the app deleted it, or the
    // install job has not run yet.
    const group = psql(`select id from groups where name = '${TENANT}' and deleted_at is null`);
    psql(`delete from groups where id = '${group}'`);
    const first = await signIn(CARL);
    assert.equal(new URL(first.res.url).pathname, '/home', first.browser.log.join(' -> '));
    assert.deepEqual(await spacesOf(first.browser), ['acme', 'carl', 'general']);
    assert.equal(psql('select count(*) from groups where not is_default and deleted_at is null'), '0');

    // The job brings the group back, and nothing else.
    const spaces = counts().spaces;
    const out = runInstallJob();
    assert.match(out, /group made/);
    assert.doesNotMatch(out, /space made|workspace made/);
    assert.equal(counts().spaces, spaces);

    // Each person is put in it at their next sign-in, and gets no second
    // space. (Ben, who deleted his, is left out here: with the group gone
    // nothing says his first sign-in is behind him, and his next one makes
    // him a space again.)
    for (const person of [CARL, ANNA]) await signIn(person);
    assert.equal(psql(`select count(*) from group_users gu join groups g on g.id = gu.group_id where g.name = '${TENANT}' and g.deleted_at is null`), '2');
    assert.equal(counts().spaces, spaces);
    const again = counts();
    for (const person of [CARL, ANNA]) await signIn(person);
    assert.deepEqual(counts(), again);
});

test('a person at the platform who holds the workspace account\'s address is not signed in as it', async () => {
    const sessions = () => psql(`select count(*) from user_sessions s join users u on u.id = s.user_id where u.email = '${OWNER_EMAIL}'`);
    const before = sessions();
    const { browser, res } = await signIn(IMPOSTOR);
    assert.equal(res.status, 403, browser.log.join(' -> '));
    assert.equal(browser.cookie(HOST, 'authToken'), undefined);
    assert.equal(sessions(), before);
});

// Who administers Docmost: who holds the platform's App Admin role, and
// nobody else.

async function roleOf(person) {
    const { browser, res } = await signIn(person);
    assert.equal(new URL(res.url).pathname, '/home', browser.log.join(' -> '));
    const me = await whoAmI(browser);
    return { browser, role: me.body.data.user.role };
}

// Something only an administrator of the workspace may do: change its
// settings. Here, to the name it has.
async function mayAdminister(browser) {
    const res = await browser.request('POST', `https://${HOST}/api/workspace/update`, { json: { name: 'Docmost' } });
    assert.ok([200, 403].includes(res.status), `changing the workspace answered ${res.status}`);
    return res.status === 200;
}

test('a person who holds the App Admin role administers Docmost, and nobody else does', async () => {
    await setup.setAppAdmin(kc, REALM, ANNA.email, true);
    const anna = await roleOf(ANNA);
    assert.equal(anna.role, 'admin');
    assert.equal(await mayAdminister(anna.browser), true);

    const ben = await roleOf(BEN);
    assert.equal(ben.role, 'member');
    assert.equal(await mayAdminister(ben.browser), false);
    // The first person in, the tenant's own account, anybody: only the role.
    assert.equal(psql("select string_agg(email, ',' order by email) from users where role = 'admin'"), ANNA.email);
    assert.equal(psql("select string_agg(email, ',') from users where role = 'owner'"), OWNER_EMAIL);
});

test('withdrawing the role takes it away in Docmost at the next sign-in', async () => {
    const before = await roleOf(ANNA);
    assert.equal(before.role, 'admin');
    await setup.setAppAdmin(kc, REALM, ANNA.email, false);
    const after = await roleOf(ANNA);
    assert.equal(after.role, 'member');
    assert.equal(await mayAdminister(after.browser), false);
    // The session she still had from before is no administrator's either:
    // Docmost reads the role on every request.
    assert.equal(await mayAdminister(before.browser), false);
    assert.equal(psql("select count(*) from users where role = 'admin'"), '0');
});

test('an administrator made inside Docmost who does not hold the role is one until the next sign-in', async () => {
    psql(`update users set role = 'admin' where email = '${BEN.email}'`);
    assert.equal((await roleOf(BEN)).role, 'member');
});

test('nothing a browser sends makes an administrator of Docmost', async () => {
    const browser = browserAs({ person: BEN });
    const request = browser.request.bind(browser);
    const claims = { 'x-gentian-app-admin': 'true', 'x-gentian-roles': setup.APP_ADMIN_ROLE, role: 'admin' };
    browser.request = (method, url, options = {}) => request(method, url, { ...options, headers: { ...(options.headers || {}), ...claims } });
    const res = await browser.navigate(`https://${HOST}/?appAdmin=true`, { credentials: { username: BEN.email, password: BEN.password } });
    assert.equal(new URL(res.url).pathname, '/home', browser.log.join(' -> '));
    assert.equal((await whoAmI(browser)).body.data.user.role, 'member');
    // Docmost's own call for it is not a member's to make.
    const id = psql(`select id from users where email = '${BEN.email}'`);
    const self = await browser.request('POST', `https://${HOST}/api/workspace/members/change-role`, { json: { userId: id, role: 'admin' } });
    assert.equal(self.status, 403);
    assert.equal(psql("select count(*) from users where role = 'admin'"), '0');
});

test('opening the app again makes no second account and asks for nothing', async () => {
    const browser = browserAs({ person: ANNA });
    await browser.navigate(`https://${HOST}/`, { credentials: { username: ANNA.email, password: ANNA.password } });
    browser.log.length = 0;
    const res = await browser.navigate(`https://${HOST}/`);
    assert.equal(new URL(res.url).pathname, '/home');
    assert.ok(!browser.log.some((line) => line.includes('login-actions')), browser.log.join(' -> '));
    assert.equal(psql(`select count(*) from users where email = '${ANNA.email}'`), '1');
});

test('Docmost\'s own sign-in and setup calls are not reachable through the front door', async () => {
    const browser = browserAs({ person: ANNA });
    for (const path of DENY_PATHS) {
        const res = await browser.request('POST', `https://${HOST}${path}`, { json: { email: ANNA.email, password: 'whatever-it-is' } });
        assert.equal(res.status, 403, path);
    }
});

test('Docmost\'s own sign-in page leads to the platform\'s sign-in instead', async () => {
    const browser = browserAs({ person: ANNA });
    const res = await browser.request('GET', `https://${HOST}/login`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/sso/login');
});

test('signing out in Docmost ends the session there', async () => {
    const browser = browserAs({ person: ANNA });
    await browser.navigate(`https://${HOST}/`, { credentials: { username: ANNA.email, password: ANNA.password } });
    const token = browser.cookie(HOST, 'authToken').value;
    assert.equal((await whoAmI(browser)).status, 200);
    const out = await browser.request('POST', `https://${HOST}/api/auth/logout`, { json: {} });
    assert.equal(out.status, 200);
    // The token itself, presented again, is refused: its session is revoked.
    const again = await setup.call('POST', `${appUpstream}/api/users/me`, {
        headers: { host: HOST, 'content-type': 'application/json', cookie: `authToken=${token}` }, body: '{}',
    });
    assert.equal(again.status, 401);
});

// Signing out at the platform. The realm tells the sidecar, and the handler
// ends the person's sessions in Docmost.

// The token as a browser would go on presenting it, straight to Docmost.
async function tokenStatus(token) {
    const res = await setup.call('POST', `${appUpstream}/api/users/me`, {
        headers: { host: HOST, 'content-type': 'application/json', cookie: `authToken=${token}` }, body: '{}',
    });
    return res.status;
}

test('signing out at the platform ends the person\'s session in Docmost, and nobody else\'s', async () => {
    const anna = (await signIn(ANNA)).browser;
    const carl = (await signIn(CARL)).browser;
    const annaToken = anna.cookie(HOST, 'authToken').value;
    const carlToken = carl.cookie(HOST, 'authToken').value;
    assert.equal(await tokenStatus(annaToken), 200);
    assert.equal(await tokenStatus(carlToken), 200);

    const posted = (await setup.signOutPosts(sidecar)).length;
    await setup.signOutAtRealm(anna, REALM);
    const posts = await setup.waitForSignOut(sidecar, posted + 1);
    assert.equal(posts.length, posted + 1, 'the realm told the sidecar once');
    assert.equal(posts[posts.length - 1].status, 200);
    assert.equal(posts[posts.length - 1].host, sidecar.service.host);

    // Her token, which has most of its hour left, opens nothing: the next
    // person at this browser is not her.
    assert.equal(await tokenStatus(annaToken), 401);
    assert.equal((await whoAmI(anna)).status, 401);
    assert.equal(psql(`select count(*) from user_sessions s join users u on u.id = s.user_id where u.email = '${ANNA.email}'`), '0');
    // Carl is where he was.
    assert.equal(await tokenStatus(carlToken), 200);
    assert.equal((await whoAmI(carl)).body.data.user.email, CARL.email);

    // Opening Docmost again leads to the realm, which asks who she is.
    const again = await anna.navigate(`https://${HOST}/`);
    assert.match(again.body, /kc-form-login/);
});

test('a sign-out the realm did not send, or sent before, ends no session in Docmost', async () => {
    const carl = (await signIn(CARL)).browser;
    const token = carl.cookie(HOST, 'authToken').value;
    await refusedSignOuts(sidecar, { realm: REALM, email: CARL.email });
    assert.equal(await tokenStatus(token), 200);
});

test('an account switched off in Docmost is not signed in', async () => {
    psql(`update users set deactivated_at = now() where email = '${BEN.email}'`);
    const browser = browserAs({ person: BEN });
    const res = await browser.navigate(`https://${HOST}/`, { credentials: { username: BEN.email, password: BEN.password } });
    assert.equal(res.status, 403);
    assert.equal(browser.cookie(HOST, 'authToken'), undefined);
    psql(`update users set deactivated_at = null where email = '${BEN.email}'`);
});

test('the sidecar\'s log names nobody', () => {
    const logs = setup.logsOf(names.sidecar);
    assert.match(logs, /"event":"signed-in"/);
    assert.match(logs, /"event":"signed-out"/);
    assert.doesNotMatch(logs, /anna|ben@|carl|dora|Example/i);
});
