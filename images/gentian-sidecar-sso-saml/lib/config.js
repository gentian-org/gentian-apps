'use strict';

// Everything the sidecar is told, read once at start.
//
// Every address is given by the platform. Nothing is assembled here from a
// tenant's name and a domain: where the identity provider is, which realm a
// tenant's people are in and where the app answers differ between a tenant
// under the cluster's domain, the one tenant of a single-tenancy cluster and
// a tenant on a domain of its own, and only the platform knows which applies.

// Optional: SSO_LOGOUT_URL, SSO_LOGIN_PATH, SSO_SESSION_MAX_SECONDS,
// SSO_CLOCK_SKEW_MS, SSO_HANDLER_PATH, PORT.
const REQUIRED = [
    'SSO_ENTITY_ID',
    'SSO_ACS_URL',
    'SSO_IDP_ENTITY_ID',
    'SSO_IDP_SSO_URL',
    'SSO_IDP_DESCRIPTOR_URL',
    'SSO_REALM',
    'SSO_HANDLER_SHA256',
];

// The longest an app session made here may last, whatever is configured.
const SESSION_CEILING_SECONDS = 3600;

function httpsUrl(name, value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`${name} is not a URL`);
    }
    if (url.protocol !== 'https:') {
        throw new Error(`${name} must be an https URL`);
    }
    if (url.username || url.password || url.hash) {
        throw new Error(`${name} must not carry credentials or a fragment`);
    }
    return url;
}

function plainPath(name, value) {
    if (!/^\/[A-Za-z0-9._~\/-]*$/.test(value) || value.includes('//') || value.includes('..')) {
        throw new Error(`${name} is not a plain path`);
    }
    return value;
}

function positiveInt(name, value, fallback) {
    if (value === undefined || value === '') return fallback;
    if (!/^[0-9]+$/.test(value)) throw new Error(`${name} is not a whole number`);
    return parseInt(value, 10);
}

function loadConfig(env) {
    const missing = REQUIRED.filter((name) => !env[name]);
    if (missing.length > 0) {
        throw new Error(`not configured: ${missing.join(', ')}`);
    }

    const acsUrl = httpsUrl('SSO_ACS_URL', env.SSO_ACS_URL);
    if (acsUrl.search) throw new Error('SSO_ACS_URL must not carry a query');
    const acsPath = plainPath('SSO_ACS_URL path', acsUrl.pathname);
    const loginPath = plainPath('SSO_LOGIN_PATH', env.SSO_LOGIN_PATH || '/sso/login');
    if (loginPath === acsPath) throw new Error('SSO_LOGIN_PATH and the path of SSO_ACS_URL are the same');

    const idpSsoUrl = httpsUrl('SSO_IDP_SSO_URL', env.SSO_IDP_SSO_URL);

    // The descriptor is read inside the cluster, so it may be plain http.
    let descriptorUrl;
    try {
        descriptorUrl = new URL(env.SSO_IDP_DESCRIPTOR_URL);
    } catch {
        throw new Error('SSO_IDP_DESCRIPTOR_URL is not a URL');
    }
    if (!['http:', 'https:'].includes(descriptorUrl.protocol)) {
        throw new Error('SSO_IDP_DESCRIPTOR_URL must be an http or https URL');
    }

    // Where the realm tells this sidecar that a person signed out: an address
    // inside the cluster, which the realm calls server to server, so it may be
    // plain http and is not on the app's public host. Optional: a sidecar
    // that is given none takes no sign-out at all.
    let logoutUrl = null;
    let logoutPath = null;
    let logoutHost = null;
    if (env.SSO_LOGOUT_URL) {
        let url;
        try {
            url = new URL(env.SSO_LOGOUT_URL);
        } catch {
            throw new Error('SSO_LOGOUT_URL is not a URL');
        }
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('SSO_LOGOUT_URL must be an http or https URL');
        if (url.username || url.password || url.hash || url.search) {
            throw new Error('SSO_LOGOUT_URL must not carry credentials, a query or a fragment');
        }
        logoutPath = plainPath('SSO_LOGOUT_URL path', url.pathname);
        if (logoutPath === acsPath || logoutPath === loginPath) {
            throw new Error('the path of SSO_LOGOUT_URL is the sign-in\'s own');
        }
        logoutHost = url.host.toLowerCase();
        if (logoutHost === acsUrl.host.toLowerCase()) {
            throw new Error('SSO_LOGOUT_URL is on the app\'s public host: a sign-out is told inside the cluster');
        }
        // As written, not as a URL parser would write it again: the realm
        // names this string in its request, and the two are compared.
        logoutUrl = env.SSO_LOGOUT_URL;
    }

    const handlerDigest = env.SSO_HANDLER_SHA256.replace(/^sha256:/, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(handlerDigest)) {
        throw new Error('SSO_HANDLER_SHA256 is not a sha256 digest');
    }

    const sessionMaxSeconds = Math.min(
        positiveInt('SSO_SESSION_MAX_SECONDS', env.SSO_SESSION_MAX_SECONDS, SESSION_CEILING_SECONDS),
        SESSION_CEILING_SECONDS,
    );
    if (sessionMaxSeconds < 60) throw new Error('SSO_SESSION_MAX_SECONDS is under a minute');

    return Object.freeze({
        entityId: env.SSO_ENTITY_ID,
        acsUrl: acsUrl.origin + acsPath,
        acsPath,
        loginPath,
        origin: acsUrl.origin,
        host: acsUrl.host,
        idpEntityId: env.SSO_IDP_ENTITY_ID,
        idpSsoUrl: idpSsoUrl.toString(),
        descriptorUrl: descriptorUrl.toString(),
        logoutUrl,
        logoutPath,
        logoutHost,
        realm: env.SSO_REALM,
        handlerPath: env.SSO_HANDLER_PATH || '/usr/src/app/custom/handler.js',
        handlerDigest,
        sessionMaxSeconds,
        clockSkewMs: Math.min(positiveInt('SSO_CLOCK_SKEW_MS', env.SSO_CLOCK_SKEW_MS, 5000), 60000),
        port: positiveInt('PORT', env.PORT, 8081),
    });
}

module.exports = { loadConfig, SESSION_CEILING_SECONDS };
