import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/auth/admin";
import { LoginPage } from "@/components/login-page";
import { DashboardShell } from "@/components/dashboard-shell";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getAdminSession();
  if (!session) return <LoginPage />;
  return <DashboardShell />;
}
