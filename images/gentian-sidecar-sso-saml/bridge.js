const http = require('http');
const url = require('url');
const querystring = require('querystring');
const fs = require('fs');
const zlib = require('zlib');
const { SAML } = require('@node-saml/node-saml');

// Extract basic generic configuration
const tenantId = process.env.SSO_TENANT_ID || 'demo';
const kernelDomain = process.env.SSO_KERNEL_DOMAIN || 'gentian.org';
const issuer = process.env.SSO_ISSUER || 'GentianSidecar';
const port = parseInt(process.env.PORT || '8081');

// Path the IdP posts the assertion back to. This is the path advertised in the
// AuthnRequest, so it must be whatever actually reaches this sidecar on the
// app's public host -- which differs per app: Activepieces fronts the sidecar
// with its own nginx under /api/v1/authn/saml/acs, while an app routed
// straight to this Service by the tenant gateway has no such rewrite and needs
// the real path. It used to be hardcoded to the Activepieces path, which made
// SSO silently unusable for any app that is not Activepieces: the IdP would
// post to a path nothing served. Default preserves the historical value so
// Activepieces is unaffected.
const acsPath = process.env.SSO_ACS_PATH || '/api/v1/authn/saml/acs';

const entryPoint = `https://id.${kernelDomain}/auth/realms/${tenantId}/protocol/saml`;

// Where to read the IdP's signing certificate from. Cluster-internal by
// default: this is a server-to-server call, so it must not hairpin through the
// public edge (app-profile-guide.md §2) -- the same URL activepieces-me's
// postInstallJob already uses to read this realm's descriptor.
const descriptorUrl =
    process.env.SSO_IDP_DESCRIPTOR_URL ||
    `http://gentian-idp-keycloak-keycloakx-http.platform-kernel.svc.cluster.local:8080` +
    `/auth/realms/${tenantId}/protocol/saml/descriptor`;

// Keycloak SAML clients default to signing the *response* ("Sign documents")
// and not the individual assertion ("Sign assertions"), so that is what is
// required by default. Both are tunable for an IdP configured the other way,
// but at least one must stay on -- turning both off accepts unsigned
// assertions, which is the vulnerability this whole module exists to close.
const wantAuthnResponseSigned = (process.env.SSO_WANT_RESPONSE_SIGNED || 'true').toLowerCase() !== 'false';
const wantAssertionsSigned = (process.env.SSO_WANT_ASSERTION_SIGNED || 'false').toLowerCase() === 'true';
const acceptedClockSkewMs = parseInt(process.env.SSO_CLOCK_SKEW_MS || '5000');

// Pluggable handler script
const handlerPath = process.env.APP_HANDLER_SCRIPT || '/usr/src/app/handler.js';

let appHandler = null;
if (fs.existsSync(handlerPath)) {
    appHandler = require(handlerPath);
} else {
    console.warn(`[WARNING] No app handler found at ${handlerPath}. SSO login will not inject users.`);
}

// IdP signing certificates, fetched once at startup and refreshed on demand.
// Null means "not yet known", and every ACS request is rejected while it is
// null: failing closed is the entire point, since accepting an assertion we
// cannot verify is exactly the bypass being fixed.
let idpCerts = null;

function extractCertificates(descriptorXml) {
    const certs = [];
    const re = /<[^>]*X509Certificate[^>]*>([\s\S]*?)<\/[^>]*X509Certificate>/g;
    let m;
    while ((m = re.exec(descriptorXml)) !== null) {
        const body = m[1].replace(/\s+/g, '');
        if (body) certs.push(body);
    }
    return certs;
}

async function loadIdpCertificates() {
    const res = await fetch(descriptorUrl);
    if (!res.ok) {
        throw new Error(`descriptor fetch failed: HTTP ${res.status}`);
    }
    const xml = await res.text();
    const certs = extractCertificates(xml);
    if (certs.length === 0) {
        throw new Error('no X509Certificate found in IdP descriptor');
    }
    idpCerts = certs;
    console.log(`Loaded ${certs.length} IdP signing certificate(s) from ${descriptorUrl}`);
    return certs;
}

