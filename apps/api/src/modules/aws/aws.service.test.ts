import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  acm: vi.fn(),
  cdn: vi.fn(),
  resolve: vi.fn(),
  account: vi.fn(),
}));
vi.mock("../credentials/credential.service", () => ({ resolveCredentialSecrets: mocks.resolve }));
vi.mock("./aws-client", () => ({
  AWS_REGION: "us-east-1",
  awsCredentials: async () => ({ accessKeyId: "key", secretAccessKey: "secret" }),
  awsAccountId: mocks.account,
}));
vi.mock("@aws-sdk/client-cloudformation", () => {
  class Command {
    constructor(public input: unknown) {}
  }
  return {
    CloudFormationClient: class {
      send = mocks.send;
      destroy() {}
    },
    CreateStackCommand: Command,
    UpdateStackCommand: Command,
    DeleteStackCommand: Command,
    DescribeStacksCommand: Command,
    ListStackResourcesCommand: Command,
    DescribeStackEventsCommand: Command,
    GetTemplateCommand: Command,
  };
});
vi.mock("@aws-sdk/client-acm", () => ({
  ACMClient: class {
    send = mocks.acm;
    destroy() {}
  },
  DescribeCertificateCommand: class {},
}));
vi.mock("@aws-sdk/client-cloudfront", () => ({
  CloudFrontClient: class {
    send = mocks.cdn;
    destroy() {}
  },
  CreateInvalidationCommand: class {},
}));
import {
  accountClient,
  deleteSite,
  invalidateSite,
  listSites,
  saveSite,
  awsOperation,
} from "./aws.service";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({ publicFields: {}, secrets: {} });
  mocks.account.mockResolvedValue("123456789012");
});
describe("AWS organization boundary", () => {
  it("looks up credentials exclusively within the requesting organization", async () => {
    await accountClient("org-a", "123456789012");
    expect(mocks.resolve).toHaveBeenCalledWith({
      organizationId: "org-a",
      provider: "aws",
      selector: "123456789012",
    });
  });
  it("rejects credentials whose actual account changed", async () => {
    mocks.account.mockResolvedValue("999999999999");
    await expect(accountClient("org-a", "123456789012")).rejects.toThrow();
  });
  it("filters foreign stacks across all pages", async () => {
    mocks.send
      .mockResolvedValueOnce({
        NextToken: "next",
        Stacks: [{ Tags: [{ Key: "OpenshipOrganization", Value: "org-b" }] }],
      })
      .mockResolvedValueOnce({
        Stacks: [
          {
            StackStatus: "CREATE_COMPLETE",
            Tags: [
              { Key: "ManagedBy", Value: "Openship" },
              { Key: "OpenshipOrganization", Value: "org-a" },
              { Key: "OpenshipSite", Value: "docs" },
            ],
          },
        ],
      });
    expect(await listSites("org-a", "123456789012")).toEqual([
      { name: "docs", status: "CREATE_COMPLETE", createdAt: undefined },
    ]);
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });
  it("does not delete or invalidate a stack owned by another organization", async () => {
    mocks.send.mockResolvedValue({
      Stacks: [{ Tags: [{ Key: "OpenshipOrganization", Value: "org-b" }] }],
    });
    await expect(deleteSite("org-a", "123456789012", "docs")).rejects.toThrow();
    await expect(invalidateSite("org-a", "123456789012", "docs")).rejects.toThrow();
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.cdn).not.toHaveBeenCalled();
  });
  it("tags new infrastructure with its owner", async () => {
    mocks.send.mockResolvedValue({});
    await saveSite("org-a", "123456789012", { name: "docs" });
    expect(mocks.send.mock.calls[0][0].input.Tags).toContainEqual({
      Key: "OpenshipOrganization",
      Value: "org-a",
    });
  });
  it("redacts upstream error messages", async () => {
    await expect(
      awsOperation(async () => {
        throw new Error("secret credential contents");
      }),
    ).rejects.toThrow("AWS operation failed (Error)");
  });
});
