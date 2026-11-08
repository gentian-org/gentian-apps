'use strict';

// A handler written before sign-out was part of the contract: it signs in
// and has nothing to say when a person signs out.
module.exports = {
    async onLogin(person, ctx) {
        return {
            redirect: '/signed-in',
            cookies: [{ name: 'e2e_session', value: Buffer.from(`${person.email}|${ctx.sessionSeconds}|${person.appAdmin}`).toString('base64url') }],
        };
    },
};
