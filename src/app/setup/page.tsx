import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/auth/admin";
import { SetupChecklist } from "@/components/setup-checklist";
export const dynamic="force-dynamic";
export default async function Setup(){if(!await getAdminSession())redirect("/");return <SetupChecklist/>}
