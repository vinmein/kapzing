import { Hono } from "hono";
import { siteBody } from "./site-schema";
import { secureRouter } from "../../lib/secure-router";
import { param } from "../../lib/controller-helpers";
import { getRequestContext } from "../../lib/request-context";
import { requireRole } from "../../middleware";
import { audit, auditContextFrom } from "../../lib/audit";
import * as service from "./aws.service";
import type { SiteInput } from "./site-template";

const r = secureRouter(new Hono(), { module: "aws", basePath: "/api/aws" });

r.get("/:account/sites", { tag: "settings:read" }, requireRole("admin"), async (c) => {
  return c.json({
    data: await service.awsOperation(() =>
      service.listSites(getRequestContext(c).organizationId, param(c, "account")),
    ),
  });
});
r.get("/:account/sites/:name", { tag: "settings:read" }, requireRole("admin"), async (c) => {
  return c.json({
    data: await service.awsOperation(() =>
      service.getSite(getRequestContext(c).organizationId, param(c, "account"), param(c, "name")),
    ),
  });
});
for (const method of ["post", "put"] as const) {
  r[method](
    "/:account/sites",
    { tag: "settings:admin", body: siteBody },
    requireRole("admin"),
    async (c) => {
      const ctx = getRequestContext(c);
      const input = await c.req.json<SiteInput>();
      const result = await service.awsOperation(() =>
        service.saveSite(ctx.organizationId, param(c, "account"), input, method === "put"),
      );
      audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
        eventType: `aws.site.${method === "put" ? "updated" : "created"}`,
        resourceType: "settings",
        resourceId: input.name,
        after: { account: param(c, "account"), ...input },
      });
      return c.json({ data: result }, 202);
    },
  );
}
r.post(
  "/:account/sites/:name/invalidate",
  { tag: "settings:admin" },
  requireRole("admin"),
  async (c) => {
    const ctx = getRequestContext(c);
    const data = await service.awsOperation(() =>
      service.invalidateSite(ctx.organizationId, param(c, "account"), param(c, "name")),
    );
    audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
      eventType: "aws.site.invalidated",
      resourceType: "settings",
      resourceId: param(c, "name"),
    });
    return c.json({ data }, 202);
  },
);
r.delete("/:account/sites/:name", { tag: "settings:admin" }, requireRole("admin"), async (c) => {
  const ctx = getRequestContext(c);
  const data = await service.awsOperation(() =>
    service.deleteSite(ctx.organizationId, param(c, "account"), param(c, "name")),
  );
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "aws.site.deleted",
    resourceType: "settings",
    resourceId: param(c, "name"),
  });
  return c.json({ data }, 202);
});
export const awsRoutes = r.hono;
