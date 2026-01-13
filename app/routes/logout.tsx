import { redirect } from "react-router";
import { auth } from "~/lib/auth-server";
import type { Route } from "./+types/logout";

export async function loader({ request }: Route.LoaderArgs) {
  await auth.api.signOut({
    headers: request.headers,
  });

  return redirect("/login");
}
