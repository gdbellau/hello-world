import { requireAdmin } from "./auth";
import type { Env } from "./env";
import { HttpError, json } from "./http";
import { match, type AdminCtx, type Ctx, type Route } from "./router";
import { accountRoutes } from "./routes/accounts";
import { adminRoutes } from "./routes/admin";
import { adminPlayerRoutes } from "./routes/admin-players";
import { corpRoutes } from "./routes/corp";
import { missionRoutes } from "./routes/missions";
import { publicRoutes } from "./routes/public";
import { storeRoutes } from "./routes/store";

export type { Env } from "./env";

const API_ROUTES: Route[] = [...publicRoutes, ...missionRoutes, ...storeRoutes, ...corpRoutes, ...accountRoutes];
const ADMIN_ROUTES: Route<AdminCtx>[] = [...adminRoutes, ...adminPlayerRoutes];

async function handleAdmin(ctx: Ctx): Promise<Response> {
  const admin = await requireAdmin(ctx.req, ctx.env, ctx.url);
  if (!ctx.url.pathname.startsWith("/admin/api/")) {
    // Serve the admin SPA shell only to verified admins.
    const res = await ctx.env.ASSETS.fetch(new Request(new URL("/admin/", ctx.url), ctx.req));
    return new Response(res.body, {
      status: res.status,
      headers: { ...Object.fromEntries(res.headers), "Cache-Control": "no-store" },
    });
  }
  const m = match(ADMIN_ROUTES, ctx.req.method, ctx.url.pathname);
  if (!m) throw new HttpError(404, "Not found");
  return m.route.handler({ ...ctx, params: m.params, admin });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const ctx: Ctx = { req, env, url, params: {} };
    try {
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return await handleAdmin(ctx);
      if (url.pathname.startsWith("/api/")) {
        const m = match(API_ROUTES, req.method, url.pathname);
        if (!m) throw new HttpError(404, "Not found");
        return await m.route.handler({ ...ctx, params: m.params });
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, { status: e.status });
      console.error(e);
      return json({ error: "Internal error" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
