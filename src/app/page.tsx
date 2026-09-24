import { redirect } from "next/navigation";
import { getSession } from "@/server/auth/service";

export default async function HomePage() {
  const session = await getSession();
  redirect(session ? "/devices" : "/login");
}