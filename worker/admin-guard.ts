// Wrappers applied to every admin route module.
import { csrfError, requireReason } from "./admin-lib";
import { HttpError } from "./http";
import type { AdminCtx, Route } from "./router";

/** Rejects state-changing requests that lack the admin CSRF header or come cross-site. */
export function withCsrf(routes: Route<AdminCtx>[]): Route<AdminCtx>[] {
  return routes.map((r) => ({
    ...r,
    handler: async (ctx) => {
      const err = csrfError(ctx.req.method, ctx.req.headers, ctx.url.origin);
      if (err) throw new HttpError(403, err);
      return r.handler(ctx);
    },
  }));
}

export function reasonOrThrow(reason: unknown): string {
  try {
    return requireReason(reason);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

/** Fail-soft: names of tables that currently exist (other workstreams add some). */
export async function existingTables(db: D1Database): Promise<Set<string>> {
  try {
    const { results } = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
      .all<{ name: string }>();
    return new Set(results.map((r) => r.name));
  } catch {
    return new Set();
  }
}
