import { describe, expect, it } from "vitest";
import { siteName, siteTemplate } from "./site-template";

describe("AWS site infrastructure", () => {
  it("isolates identical site names by organization and rejects arbitrary stack identifiers", () => {
    expect(siteName("org-a", "docs")).not.toBe(siteName("org-b", "docs"));
    expect(siteName("org-a", "docs")).toBe(siteName("org-a", "docs"));
    expect(() => siteName("org-a", "arn:aws:cloudformation:other")).toThrow();
  });
  it("keeps S3 private and retained, and grants only its own CloudFront distribution access", () => {
    const t = siteTemplate({ name: "docs" }) as any;
    const bucket = t.Resources.Bucket;
    expect(bucket.DeletionPolicy).toBe("Retain");
    expect(bucket.UpdateReplacePolicy).toBe("Retain");
    expect(Object.values(bucket.Properties.PublicAccessBlockConfiguration)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    const policy = t.Resources.BucketPolicy.Properties.PolicyDocument.Statement[0];
    expect(policy.Principal).toEqual({ Service: "cloudfront.amazonaws.com" });
    expect(policy.Condition.StringEquals["AWS:SourceArn"]["Fn::Sub"]).toContain("${Distribution}");
    expect(
      t.Resources.Distribution.Properties.DistributionConfig.Origins[0].S3OriginConfig,
    ).toEqual({ OriginAccessIdentity: "" });
    expect(t.Resources.Certificate).toBeUndefined();
  });
  it("automates validation and IPv4/IPv6 alias records only for an explicit Route 53 zone", () => {
    const t = siteTemplate({
      name: "docs",
      domain: "www.example.com",
      hostedZoneId: "Z123ABC",
    }) as any;
    expect(t.Resources.Certificate.Properties.DomainValidationOptions).toEqual([
      { DomainName: "www.example.com", HostedZoneId: "Z123ABC" },
    ]);
    expect(t.Resources.Dns.Properties.RecordSets.map((r: any) => r.Type)).toEqual(["A", "AAAA"]);
    expect(
      t.Resources.Distribution.Properties.DistributionConfig.ViewerCertificate.AcmCertificateArn,
    ).toEqual({ Ref: "Certificate" });
  });
  it("supports manual DNS without attempting to manage external records", () => {
    const t = siteTemplate({ name: "docs", domain: "example.com" }) as any;
    expect(t.Resources.Certificate.Properties.ValidationMethod).toBe("DNS");
    expect(t.Resources.Certificate.Properties.DomainValidationOptions).toBeUndefined();
    expect(t.Resources.Dns).toBeUndefined();
  });
  it("requires an explicit SPA choice before changing error responses", () => {
    expect(
      (siteTemplate({ name: "docs" }) as any).Resources.Distribution.Properties.DistributionConfig
        .CustomErrorResponses,
    ).toBeUndefined();
    expect(
      (siteTemplate({ name: "docs", spa: true }) as any).Resources.Distribution.Properties
        .DistributionConfig.CustomErrorResponses,
    ).toHaveLength(2);
  });
  it.each(["https://example.com", "*.example.com", "foo..com", "-foo.com", "foo.com/path"])(
    "rejects invalid custom domain %s",
    (domain) => {
      expect(() => siteTemplate({ name: "docs", domain })).toThrow();
    },
  );
  it("rejects a zone without a custom domain", () => {
    expect(() => siteTemplate({ name: "docs", hostedZoneId: "Z123" })).toThrow();
  });
  it("covers every alias with HTTPS and creates records in each specified zone", () => {
    const t = siteTemplate({
      name: "docs",
      domains: [
        { hostname: "Example.com.", hostedZoneId: "Z123" },
        { hostname: "www.example.net", hostedZoneId: "Z456" },
      ],
    }) as any;
    expect(t.Resources.Distribution.Properties.DistributionConfig.Aliases).toEqual([
      "example.com",
      "www.example.net",
    ]);
    expect(t.Resources.Certificate.Properties.SubjectAlternativeNames).toEqual(["www.example.net"]);
    expect(t.Resources.Certificate.Properties.DomainValidationOptions).toEqual([
      { DomainName: "example.com", HostedZoneId: "Z123" },
      { DomainName: "www.example.net", HostedZoneId: "Z456" },
    ]);
    const records = Object.values(t.Resources).filter(
      (r: any) => r.Type === "AWS::Route53::RecordSetGroup",
    ) as any[];
    expect(records.map((r) => r.Properties.HostedZoneId)).toEqual(["Z123", "Z456"]);
    expect(t.Resources.Bucket).toEqual((siteTemplate({ name: "docs" }) as any).Resources.Bucket);
  });
  it("supports multiple external domains and clearing domains", () => {
    const t = siteTemplate({
      name: "docs",
      domains: [{ hostname: "example.com" }, { hostname: "www.example.com" }],
    }) as any;
    expect(t.Resources.Certificate.Properties.DomainValidationOptions).toBeUndefined();
    expect(
      Object.values(t.Resources).some((r: any) => r.Type === "AWS::Route53::RecordSetGroup"),
    ).toBe(false);
    expect(
      (siteTemplate({ name: "docs", domains: [] }) as any).Resources.Certificate,
    ).toBeUndefined();
  });
  it("rejects duplicate domains, excessive domains, mixed DNS automation and ambiguous legacy input", () => {
    expect(() =>
      siteTemplate({
        name: "docs",
        domains: [{ hostname: "Example.com" }, { hostname: "example.com." }],
      }),
    ).toThrow(/unique/);
    expect(() =>
      siteTemplate({
        name: "docs",
        domains: Array.from({ length: 11 }, (_, i) => ({ hostname: `domain${i}.com` })),
      }),
    ).toThrow(/10/);
    expect(() =>
      siteTemplate({
        name: "docs",
        domains: [{ hostname: "example.com", hostedZoneId: "Z123" }, { hostname: "other.com" }],
      }),
    ).toThrow(/every domain/);
    expect(() => siteTemplate({ name: "docs", domain: "example.com", domains: [] })).toThrow(
      /legacy/,
    );
  });
});
