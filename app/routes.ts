import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("/agent", "routes/agent.tsx"),
  route("/api/auth/*", "routes/api.auth.$.ts"),
  route("/login", "routes/login.tsx"),
  route("/signup", "routes/signup.tsx"),
  route("/logout", "routes/logout.tsx"),
  route("/up", "routes/up.tsx"),
  route(
    "/.well-known/appspecific/com.chrome.devtools.json",
    "routes/chrome-devtools.tsx",
  ),
] satisfies RouteConfig;
