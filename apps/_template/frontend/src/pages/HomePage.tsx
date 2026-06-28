import { useQuery } from "@tanstack/react-query";
import { apiFetch, type ItemsResponse, type MeResponse } from "@/api/client";

export function HomePage() {
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch<MeResponse>("/session/me"),
  });
  const { data: items } = useQuery({
    queryKey: ["items"],
    queryFn: () => apiFetch<ItemsResponse>("/items/"),
  });

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header>
        <p className="text-sm font-medium uppercase tracking-wide text-indigo-700">
          Gentian App
        </p>
        <h1 className="mt-2 text-3xl font-semibold">Your application</h1>
        <p className="mt-2 text-slate-600">
          FastAPI + React starter. Replace this page with your product UI.
        </p>
      </header>
      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="font-medium">Session</h2>
        <p className="mt-2 text-slate-600">
          {me ? `Signed in as ${me.username}` : "Loading session…"}
        </p>
        <p className="mt-1 text-xs text-slate-400">
          Bearer token attached on API calls when OIDC is configured (see src/auth/).
        </p>
      </section>
      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="font-medium">Sample API</h2>
        <p className="mt-2 text-slate-600">{items?.message ?? "Loading…"}</p>
      </section>
    </main>
  );
}
