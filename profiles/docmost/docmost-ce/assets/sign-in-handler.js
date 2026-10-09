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
//   3. who administers Docmost: the person the sidecar says holds the
//      platform's App Admin role has the workspace role "admin", and a
//      person it does not say so of has "member" -- set with Docmost's own
//      call for changing a member's role, and only when the account is not
//      already what it should be. Nobody is an administrator for having been
//      the first, or for administering the tenant. The role "owner" stays
//      with the account the workspace was created with.
//   4. at a person's first sign-in, what the tenant's people share and what
//      is theirs alone: a space of their own, and membership of the tenant's
//      group. The group and the tenant's shared space are made once, by the
//      profile's post-install job, which is told the tenant's name; this
//      handler is not.
//   5. a session row and the token that names it, both ending when the
//      sidecar says the session ends.
//
// And when the person signs out at the platform (onLogout): their session
// rows are deleted. Docmost looks a token's session up on every request, so
// every token of theirs is refused from then on, in whichever browser it is.
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

// The account the workspace was created with, and a token of a minute for
// it: what Docmost's own calls for inviting a person, changing a role and
// making a space are made with. It is shown to nothing but Docmost inside
// the cluster.
async function ownerOf(workspaceId) {
    const owner = await pool.query(
        "select id, email from users where workspace_id = $1 and role = 'owner' and deleted_at is null order by created_at asc limit 1",
        [workspaceId]);
    if (owner.rows.length === 0) throw new Error('the workspace has no owner');
    return {
        id: owner.rows[0].id,
        token: sign({ sub: owner.rows[0].id, email: owner.rows[0].email, workspaceId, type: 'access' }, 60),
    };
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
        'select id, email, name, role, deactivated_at, deleted_at from users where workspace_id = $1 and lower(email) = $2 limit 1',
        [workspaceId, email]);
    return found.rows[0] || null;
}

async function createUser(workspaceId, person) {
    const ownerToken = (await ownerOf(workspaceId)).token;
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

// Who administers Docmost is who holds the platform's App Admin role, and it
// is settled at every sign-in: given to a person who holds it, taken from a
// person who does not. person.appAdmin is the sidecar's reading of the
// realm's signed answer; a sidecar that does not say is one that says no.
// The session is made only once the account is what it should be, so a
// person the role was withdrawn from is not signed in as an administrator
// because a call failed.
async function settleAdministrator(workspaceId, user, person) {
    const wanted = person.appAdmin === true ? 'admin' : 'member';
    // "owner" is the workspace's own account's, and no sign-in changes it.
    if (user.role === wanted || user.role === 'owner') return false;
    const status = await app('/api/workspace/members/change-role', { userId: user.id, role: wanted }, (await ownerOf(workspaceId)).token);
    const now = await pool.query('select role from users where id = $1 and workspace_id = $2', [user.id, workspaceId]);
    if (now.rows.length !== 1 || now.rows[0].role !== wanted) throw new Error(`changing the role answered ${status}`);
    return true;
}

// The tenant's group: the one group the workspace's own account made. That
// account is nobody's -- it has no password and is signed in as by nothing
// -- so the only group it ever made is the one the profile's post-install
// job made with it, named after the tenant. Found this way and not by name:
// the handler is not told the tenant's name, and an administrator of the app
// may rename the group without its people falling out of it.
async function tenantGroup(workspaceId, ownerId) {
    const found = await pool.query(
        'select id from groups where workspace_id = $1 and creator_id = $2 and is_default = false and deleted_at is null ' +
        'order by created_at asc limit 1', [workspaceId, ownerId]);
    return found.rows.length > 0 ? found.rows[0].id : null;
}

// A space's address, as Docmost wants one: letters, digits, "-" and "_",
// starting with a letter or digit, at least two characters.
function slugOf(text) {
    const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
    return slug.length >= 2 ? slug : '';
}

// What a person has from their first sign-in on: a space of their own and
// membership of the tenant's group. (The tenant's shared space needs nothing
// here: it is shared with the group Docmost puts every member in.)
//
// Membership of the tenant's group is added last and is what says this was
// done, so every later sign-in costs one query and creates nothing.
//
// The space is made by the workspace's own account, because a member may not
// make one, and the person is then made its administrator. It is found again
// by its address, which is the part of the person's e-mail address before
// the "@". An address already taken -- by another person of the same name at
// another domain, or by a space somebody made -- is left alone: nobody is
// added to a space that already existed.
//
// None of it may cost a person their sign-in: a failure is noted and tried
// again at the next one.
async function welcome(workspaceId, user, person, ctx) {
    const owner = await ownerOf(workspaceId);
    const groupId = await tenantGroup(workspaceId, owner.id);
    if (groupId) {
        const member = await pool.query('select 1 from group_users where group_id = $1 and user_id = $2 limit 1', [groupId, user.id]);
        if (member.rows.length > 0) return;
    }

    const slug = slugOf(person.email.split('@')[0]);
    if (slug) {
        // As Docmost itself asks whether an address is taken.
        const taken = await pool.query('select 1 from spaces where workspace_id = $1 and lower(slug) = $2 limit 1', [workspaceId, slug]);
        if (taken.rows.length === 0) {
            const name = (user.name || '').trim().length >= 2 ? user.name.trim().slice(0, 100) : slug;
            const made = await app('/api/spaces/create', { name, slug }, owner.token);
            const space = await pool.query(
                'select id from spaces where workspace_id = $1 and lower(slug) = $2 and creator_id = $3 limit 1',
                [workspaceId, slug, owner.id]);
            if (made !== 200 || space.rows.length === 0) throw new Error(`making the person's space answered ${made}`);
            const added = await app('/api/spaces/members/add',
                { spaceId: space.rows[0].id, role: 'admin', userIds: [user.id], groupIds: [] }, owner.token);
            if (added !== 200) throw new Error(`giving the person their space answered ${added}`);
            ctx.log('personal-space-made');
        }
    }

    if (!groupId) {
        // The post-install job has not run yet. Asked again at the next sign-in.
        ctx.log('no-tenant-group-yet');
        return;
    }
    const joined = await app('/api/groups/members/add', { groupId, userIds: [user.id] }, owner.token);
    if (joined !== 200) throw new Error(`adding the person to the tenant's group answered ${joined}`);
}

module.exports = {
    async onLogin(person, ctx) {
        // The account the workspace was created with is nobody's: a person at
        // the platform who holds its address is not signed in as it.
        if (person.email === OWNER.email) return { refuse: true };
        const workspaceId = await ensureWorkspace();
        const user = await ensureUser(workspaceId, person);
        // An account an administrator of the app has switched off stays off.
        if (user.deactivated_at || user.deleted_at) return { refuse: true };

        if (await settleAdministrator(workspaceId, user, person)) {
            ctx.log(person.appAdmin === true ? 'administrator-made' : 'administrator-unmade');
        }
        try {
            await welcome(workspaceId, user, person, ctx);
        } catch (err) {
            ctx.log('welcome-incomplete', { detail: String((err && err.message) || 'error').slice(0, 120) });
        }

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
    // The person signed out at the platform: their sessions in Docmost end.
    // All of them, in every browser -- nobody has a password, so there is no
    // session of theirs that was not made here. Docmost reads a token's
    // session from this table on every request and refuses a token whose
    // session is gone, which is also how its own sign-out works.
    async onLogout(person, ctx) {
        const ended = await pool.query(
            'delete from user_sessions where user_id in (select id from users where lower(email) = $1)', [person.email]);
        ctx.log('sessions-ended', { count: ended.rowCount });
    },
};
