'use strict';

// The smallest handler: one cookie, one redirect. For the runs that are about
// the sidecar and the identity provider and not about an app.
module.exports = {
    async onLogin(person, ctx) {
        return {
            redirect: '/signed-in',
            cookies: [{ name: 'e2e_session', value: Buffer.from(`${person.email}|${ctx.sessionSeconds}`).toString('base64url') }],
        };
    },
};
