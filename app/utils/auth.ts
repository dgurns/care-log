import { auth } from "~/lib/auth-server";
import { redirect } from "react-router";

export async function throwIfNotLoggedIn(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    throw redirect("/login");
  }
}