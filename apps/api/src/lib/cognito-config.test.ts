import { describe, expect, it } from "vitest";
import { cognitoIssuer } from "./cognito-config";

describe("Cognito issuer derived from user pool ID", () => {
  it.each([
    ["us-east-1_EXAMPLE", "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE"],
    ["ap-south-1_Abc123", "https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_Abc123"],
    [
      "us-gov-west-1_Abc123",
      "https://cognito-idp.us-gov-west-1.amazonaws.com/us-gov-west-1_Abc123",
    ],
    ["cn-north-1_Abc123", "https://cognito-idp.cn-north-1.amazonaws.com.cn/cn-north-1_Abc123"],
  ])("derives %s", (pool, issuer) => {
    expect(cognitoIssuer(pool)).toBe(issuer);
  });
  it.each([
    "",
    "EXAMPLE",
    "us-east-1_",
    "https://example.com",
    "us-east-1_pool/path",
    "us-east-1_pool?query",
    "us-east-1_pool_other",
  ])("rejects invalid pool ID %s", (pool) => {
    expect(() => cognitoIssuer(pool)).toThrow("Invalid Cognito user pool ID");
  });
});
