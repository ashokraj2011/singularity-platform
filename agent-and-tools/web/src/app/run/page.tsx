import { redirect } from "next/navigation";

export default function LegacyRunPage() {
  redirect("/workflows/run");
}
