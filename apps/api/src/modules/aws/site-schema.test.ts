import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { siteBody } from "./site-schema";
import { siteTemplate } from "./site-template";

describe("AWS site optional DNS zone", () => {
  it.each([undefined, ""])("accepts manual DNS with zone %s", (hostedZoneId) => {
    const input = { name: "docs", domains: [{ hostname: "docs.example.com", hostedZoneId }] };
    expect(Value.Check(siteBody, JSON.parse(JSON.stringify(input)))).toBe(true);
    const template = siteTemplate(input) as any;
    expect(template.Resources.Certificate.Properties.DomainValidationOptions).toBeUndefined();
    expect(template.Resources.Dns).toBeUndefined();
  });
  it("accepts a Route 53 zone ID and rejects domain names in the zone field", () => {
    expect(
      Value.Check(siteBody, {
        name: "docs",
        domains: [{ hostname: "example.com", hostedZoneId: "Z123ABC" }],
      }),
    ).toBe(true);
    expect(
      Value.Check(siteBody, {
        name: "docs",
        domains: [{ hostname: "example.com", hostedZoneId: "example.com" }],
      }),
    ).toBe(false);
  });
});
