import { redirect } from "next/navigation";

// The old list surface is now the default Cases board — send everyone there.
export default function CasesListPage() {
  redirect("/cases");
}
