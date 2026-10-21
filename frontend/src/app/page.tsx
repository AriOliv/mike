import { redirect } from "next/navigation";
import { DEFAULT_HOME } from "@/app/lib/authRedirects";

export default function RootPage() {
    redirect(DEFAULT_HOME);
}
