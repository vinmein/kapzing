import { createHash } from "node:crypto";
import { ValidationError } from "@repo/core";

export interface SiteInput {
  name: string;
  domains?: { hostname: string; hostedZoneId?: string }[];
  domain?: string;
  hostedZoneId?: string;
  spa?: boolean;
}
export function siteName(orgId: string, name: string) {
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(name))
    throw new ValidationError(
      "Name must be 2–40 lowercase letters, digits or hyphens and start with a letter.",
    );
  return `openship-${createHash("sha256").update(orgId).digest("hex").slice(0, 16)}-${name}`;
}

export function siteTemplate(input: SiteInput) {
  if (input.domains !== undefined && (input.domain || input.hostedZoneId))
    throw new ValidationError("Use domains or the legacy domain fields, not both.");
  const domains = (
    input.domains ??
    (input.domain ? [{ hostname: input.domain, hostedZoneId: input.hostedZoneId }] : [])
  ).map((entry) => ({
    hostname: entry.hostname.trim().toLowerCase().replace(/\.$/, ""),
    hostedZoneId: entry.hostedZoneId?.trim() || undefined,
  }));
  if (domains.length > 10) throw new ValidationError("Add at most 10 custom domains per site.");
  if (input.hostedZoneId && !input.domain)
    throw new ValidationError("A domain and valid Route 53 hosted zone ID are required.");
  for (const entry of domains) {
    if (
      entry.hostname.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(entry.hostname)
    )
      throw new ValidationError("Enter a valid domain without a scheme, path or wildcard.");
    if (entry.hostedZoneId && !/^Z[A-Z0-9]+$/.test(entry.hostedZoneId))
      throw new ValidationError("Enter a valid Route 53 hosted zone ID.");
  }
  if (new Set(domains.map((entry) => entry.hostname)).size !== domains.length)
    throw new ValidationError("Each custom domain must be unique.");
  const automaticDns = domains.length > 0 && domains.every((entry) => entry.hostedZoneId);
  if (!automaticDns && domains.some((entry) => entry.hostedZoneId))
    throw new ValidationError(
      "Provide a Route 53 zone for every domain, or leave all zones empty and manage DNS manually.",
    );
  const domain = domains[0]?.hostname;
  const ref = (name: string) => ({ Ref: name });
  const attr = (name: string, key: string) => ({ "Fn::GetAtt": [name, key] });
  const resources: Record<string, unknown> = {
    Bucket: {
      Type: "AWS::S3::Bucket",
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
          ],
        },
        VersioningConfiguration: { Status: "Enabled" },
      },
    },
    OriginAccess: {
      Type: "AWS::CloudFront::OriginAccessControl",
      Properties: {
        OriginAccessControlConfig: {
          Name: { "Fn::Select": [2, { "Fn::Split": ["/", ref("AWS::StackId")] }] },
          OriginAccessControlOriginType: "s3",
          SigningBehavior: "always",
          SigningProtocol: "sigv4",
        },
      },
    },
    Distribution: {
      Type: "AWS::CloudFront::Distribution",
      Properties: {
        DistributionConfig: {
          Enabled: true,
          DefaultRootObject: "index.html",
          HttpVersion: "http2and3",
          IPV6Enabled: true,
          Origins: [
            {
              Id: "bucket",
              DomainName: attr("Bucket", "RegionalDomainName"),
              OriginAccessControlId: ref("OriginAccess"),
              S3OriginConfig: { OriginAccessIdentity: "" },
            },
          ],
          DefaultCacheBehavior: {
            TargetOriginId: "bucket",
            ViewerProtocolPolicy: "redirect-to-https",
            Compress: true,
            AllowedMethods: ["GET", "HEAD", "OPTIONS"],
            CachedMethods: ["GET", "HEAD"],
            CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
          },
          ...(input.spa
            ? {
                CustomErrorResponses: [403, 404].map((ErrorCode) => ({
                  ErrorCode,
                  ResponseCode: 200,
                  ResponsePagePath: "/index.html",
                  ErrorCachingMinTTL: 0,
                })),
              }
            : {}),
          ...(domain
            ? {
                Aliases: domains.map((entry) => entry.hostname),
                ViewerCertificate: {
                  AcmCertificateArn: ref("Certificate"),
                  SslSupportMethod: "sni-only",
                  MinimumProtocolVersion: "TLSv1.2_2021",
                },
              }
            : { ViewerCertificate: { CloudFrontDefaultCertificate: true } }),
        },
      },
    },
    BucketPolicy: {
      Type: "AWS::S3::BucketPolicy",
      Properties: {
        Bucket: ref("Bucket"),
        PolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "cloudfront.amazonaws.com" },
              Action: "s3:GetObject",
              Resource: { "Fn::Sub": "${Bucket.Arn}/*" },
              Condition: {
                StringEquals: {
                  "AWS:SourceArn": {
                    "Fn::Sub":
                      "arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${Distribution}",
                  },
                },
              },
            },
          ],
        },
      },
    },
  };
  if (domain)
    resources.Certificate = {
      Type: "AWS::CertificateManager::Certificate",
      Properties: {
        DomainName: domain,
        ValidationMethod: "DNS",
        ...(domains.length > 1
          ? { SubjectAlternativeNames: domains.slice(1).map((entry) => entry.hostname) }
          : {}),
        ...(automaticDns
          ? {
              DomainValidationOptions: domains.map((entry) => ({
                DomainName: entry.hostname,
                HostedZoneId: entry.hostedZoneId,
              })),
            }
          : {}),
      },
    };
  for (const entry of domains.filter((entry) => entry.hostedZoneId)) {
    // Preserve the original primary record ID when upgrading single-domain sites.
    const logicalId =
      entry.hostname === domain
        ? "Dns"
        : `Dns${createHash("sha256").update(entry.hostname).digest("hex").slice(0, 16)}`;
    resources[logicalId] = {
      Type: "AWS::Route53::RecordSetGroup",
      Properties: {
        HostedZoneId: entry.hostedZoneId,
        RecordSets: ["A", "AAAA"].map((Type) => ({
          Name: entry.hostname,
          Type,
          AliasTarget: {
            DNSName: attr("Distribution", "DomainName"),
            HostedZoneId: "Z2FDTNDATAQYW2",
            EvaluateTargetHealth: false,
          },
        })),
      },
    };
  }
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "Openship private S3 and CloudFront site",
    Metadata: { OpenshipSite: { name: input.name, spa: input.spa, domains } },
    Resources: resources,
    Outputs: {
      BucketName: { Value: ref("Bucket") },
      DistributionId: { Value: ref("Distribution") },
      CloudFrontDomain: { Value: attr("Distribution", "DomainName") },
      Url: {
        Value: domain ? `https://${domain}` : { "Fn::Sub": "https://${Distribution.DomainName}" },
      },
    },
  };
}
