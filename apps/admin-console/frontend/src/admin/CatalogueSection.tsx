import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  fetchCatalogueEntries,
  fetchCatalogueSources,
  type CatalogueEntry,
} from "@/api/catalogue";
import "./admin.css";
import { useTranslation } from "react-i18next";

/**
 * The cluster's own catalogues — the fallback, and it is meant to look like
 * one.
 *
 * The App Store is the route to an app. It knows what an app is for, what it
 * costs, who maintains it and what it looks like, and people whose job that is
 * keep it current. This screen exists for the cases the store cannot answer:
 * it is unreachable, the cluster is air-gapped, or the entry is this
 * operator's own profile in their own repository, which nobody sells and
 * nobody else lists.
 *
 * So it is a table of coordinates. No cards, no icons, no descriptions, no
 * search, no categories, no screenshots. That is not an unfinished screen — a
 * second, worse shop would pull people away from the one that is maintained,
 * and every field it could add here is a field that would go stale. What it
 * shows is what a cluster can actually vouch for on its own: what is in its
 * catalogues, at which version, in which edition, and whether this tenant may
 * install it without asking anybody.
 *
 * Only ce (community) and pe (private) entries appear, because they are the
 * ones whose value does not depend on a supplier. me (maintained) and ee
 * (enterprise) are counted and named to the store.
 */
export function CatalogueSection({ tenant }: { tenant: string }) {
  const { t } = useTranslation();

  const sourcesQuery = useQuery({
    queryKey: ["catalogue", "sources", tenant],
    queryFn: () => fetchCatalogueSources(tenant),
  });
  const [selected, setSelected] = useState<string | null>(null);

  const sources = sourcesQuery.data?.catalogues ?? [];
  const storeUrl = sourcesQuery.data?.storeUrl ?? "";

  // The first catalogue, until somebody picks another. Not a stored default:
  // a cluster with one source should not need a click to see it.
  useEffect(() => {
    if (!selected && sources.length > 0) {
      setSelected(sources[0].name);
    }
  }, [selected, sources]);

  const entriesQuery = useQuery({
    queryKey: ["catalogue", "entries", tenant, selected],
    queryFn: () => fetchCatalogueEntries(selected as string, tenant),
    enabled: Boolean(selected),
  });

  if (sourcesQuery.isLoading) {
    return <p className="admin-console__loading">{t("catalogue.loadingCatalogues")}</p>;
  }
  if (sourcesQuery.isError) {
    return <p className="admin-console__error">{t("catalogue.cataloguesAreUnavailable")}</p>;
  }

  return (
    <section>
      <header className="admin-console__section-head">
        <div>
          <h2 className="admin-console__section-title">{t("catalogue.catalogues")}</h2>
          <p className="admin-console__lead">
            {storeUrl ? (
              <>
                Apps come from the{" "}
                <a href={storeUrl} target="_blank" rel="noreferrer">
                  {t("catalogue.appStore")}</a>
                . This page is the plain fallback: what is in this cluster&rsquo;s own
                catalogue sources, for when the store is not the answer.
              </>
            ) : (
              <>
                This cluster belongs to no App Store, so its own catalogue sources are all
                there is.
              </>
            )}
          </p>
        </div>
      </header>

      {sources.length === 0 ? (
        <p className="admin-console__lead">
          {t("catalogue.thisClusterNamesNoCatalogue")}<code>spec.catalogue.sources</code>.
        </p>
      ) : (
        <>
          <p className="admin-console__lead">
            {sources.map((source) => (
              <button
                key={source.name}
                type="button"
                className={`admin-console__tab${
                  selected === source.name ? " admin-console__tab--active" : ""
                }`}
                onClick={() => setSelected(source.name)}
              >
                {source.name}
                {source.open ? " (open)" : ""}
              </button>
            ))}
          </p>
          <CatalogueTable
            storeUrl={storeUrl}
            loading={entriesQuery.isLoading}
            error={entriesQuery.isError}
            entries={entriesQuery.data?.entries ?? []}
            storeOnly={entriesQuery.data?.storeOnly ?? 0}
          />
        </>
      )}
    </section>
  );
}

function CatalogueTable({
  entries,
  storeOnly,
  storeUrl,
  loading,
  error,
}: {
  entries: CatalogueEntry[];
  storeOnly: number;
  storeUrl: string;
  loading: boolean;
  error: boolean;
}) {
  const { t } = useTranslation();

  if (loading) {
    return <p className="admin-console__loading">{t("catalogue.loadingEntries")}</p>;
  }
  if (error) {
    // The source is somebody else's web server and it is allowed to be down.
    return (
      <p className="admin-console__error">
        {t("catalogue.thisCatalogueSourceCouldNot")}</p>
    );
  }

  return (
    <>
      {entries.length === 0 ? (
        <p className="admin-console__empty">{t("catalogue.nothingThisClusterListsFor")}</p>
      ) : (
        <div className="admin-console__table-wrap">
          <table className="admin-console__table">
            <thead>
              <tr>
                <th>{t("catalogue.coordinate")}</th>
                <th>{t("catalogue.version")}</th>
                <th>{t("catalogue.edition")}</th>
                <th>{t("catalogue.trust")}</th>
                <th>{t("catalogue.install")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.coordinate}>
                  <td>
                    <code>{entry.coordinate}</code>
                  </td>
                  <td>{entry.version ?? "—"}</td>
                  <td>
                    <code>{entry.edition}</code>
                  </td>
                  <td>{entry.trustTier ?? "—"}</td>
                  <td>
                    {entry.installable ? (
                      // Installing is the tenant's own act, from their own
                      // screens. This page says what exists, not what to
                      // press: an install button here would be a third place
                      // that installs apps, after the store and the desktop.
                      <span>{t("catalogue.fromThisCluster")}</span>
                    ) : (
                      <span>{t("catalogue.viaTheAppStore")}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {storeOnly > 0 ? (
        <p className="admin-console__lead">
          {t("catalogue.storeOnly", { count: storeOnly })}{" "}
          {storeUrl ? (
            <a href={storeUrl} target="_blank" rel="noreferrer">
              {t("catalogue.seeThemInTheApp")}
            </a>
          ) : (
            t("catalogue.theyAreTheStoreS")
          )}
        </p>
      ) : null}
    </>
  );
}
