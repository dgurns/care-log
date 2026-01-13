import { Form, redirect, useActionData } from "react-router";
import { auth } from "~/lib/auth-server";
import type { Route } from "./+types/signup";

export async function loader({ request }: Route.LoaderArgs) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (session) {
    return redirect("/");
  }
}

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const name = formData.get("name") as string;
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;

  // In production, restrict signup to explicitly allowed emails
  // until we get proper usage billing set up
  const allowedEmails = process.env.ALLOWED_EMAILS?.split(",") || [];
  if (process.env.NODE_ENV === "production" && !allowedEmails.includes(email)) {
    return {
      error:
        "Sorry, only certain emails are currently allowed to sign up right now.",
    };
  }

  try {
    await auth.api.signUpEmail({
      body: { name, email, password },
    });
    return redirect("/");
  } catch (e) {
    const error = e instanceof Error ? e.message : "Sign up failed";
    return { error };
  }
}

export default function SignUp() {
  const actionData = useActionData<typeof action>();

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-md space-y-8">
        <div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
            Sign Up
          </h2>
        </div>
        <Form method="post" className="mt-8 space-y-6">
          <div className="-space-y-px rounded-md shadow-sm">
            <div>
              <input
                required
                name="name"
                type="text"
                placeholder="Full Name"
                className="relative block w-full appearance-none rounded-none rounded-t-md border border-gray-300 px-3 py-2 text-gray-900 placeholder-gray-500 focus:z-10 focus:border-indigo-500 focus:ring-indigo-500 focus:outline-none sm:text-sm"
              />
            </div>
            <div>
              <input
                required
                name="email"
                type="email"
                placeholder="Email"
                className="relative block w-full appearance-none rounded-none border border-gray-300 px-3 py-2 text-gray-900 placeholder-gray-500 focus:z-10 focus:border-indigo-500 focus:ring-indigo-500 focus:outline-none sm:text-sm"
              />
            </div>
            <div>
              <input
                required
                name="password"
                type="password"
                placeholder="Password"
                className="relative block w-full appearance-none rounded-none rounded-b-md border border-gray-300 px-3 py-2 text-gray-900 placeholder-gray-500 focus:z-10 focus:border-indigo-500 focus:ring-indigo-500 focus:outline-none sm:text-sm"
              />
            </div>
          </div>

          {actionData?.error && (
            <div className="text-sm text-red-600">{actionData.error}</div>
          )}

          <div>
            <button
              type="submit"
              className="group relative flex w-full justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:outline-none"
            >
              Sign Up
            </button>
          </div>
        </Form>

        <div className="text-center">
          <p className="text-sm text-gray-600">
            Already have an account?{" "}
            <a
              href="/login"
              className="font-medium text-indigo-600 hover:text-indigo-500"
            >
              Log In
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