async function ensureIdpCertificates() {
    if (idpCerts) return idpCerts;
    return loadIdpCertificates();
}

// The AuthnRequest advertises https://<host><acsPath> and the Destination check
// compares against the same string, so both must resolve the host identically --
// if they disagree, a genuine login is rejected as misaddressed. Host first,
// which is the precedence the AuthnRequest has always used and which Activepieces
// (whose nginx fronts this sidecar) is known to work with.
function resolveHost(req) {
    return req.headers.host || req.headers['x-forwarded-host'];
}

function generateAuthnRequest(host, tenantId, kernelDomain) {
    const id = "_" + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    const issueInstant = new Date().toISOString();
    const xml = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
                        xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
                        ID="${id}"
                        Version="2.0"
                        IssueInstant="${issueInstant}"
                        AssertionConsumerServiceURL="https://${host}${acsPath}"
                        Destination="${entryPoint}">
        <saml:Issuer>${issuer}</saml:Issuer>
        <samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified"
                            AllowCreate="true"/>
    </samlp:AuthnRequest>`;

    const deflated = zlib.deflateRawSync(Buffer.from(xml, 'utf8'));
    return encodeURIComponent(deflated.toString('base64'));
}

// One validator per callback host. The callback URL is part of what is checked
// (the assertion's Destination/Recipient must match where it actually landed),
// and the host is only known per request, so these are built lazily and cached.
const validators = new Map();

function validatorFor(host) {
    const callbackUrl = `https://${host}${acsPath}`;
    if (!validators.has(callbackUrl)) {
        validators.set(callbackUrl, new SAML({
            idpCert: idpCerts,
            issuer,
            callbackUrl,
            entryPoint,
            // Reject an assertion minted for a different service provider.
            audience: issuer,
            wantAuthnResponseSigned,
            wantAssertionsSigned,
            // This sidecar does not persist request IDs, so InResponseTo cannot
            // be correlated. Signature, Destination, Audience and the validity
            // window are all still enforced.
            validateInResponseTo: 'never',
            acceptedClockSkewMs,
        }));
    }
    return validators.get(callbackUrl);
}

// node-saml verifies the signature and checks Audience and the validity window,
// but it never looks at Destination or SubjectConfirmationData/@Recipient --
// it only *sets* Destination on outbound requests. Without this, an assertion
// the IdP minted for a different endpoint is accepted here. Audience already
// binds the assertion to this SP, so this is defence in depth rather than the
// last line, but "addressed somewhere else" should not be a login.
//
// Safe to read with a regex only because it runs *after* the signature has been
// verified over these exact bytes: the attacker cannot alter Destination without
// invalidating the signature. Both attributes are optional in SAML, so absence
// is not a failure -- only a present-and-wrong value is.
function assertAddressedToUs(decodedXml, callbackUrl) {
    const checks = [
        { label: 'Destination', re: /<[^>]*:?Response[^>]*\sDestination="([^"]*)"/ },
        { label: 'Recipient', re: /<[^>]*:?SubjectConfirmationData[^>]*\sRecipient="([^"]*)"/ },
    ];
    for (const { label, re } of checks) {
        const match = decodedXml.match(re);
        if (match && match[1] && match[1] !== callbackUrl) {
            throw new Error(`${label} "${match[1]}" does not match this endpoint "${callbackUrl}"`);
        }
    }
}

// SAML attribute names vary by IdP mapper configuration; accept the plain names
// Keycloak emits by default plus the standard URN forms.
function pickAttribute(profile, names) {
    const bags = [profile, profile.attributes || {}];
    for (const bag of bags) {
        for (const name of names) {
            const value = bag[name];
            if (value === undefined || value === null || value === '') continue;
            return String(Array.isArray(value) ? value[0] : value).trim();
        }
    }
    return null;
}

