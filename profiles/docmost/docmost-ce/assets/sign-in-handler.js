'use strict';

// Sign-in handler for Docmost (community edition), run by the platform's
// sign-in sidecar. See customization.md beside this file for the review.
//
// Docmost's own single sign-on is a paid feature and is not used or touched
// here. What the free edition has is an account per person and a session
// that is a token signed with the installation's APP_SECRET, kept in the
// cookie "authToken" and recorded in the table user_sessions. This handler
// makes exactly that, for the person the sidecar names:
//
//   1. the workspace, if this is the first sign-in ever: Docmost's own setup
//      call, so that nobody meets the "create workspace" page;
//   2. the person's account, if they have none: Docmost's own invitation,
//      created and accepted here, as a member;
//   3. a session row and the token that names it, both ending when the
//      sidecar says the session ends.
//
// Nobody has a password. Docmost's calls demand one for a new account, so a
// random value is given and the stored hash is removed again at once.
//
// What it is given (see the profile's requires.services.identity.sidecar):
//   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD   Docmost's own database
//   SECRET_APP_SECRET                                 Docmost's signing key
//   APP_URL                                           Docmost inside the cluster

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const WORKSPACE_NAME = 'Docmost';
// The account the workspace is created with. Docmost has no service account,
// so it is listed among the members; nobody can sign in as it.
const OWNER = { name: 'Config Account', email: 'config-account@docmost.internal' };

const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 4,
    connectionTimeoutMillis: 5000,
});

function sign(payload, seconds) {
    // The issuer and the algorithm are the ones Docmost signs with
    // (core/auth/token.module.js); it accepts no other.
    return jwt.sign(payload, process.env.SECRET_APP_SECRET, { algorithm: 'HS256', issuer: 'Docmost', expiresIn: seconds });
}

async function app(path, body, token) {
    const res = await fetch(process.env.APP_URL + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
    });
    return res.status;
}

function unknownPassword() {
    return crypto.randomBytes(32).toString('base64url');
}

async function ensureWorkspace() {
    const found = await pool.query('select id from workspaces order by created_at asc limit 1');
    if (found.rows.length > 0) return found.rows[0].id;
    // 403 is "there is a workspace already": another sign-in got here first.
    const status = await app('/api/auth/setup', { ...OWNER, password: unknownPassword(), workspaceName: WORKSPACE_NAME });
    if (status !== 200 && status !== 403) throw new Error(`workspace setup answered ${status}`);
    const made = await pool.query('select id from workspaces order by created_at asc limit 1');
    if (made.rows.length === 0) throw new Error('no workspace after setup');
    await pool.query("update users set password = null where workspace_id = $1 and role = 'owner' and lower(email) = $2",
        [made.rows[0].id, OWNER.email]);
    return made.rows[0].id;
}

async function findUser(workspaceId, email) {
    const found = await pool.query(
        'select id, email, deactivated_at, deleted_at from users where workspace_id = $1 and lower(email) = $2 limit 1',
        [workspaceId, email]);
    return found.rows[0] || null;
}

async function createUser(workspaceId, person) {
    const owner = await pool.query(
        "select id, email from users where workspace_id = $1 and role = 'owner' and deleted_at is null order by created_at asc limit 1",
        [workspaceId]);
    if (owner.rows.length === 0) throw new Error('the workspace has no owner');
    // A token of a minute for the owner, to make the invitation with.
    const ownerToken = sign({ sub: owner.rows[0].id, email: owner.rows[0].email, workspaceId, type: 'access' }, 60);
    const invited = await app('/api/workspace/invites/create', { emails: [person.email], role: 'member', groupIds: [] }, ownerToken);
    if (invited !== 200) throw new Error(`invitation answered ${invited}`);
    const invitation = await pool.query(
        'select id, token from workspace_invitations where workspace_id = $1 and lower(email) = $2 order by created_at desc limit 1',
        [workspaceId, person.email]);
    if (invitation.rows.length === 0) throw new Error('no invitation after it was created');
    const name = person.name.trim().length >= 2 ? person.name.trim().slice(0, 60) : person.email.split('@')[0].padEnd(2, '_');
    const accepted = await app('/api/workspace/invites/accept', {
        invitationId: invitation.rows[0].id, token: invitation.rows[0].token, name, password: unknownPassword(),
    });
    if (accepted !== 200) throw new Error(`accepting the invitation answered ${accepted}`);
    const user = await findUser(workspaceId, person.email);
    if (!user) throw new Error('no account after the invitation was accepted');
    await pool.query('update users set password = null where id = $1', [user.id]);
    return user;
}

// One account is made once, however many sign-ins of the same person arrive
// together. The sidecar is a single process.
const creating = new Map();

async function ensureUser(workspaceId, person) {
    const existing = await findUser(workspaceId, person.email);
    if (existing) return existing;
    if (!creating.has(person.email)) {
        creating.set(person.email, createUser(workspaceId, person).finally(() => creating.delete(person.email)));
    }
    return creating.get(person.email);
}

module.exports = {
    async onLogin(person, ctx) {
        const workspaceId = await ensureWorkspace();
        const user = await ensureUser(workspaceId, person);
        // An account an administrator of the app has switched off stays off.
        if (user.deactivated_at || user.deleted_at) return { refuse: true };

        const session = await pool.query(
            "insert into user_sessions (user_id, workspace_id, device_name, expires_at) " +
            "values ($1, $2, 'Platform sign-in', now() + make_interval(secs => $3)) returning id",
            [user.id, workspaceId, ctx.sessionSeconds]);
        const token = sign(
            { sub: user.id, email: user.email, workspaceId, type: 'access', sessionId: session.rows[0].id },
            ctx.sessionSeconds);
        return {
            // Not "/": the platform sends "/" to the sign-in, and Docmost
            // itself sends it on to /home.
            redirect: '/home',
            cookies: [{ name: 'authToken', value: token }],
        };
    },
};
