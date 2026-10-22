import type { AccessIdentity } from "./access";
import type { Env } from "./env";

export interface Ctx {
  req: Request;
  env: Env;
  url: URL;
  /** Named capture groups from the route pattern. */
  params: Record<string, string>;
}

export interface AdminCtx extends Ctx {
  admin: AccessIdentity;
}

export interface Route<C extends Ctx = Ctx> {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Exact path, or a RegExp with named groups, e.g. /^\/api\/x\/(?<id>[a-z0-9-]+)$/ */
  path: string | RegExp;
  handler: (ctx: C) => Promise<Response>;
}

export function match<C extends Ctx>(routes: Route<C>[], method: string, pathname: string) {
  for (const r of routes) {
    if (r.method !== method) continue;
    if (typeof r.path === "string") {
      if (r.path === pathname) return { route: r, params: {} };
    } else {
      const m = pathname.match(r.path);
      if (m) return { route: r, params: { ...m.groups } };
    }
  }
  return null;
}
