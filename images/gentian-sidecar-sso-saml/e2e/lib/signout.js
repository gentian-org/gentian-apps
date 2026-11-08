'use strict';

// What every run that signs people out also shows: a sign-out request that
// the realm did not send, or sent before, ends nobody's session.

const assert = require('node:assert/strict');
const setup = require('./setup');
const { makeIdp, buildLogoutRequest } = require('../../test/helpers');

// Presents three requests to a sidecar's sign-out address, each naming email:
// one signed with a key that is not the realm's, one not signed at all, and
// the realm's own last request a second time. Every one is refused; the
// caller then shows that the person is still signed in.
async function refusedSignOuts(sidecar, { realm, email }) {
    const config = { idpEntityId: `${setup.IDP_BASE}/realms/${realm}`, logoutUrl: sidecar.logoutUrl };
    const stranger = makeIdp();

    const forged = await setup.postSignOut(sidecar, buildLogoutRequest(stranger, config, { email }));
    assert.equal(forged.status, 401, 'a request signed with another key');

    const unsigned = await setup.postSignOut(sidecar, buildLogoutRequest(stranger, config, { email, signed: false }));
    assert.equal(unsigned.status, 401, 'a request nobody signed');

    const fromRealm = (await setup.signOutPosts(sidecar)).filter((post) => post.status === 200 && /BACK_CHANNEL_LOGOUT/.test(post.body));
    assert.ok(fromRealm.length > 0, 'the realm has signed somebody out here before');
    const again = await setup.postSignOut(sidecar, null, { body: fromRealm[fromRealm.length - 1].body });
    assert.equal(again.status, 401, 'the realm\'s own request, a second time');
}

module.exports = { refusedSignOuts };
