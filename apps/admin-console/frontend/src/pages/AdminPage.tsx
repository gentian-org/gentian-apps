import { AdminConsole } from "@/admin/AdminConsole";

/**
 * The whole page is the console. It used to be a window inside the desktop's
 * own bundle; now the desktop opens this component in a frame from its tile,
 * so what was "embedded" is the only way it is ever shown.
 */
export function AdminPage() {
  return <AdminConsole embedded />;
}
