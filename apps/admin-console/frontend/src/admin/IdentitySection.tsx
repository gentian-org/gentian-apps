import "./admin.css";

type IdentitySectionProps = {
  /** The realm this tenant's people live in. */
  realm: string;
  /** The cluster's domain, which the identity host is a subdomain of. */
  kernelDomain: string;
};

/**
 * People are not managed here.
 *
 * Accounts, groups, invitations and sessions used to be four tabs of this
 * console, each one reaching Keycloak's Admin REST API through the desktop's
 * backend with an administrator credential the desktop held. That credential
 * was the problem: a console that can read and write every account in the
 * realm is a much larger thing to get wrong than a console that can only
 * describe what a tenant has.
 *
 * So they go to Keycloak's own console, which already does this properly, is
 * maintained, and since 26.2 can scope a tenant administrator to their own
 * users and groups without handing them the realm. Signing in is the session
 * this person already holds, so following the link costs nothing.
 *
 * Declaring people in git was the alternative and it is worse: git is
 * append-only, so a name and an address committed there outlive the account,
 * which collides with erasure.
 */
export function IdentitySection({ realm, kernelDomain }: IdentitySectionProps) {
  const console_ = `https://id.${kernelDomain}/auth/admin/${realm}/console/`;
  return (
    <section>
      <header className="admin-console__section-head">
        <div>
          <h2 className="admin-console__section-title">People</h2>
          <p className="admin-console__lead">
            Accounts, groups and who belongs to what are managed in the identity console, with
            the session you already hold.
          </p>
        </div>
      </header>

      <div className="admin-console__card">
        <div className="admin-console__card-main">
          <h3 className="admin-console__card-title">Identity console</h3>
          <p className="admin-console__card-desc">
            Invite someone, change what a group contains, or end a session. Changes take effect
            immediately; an account removed there loses access within the lifetime of its access
            token rather than at the end of its session.
          </p>
          <p className="admin-console__card-meta">
            realm <span className="admin-console__mono">{realm}</span>
          </p>
        </div>
        <div className="admin-console__card-aside admin-console__card-aside--top">
          <a
            className="admin-console__btn admin-console__btn--primary"
            href={console_}
            target="_blank"
            rel="noreferrer"
          >
            Open
          </a>
        </div>
      </div>

      <p className="admin-console__hint">
        This console does not hold an administrator credential for the realm, so there is nothing
        here that could manage people even if it wanted to. What you may do in the identity
        console is decided there, by the roles your groups carry.
      </p>
    </section>
  );
}