function profileFromAssertion(samlProfile) {
    const email =
        pickAttribute(samlProfile, ['email', 'Email', 'urn:oid:0.9.2342.19200300.100.1.3',
            'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress']) ||
        (typeof samlProfile.nameID === 'string' && samlProfile.nameID.includes('@')
            ? samlProfile.nameID.trim()
            : null);
    const firstName = pickAttribute(samlProfile, ['firstName', 'givenName', 'urn:oid:2.5.4.42',
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname']);
    const lastName = pickAttribute(samlProfile, ['lastName', 'surname', 'sn', 'urn:oid:2.5.4.4',
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname']);
    return { email, firstName, lastName };
}

async function startServer() {
    console.log(`SSO SAML Sidecar started: tenantId=${tenantId}, kernelDomain=${kernelDomain}, issuer=${issuer}, acsPath=${acsPath}`);

    try {
        await loadIdpCertificates();
    } catch (err) {
        // Not fatal at boot -- Keycloak may still be starting. ACS requests
        // fail closed with 503 until a certificate is available.
        console.error(`Could not load IdP certificates at startup (will retry on first login): ${err.message}`);
    }

    const server = http.createServer(async (req, res) => {
        const parsedUrl = url.parse(req.url, true);

        if (parsedUrl.pathname === '/sso/login') {
            const host = resolveHost(req);
            const samlRedirect = generateAuthnRequest(host, tenantId, kernelDomain);
            const redirectUrl = `${entryPoint}?SAMLRequest=${samlRedirect}`;

            res.writeHead(302, { 'Location': redirectUrl });
            res.end();

        } else if ((parsedUrl.pathname === acsPath || parsedUrl.pathname === '/sso/acs') && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const postParams = querystring.parse(body);
                    const samlResponse = postParams.SAMLResponse;
                    if (!samlResponse) {
                        res.writeHead(400, { 'Content-Type': 'text/plain' });
                        res.end('Missing SAMLResponse');
                        return;
                    }

                    try {
                        await ensureIdpCertificates();
                    } catch (err) {
                        console.error('IdP certificate unavailable, refusing login:', err.message);
                        res.writeHead(503, { 'Content-Type': 'text/plain' });
                        res.end('SSO temporarily unavailable: identity provider certificate could not be loaded');
                        return;
                    }

                    const host = resolveHost(req);

                    // Verifies the XML signature against the IdP's certificate and
                    // checks Destination, Audience and the NotBefore/NotOnOrAfter
                    // window. Anything unsigned, altered, misdirected or expired
                    // throws here and never reaches the app handler.
                    let samlProfile;
                    try {
                        const result = await validatorFor(host).validatePostResponseAsync({ SAMLResponse: samlResponse });
                        samlProfile = result.profile;
                        // Only meaningful once the signature above has passed.
                        assertAddressedToUs(
                            Buffer.from(samlResponse, 'base64').toString('utf8'),
                            `https://${host}${acsPath}`,
                        );
                    } catch (err) {
                        console.error(`Rejected SAML assertion from ${req.socket.remoteAddress}: ${err.message}`);
                        res.writeHead(401, { 'Content-Type': 'text/plain' });
                        res.end('Invalid SAML assertion');
                        return;
                    }

                    const profile = profileFromAssertion(samlProfile || {});

                    if (!profile.email) {
                        res.writeHead(400, { 'Content-Type': 'text/plain' });
                        res.end('Email attribute not found in SAML assertion');
                        return;
                    }

                    if (appHandler && typeof appHandler.onLogin === 'function') {
                        // Delegate to app handler
                        await appHandler.onLogin(profile, req, res);
                    } else {
                        // Default fallback
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ message: "SAML login successful but no handler is configured.", profile }));
                    }
                } catch (err) {
                    console.error('ACS callback error:', err);
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Internal Server Error: ' + err.message);
                }
            });
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
    });

    server.listen(port, '0.0.0.0', () => {
        console.log(`SSO SAML Sidecar listening on 0.0.0.0:${port}`);
    });
}

startServer().catch(err => {
    console.error('SSO Sidecar startup failed:', err);
});
