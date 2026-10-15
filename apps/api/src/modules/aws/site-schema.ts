import { Type } from "@sinclair/typebox";

// Empty optional zone fields select manual DNS; siteTemplate normalizes them.
export const siteBody = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z][a-z0-9-]{1,39}$" }),
    domains: Type.Optional(
      Type.Array(
        Type.Object(
          {
            hostname: Type.String({ minLength: 1, maxLength: 253 }),
            hostedZoneId: Type.Optional(Type.String({ pattern: "^(?:Z[A-Z0-9]+)?$" })),
          },
          { additionalProperties: false },
        ),
        { maxItems: 10 },
      ),
    ),
    domain: Type.Optional(Type.String({ maxLength: 253 })),
    hostedZoneId: Type.Optional(Type.String({ pattern: "^(?:Z[A-Z0-9]+)?$" })),
    spa: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
