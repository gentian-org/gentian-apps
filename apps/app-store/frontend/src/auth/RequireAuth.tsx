import { useAuth } from "@/auth/AuthProvider";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, authDisabled, login } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-600">
        Checking session…
      </div>
    );
  }

  if (!isAuthenticated && !authDisabled) {
    login();
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-600">
        Redirecting to sign in…
      </div>
    );
  }

  return <>{children}</>;
}
