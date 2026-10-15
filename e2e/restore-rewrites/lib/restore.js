'use strict';

// What a restore does to an app after its data is back, done the way the
// platform does it (gentian-os, internal/controller/tenantrestore_controller.go,
// runRestoreHooks): each of the profile's spec.backup.restore.post commands,
// read from the profile itself, run in the app's container through env(1)
// with the GENTIAN_RESTORE_* variables (tenantrestore_hookenv.go), and then
// the profile's verify command.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..');
// The sidecar's own development dependency, as the sign-out runs use it.
const YAML = require(path.join(REPO, 'images', 'gentian-sidecar-sso-saml', 'node_modules', 'yaml'));

const NETWORK = process.env.E2E_RESTORE_NETWORK || 'restore-e2e';
const POSTGRES_IMAGE = process.env.E2E_POSTGRES_IMAGE || 'postgres:16.4';

function docker(...args) {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();
}

function tryDocker(...args) {
    try {
        return docker(...args);
    } catch {
        return '';
    }
}

// Run a command and pass it stdin.
function dockerIn(input, ...args) {
    return execFileSync('docker', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(what, probe, seconds = 300) {
    const deadline = Date.now() + seconds * 1000;
    let last;
    while (Date.now() < deadline) {
        try {
            if (await probe()) return;
        } catch (err) {
            last = err;
        }
        await sleep(3000);
    }
    throw new Error(`${what} did not come up in ${seconds}s${last ? ': ' + last.message : ''}`);
}

function profileOf(profileDir) {
    return YAML.parse(fs.readFileSync(path.join(REPO, profileDir, 'profile.yaml'), 'utf8'));
}

// The variables a restore is run with: both ends, and each store's name in
// the bundle and here. A bundle that does not say where it was written has
// the source values empty.
function restoreEnv({ app, source = {}, target = {}, databases = [], buckets = [], volumes = [] }) {
    const vars = {
        APP: app,
        SOURCE_TENANT: source.tenant || '',
        TARGET_TENANT: target.tenant || '',
        SOURCE_DOMAIN: source.domain || '',
        TARGET_DOMAIN: target.domain || '',
        SOURCE_PLATFORM_VERSION: source.platformVersion || '',
        TARGET_PLATFORM_VERSION: target.platformVersion || '0.5',
        SOURCE_CLUSTER: source.cluster || '',
        TARGET_CLUSTER: target.cluster || '',
        SOURCE_CHART_VERSION: source.chartVersion || '',
        TARGET_CHART_VERSION: target.chartVersion || '',
        DATABASES: databases.map(([from, to]) => `${from}=${to}`).join(' '),
        BUCKETS: buckets.map(([from, to]) => `${from}=${to}`).join(' '),
        VOLUMES: volumes.map(([from, to]) => `${from}=${to}`).join(' '),
    };
    return Object.entries(vars).map(([k, v]) => `GENTIAN_RESTORE_${k}=${v}`);
}

// The profile's post-restore commands and its verification, in order, in
// the container as the given user (the pod's runAsUser). Returns what each
// printed; throws on the first that fails, as the restore does.
function runRestore(profile, container, env, { user } = {}) {
    const restore = profile.spec.backup.restore;
    const as = user ? ['-u', user] : [];
    const out = [];
    for (const argv of restore.post || []) {
        out.push(docker('exec', ...as, container, 'env', ...env, ...argv));
    }
    if (restore.verify) out.push(docker('exec', ...as, container, ...restore.verify));
    return out.join('\n');
}

function startPostgres(name) {
    tryDocker('network', 'create', NETWORK);
    tryDocker('rm', '-f', name);
    docker('run', '-d', '--name', name, '--network', NETWORK, '-e', 'POSTGRES_PASSWORD=e2e-postgres-admin', POSTGRES_IMAGE);
    return waitFor('PostgreSQL', () => tryDocker('exec', name, 'pg_isready', '-U', 'postgres').includes('accepting'), 120);
}

function psql(pg, ...sql) {
    return docker('exec', pg, 'psql', '-v', 'ON_ERROR_STOP=1', '-qtA', '-U', 'postgres', ...sql.flatMap((s) => ['-c', s]));
}

function createDatabase(pg, { name, user, password }) {
    psql(pg, `CREATE ROLE "${user}" LOGIN PASSWORD '${password}'`, `CREATE DATABASE "${name}" OWNER "${user}"`);
}

// What an import does with a database: the dump loaded into the database the
// platform made here, under its name and owned by its role, while the role
// the data was written with is gone.
function moveDatabase(pg, from, to) {
    createDatabase(pg, to);
    docker('exec', pg, 'sh', '-c',
        `pg_dump -U postgres -O -x "${from.name}" | PGPASSWORD='${to.password}' psql -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "${to.user}" "${to.name}"`);
    psql(pg, `ALTER ROLE "${from.user}" NOLOGIN`,
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${from.user}'`);
}

function cleanUp(containers, volumes) {
    if (process.env.E2E_KEEP) return;
    for (const c of containers) tryDocker('rm', '-f', c);
    for (const v of volumes) tryDocker('volume', 'rm', '-f', v);
}

module.exports = {
    NETWORK, REPO, YAML, docker, tryDocker, dockerIn, sleep, waitFor, profileOf, restoreEnv, runRestore,
    startPostgres, psql, createDatabase, moveDatabase, cleanUp,
};
