import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  fetchIdentitySettings,
  fetchPeople,
  fetchPerson,
  fetchPersonGroups,
  invitePerson,
  setMembership,
  setPasswordPolicy,
  type Person,
} from "@/api/admin";
import "./admin.css";

type IdentitySectionProps = {
  /** The realm this tenant's people live in. */
  realm: string;
  /** The cluster's domain, which the identity host is a subdomain of. */
  kernelDomain: string;
};

/**
 * People, managed here, through the director.
 *
 * This screen was a link to Keycloak's own console. The reasoning for that was
 * that a console holding an administrator credential is a large thing to get
 * wrong, and it was right — but the conclusion drawn from it was not. Handing
 * managed service providers and tenant administrators a console built for realm
 * engineers, as the surface they spend the most hours in, is a worse trade than
 * moving the credential.
 *
 * So the credential moved instead. The director holds one per realm and this
 * console holds none; every call below carries the caller's own token, and the
 * director asks OpenFGA about it before it touches anything. Keycloak's own
 * console stays reachable at the bottom, as the detail view behind the product
 * view rather than the way in.
 *
 * Every write here is an action, not a commit. Inviting somebody happens once
 * and declares no state — people are not in git precisely because git is
 * append-only, and a name and an address committed there outlive the account.
 */
export function IdentitySection({ realm, kernelDomain }: IdentitySectionProps) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteGroups, setInviteGroups] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [policyDraft, setPolicyDraft] = useState<string | null>(null);

  const peopleQuery = useQuery({
    queryKey: ["admin", "people", search],
    queryFn: () => fetchPeople({ search: search || undefined }),
  });
  const groupsQuery = useQuery({
    queryKey: ["admin", "people", "groups"],
    queryFn: () => fetchPersonGroups(),
  });
  // A tenant administrator holds can_manage_users; the password policy is
  // can_set_policy. They usually travel together and do not have to, so this
  // query failing leaves the rest of the screen working.
  const settingsQuery = useQuery({
    queryKey: ["admin", "people", "identity"],
    queryFn: () => fetchIdentitySettings(),
    retry: false,
  });

  const refreshPeople = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "people"] });
  };

  const inviteMutation = useMutation({
    mutationFn: () => invitePerson({ email: inviteEmail.trim(), groups: inviteGroups }),
    onSuccess: (result) => {
      if (result.mailed) {
        setInviteEmail("");
        setInviteGroups([]);
      }
      refreshPeople();
    },
  });

  const membershipMutation = useMutation({
    mutationFn: (v: { person: string; group: string; member: boolean }) => setMembership(v),
    // Both the list and the opened row: the row is what the person just
    // changed, and leaving it stale shows the checkbox snapping back.
    onSuccess: refreshPeople,
  });

  const policyMutation = useMutation({
    mutationFn: (policy: string) => setPasswordPolicy(policy),
    onSuccess: () => {
      setPolicyDraft(null);
      void queryClient.invalidateQueries({ queryKey: ["admin", "people", "identity"] });
    },
  });

  const keycloakConsole = `https://id.${kernelDomain}/auth/admin/${realm}/console/`;
  const groups = groupsQuery.data?.groups ?? [];

  if (peopleQuery.isLoading) {
    return <p className="admin-console__loading">Loading people…</p>;
  }
  // 503 here is the platform's problem, not the caller's: the director holds
  // one credential per realm and the operator writes it. Saying "unavailable"
  // where the real answer is "not provisioned yet" sends somebody to the wrong
  // person, so the director's own message is shown.
  if (peopleQuery.isError) {
    return (
      <section>
        <p className="admin-console__error">
          People cannot be read right now. {String(peopleQuery.error)}
        </p>
        <p className="admin-console__hint">
          The director holds one Keycloak credential per realm, written by the operator. Until
          this realm has one, nothing here can read or change anybody.
        </p>
      </section>
    );
  }

  const people = peopleQuery.data?.people ?? [];
  const pending = people.filter((p) => p.pending).length;

  return (
    <section>
      <header className="admin-console__section-head">
        <div>
          <h2 className="admin-console__section-title">People</h2>
          <p className="admin-console__lead">
            Who is in this tenant, what they belong to, and how passwords are required to look.
            Changes take effect immediately.
          </p>
        </div>
        <div className="admin-console__field">
          <label htmlFor="people-search">Search</label>
          <input
            id="people-search"
            type="search"
            placeholder="Name or address"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </header>

      <div className="admin-console__card">
        <div className="admin-console__card-main">
          <h3 className="admin-console__card-title">Invite someone</h3>
          <p className="admin-console__card-desc">
            They are created without a password and sent a link that lets them set one and prove
            the address reaches them. The platform never holds a password, so there is nothing to
            transport.
          </p>
          <div className="admin-console__field-row">
            <div className="admin-console__field">
              <label htmlFor="invite-email">Address</label>
              <input
                id="invite-email"
                type="email"
                placeholder="name@example.org"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
            </div>
            <div className="admin-console__field">
              <label htmlFor="invite-groups">Groups</label>
              <select
                id="invite-groups"
                multiple
                value={inviteGroups}
                onChange={(e) =>
                  setInviteGroups(Array.from(e.target.selectedOptions).map((o) => o.value))
                }
              >
                {groups.map((g) => (
                  <option key={g.path} value={g.path}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {inviteMutation.isError && (
            <p className="admin-console__error">{String(inviteMutation.error)}</p>
          )}
          {inviteMutation.data && !inviteMutation.data.mailed && (
            // The half-done case, said as what it is. Inviting again would
            // answer "already here"; the repair is to re-send.
            <p className="admin-console__error">
              {inviteMutation.data.person.email} was created and the invitation did not go.
              Re-sending is the repair, not inviting again. {inviteMutation.data.warning}
            </p>
          )}
          {inviteMutation.data?.mailed && (
            <p className="admin-console__hint">
              Invitation sent to {inviteMutation.data.person.email}. They stay pending until they
              set a password.
            </p>
          )}
        </div>
        <div className="admin-console__card-aside admin-console__card-aside--top">
          <button
            className="admin-console__btn admin-console__btn--primary"
            type="button"
            disabled={!inviteEmail.includes("@") || inviteMutation.isPending}
            onClick={() => inviteMutation.mutate()}
          >
            {inviteMutation.isPending ? "Inviting…" : "Invite"}
          </button>
        </div>
      </div>

      <div className="admin-console__card">
        <div className="admin-console__card-main">
          <h3 className="admin-console__card-title">
            {people.length} {people.length === 1 ? "person" : "people"}
            {pending > 0 && <span className="admin-console__badge">{pending} pending</span>}
          </h3>
          <table className="admin-console__table">
            <thead>
              <tr>
                <th>Address</th>
                <th>Name</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {people.map((person) => (
                <PersonRow
                  key={person.id}
                  person={person}
                  groups={groups.map((g) => g.path)}
                  expanded={expanded === person.id}
                  onToggle={() => setExpanded(expanded === person.id ? null : person.id)}
                  onMembership={(group, member) =>
                    membershipMutation.mutate({ person: person.id, group, member })
                  }
                />
              ))}
              {people.length === 0 && (
                <tr>
                  <td colSpan={4} className="admin-console__empty">
                    {search ? "Nobody matches that." : "Nobody here yet."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {settingsQuery.data && (
        <div className="admin-console__card">
          <div className="admin-console__card-main">
            <h3 className="admin-console__card-title">Password policy</h3>
            <p className="admin-console__card-desc">
              In the realm's own spelling, such as{" "}
              <span className="admin-console__mono">length(12) and notUsername(undefined)</span>.
              It is passed through unchanged: this platform does not interpret it, and a second
              interpretation would be a second answer to the same question.
            </p>
            <div className="admin-console__field">
              <label htmlFor="password-policy">Policy</label>
              <input
                id="password-policy"
                type="text"
                value={policyDraft ?? settingsQuery.data.passwordPolicy}
                onChange={(e) => setPolicyDraft(e.target.value)}
              />
            </div>
            {policyMutation.isError && (
              <p className="admin-console__error">{String(policyMutation.error)}</p>
            )}
          </div>
          <div className="admin-console__card-aside admin-console__card-aside--top">
            <button
              className="admin-console__btn"
              type="button"
              disabled={policyDraft === null || policyMutation.isPending}
              onClick={() => policyDraft !== null && policyMutation.mutate(policyDraft)}
            >
              {policyMutation.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}

      <div className="admin-console__card">
        <div className="admin-console__card-main">
          <h3 className="admin-console__card-title">Identity console</h3>
          <p className="admin-console__card-desc">
            Everything this screen does not: identity providers, authentication flows, sessions
            and the realm's full settings. The detail view behind this one, with the session you
            already hold.
          </p>
          <p className="admin-console__card-meta">
            realm <span className="admin-console__mono">{realm}</span>
          </p>
        </div>
        <div className="admin-console__card-aside admin-console__card-aside--top">
          <a
            className="admin-console__btn"
            href={keycloakConsole}
            target="_blank"
            rel="noreferrer"
          >
            Open
          </a>
        </div>
      </div>

      <p className="admin-console__hint">
        This console holds no credential for the realm. Every change above is made by the
        director, with your token, after it has asked whether you may — and a change made in the
        identity console instead is recorded by the realm without that half.
      </p>
    </section>
  );
}

function PersonRow({
  person,
  groups,
  expanded,
  onToggle,
  onMembership,
}: {
  person: Person;
  groups: string[];
  expanded: boolean;
  onToggle: () => void;
  onMembership: (group: string, member: boolean) => void;
}) {
  // The list does not carry anybody's groups, and deliberately: reading them
  // is a call per person, so a tenant with two hundred people would make two
  // hundred and one. They are read when a row is opened.
  const detail = useQuery({
    queryKey: ["admin", "people", "detail", person.id],
    queryFn: () => fetchPerson(person.id),
    enabled: expanded,
  });
  const held = new Set(detail.data?.groups ?? person.groups ?? []);
  return (
    <>
      <tr>
        <td className="admin-console__mono">{person.email || person.username}</td>
        <td>{person.name || "—"}</td>
        <td>
          {!person.enabled ? (
            <span className="admin-console__badge">disabled</span>
          ) : person.pending ? (
            <span className="admin-console__badge">pending</span>
          ) : (
            "active"
          )}
        </td>
        <td>
          <button className="admin-console__btn admin-console__btn--quiet" type="button" onClick={onToggle}>
            {expanded ? "Close" : "Groups"}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={4}>
            <div className="admin-console__checkbox-grid">
              {detail.isLoading && <p className="admin-console__hint">Reading their groups…</p>}
              {!detail.isLoading &&
                groups.map((group) => (
                  <label key={group} className="admin-console__checkbox">
                    <input
                      type="checkbox"
                      checked={held.has(group)}
                      onChange={(e) => onMembership(group, e.target.checked)}
                    />
                    <span className="admin-console__mono">{group}</span>
                  </label>
                ))}
              {groups.length === 0 && (
                <p className="admin-console__hint">This tenant has no groups to put anybody in.</p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
