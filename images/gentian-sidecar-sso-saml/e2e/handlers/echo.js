'use strict';

// The smallest handler: one cookie, one redirect. For the runs that are about
// the sidecar and the identity provider and not about an app.
//
// It has no app to end a session in, so it counts: how often each person was
// signed out is carried in the next cookie that person is given, which is how
// a run sees whom the sidecar told it about.
const signedOut = new Map();

module.exports = {
    async onLogin(person, ctx) {
        const value = `${person.email}|${ctx.sessionSeconds}|${person.appAdmin}|${signedOut.get(person.email) || 0}`;
        return {
            redirect: '/signed-in',
            cookies: [{ name: 'e2e_session', value: Buffer.from(value).toString('base64url') }],
        };
    },
    async onLogout(person, ctx) {
        signedOut.set(person.email, (signedOut.get(person.email) || 0) + 1);
        ctx.log('sessions-ended');
    },
};
