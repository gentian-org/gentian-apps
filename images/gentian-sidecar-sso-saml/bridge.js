'use strict';

// gentian-sidecar-sso-saml
//
// Signs a person in to an app that can do neither OIDC nor SAML itself. It
// stands beside the app, on the app's own address, behind the platform's
// front door:
//
//   GET  <login path>  behind the front door's session. Sends the browser to
//                      the tenant's realm with a SAML request.
//   POST <ACS path>    reachable without a session, because the realm posts
//                      the answer from its own address. Checks the answer
//                      (lib/signin.js) and asks the app's handler to make a
//                      session for the person it names.
//   POST <logout URL>  inside the cluster only, and only where the platform
//                      names one. The realm posts here when a person signs
//                      out; the request is checked (lib/signout.js) and the
//                      app's handler is asked to end that person's sessions.
//   GET  /healthz, /readyz   for the kubelet.
//
// The handler is the app's catalogue entry's; see README.md for what one is
// given and what it may answer.

const log = require('./lib/log');
const { loadConfig } = require('./lib/config');
const { Certificates } = require('./lib/idp');
const { SignIn } = require('./lib/signin');
const { SignOut } = require('./lib/signout');
const { loadHandler } = require('./lib/handler');
const { createServer } = require('./lib/server');

function main() {
    let config;
    let handler;
    try {
        config = loadConfig(process.env);
        handler = loadHandler(config.handlerPath, config.handlerDigest);
    } catch (err) {
        log.error('not-started', { detail: err.message });
        process.exit(1);
    }

    const certificates = new Certificates({ descriptorUrl: config.descriptorUrl });
    const signIn = new SignIn({ config, certificates });
    const signOut = config.logoutUrl ? new SignOut({ config, certificates }) : null;
    const server = createServer({ config, signIn, signOut, handler, certificates });

    certificates.load().then(
        () => log.info('certificate-loaded', { count: certificates.known().length }),
        (err) => log.warn('certificate-not-loaded', { detail: err.message }),
    );
    // A realm's key can be changed while this runs.
    setInterval(() => certificates.load().catch(() => {}), 10 * 60 * 1000).unref();

    server.listen(config.port, '0.0.0.0', () => {
        log.info('started', {
            port: config.port,
            entityId: config.entityId,
            acsUrl: config.acsUrl,
            loginPath: config.loginPath,
            logoutUrl: config.logoutUrl,
            signOutHandling: Boolean(config.logoutUrl) && typeof handler.onLogout === 'function',
            identityProvider: config.idpEntityId,
            sessionMaxSeconds: config.sessionMaxSeconds,
        });
    });
    for (const signal of ['SIGTERM', 'SIGINT']) {
        process.on(signal, () => server.close(() => process.exit(0)));
    }
}

if (require.main === module) main();
