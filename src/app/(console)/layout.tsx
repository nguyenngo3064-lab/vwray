import { publicEnv } from "@/server/config/env";
import { ConsoleShell } from "@/components/console/console-shell";

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const { appUrl } = publicEnv();
  return <ConsoleShell publicUrl={appUrl}>{children}</ConsoleShell>;
}