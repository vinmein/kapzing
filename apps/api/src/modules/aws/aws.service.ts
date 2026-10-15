import {
  CloudFormationClient,
  CreateStackCommand,
  UpdateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  ListStackResourcesCommand,
  DescribeStackEventsCommand,
  GetTemplateCommand,
} from "@aws-sdk/client-cloudformation";
import { ACMClient, DescribeCertificateCommand } from "@aws-sdk/client-acm";
import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { AppError, NotFoundError, ValidationError } from "@repo/core";
import { resolveCredentialSecrets } from "../credentials/credential.service";
import { awsCredentials, awsAccountId, AWS_REGION } from "./aws-client";
import { siteName, siteTemplate, type SiteInput } from "./site-template";

export async function accountClient(orgId: string, account: string) {
  if (!/^\d{12}$/.test(account)) throw new ValidationError("Invalid AWS account ID.");
  const stored = await resolveCredentialSecrets({
    organizationId: orgId,
    provider: "aws",
    selector: account,
  });
  if (!stored)
    throw new ValidationError("Connect this AWS account in Settings → Credentials first.");
  const credentials = await awsCredentials(stored.publicFields, stored.secrets);
  if ((await awsAccountId(credentials)) !== account)
    throw new ValidationError("AWS account no longer matches the connected credentials.");
  return { region: AWS_REGION, credentials, maxAttempts: 2 };
}

async function ownedStack(client: CloudFormationClient, orgId: string, name: string) {
  const result = await client.send(new DescribeStacksCommand({ StackName: siteName(orgId, name) }));
  const stack = result.Stacks?.[0];
  if (!stack || !stack.Tags?.some((t) => t.Key === "OpenshipOrganization" && t.Value === orgId))
    throw new NotFoundError("AWS site not found.");
  return stack;
}

// AWS errors may echo provider requests. Return only a stable code, never raw messages.
export async function awsOperation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = error instanceof Error ? error.name : "AwsError";
    throw new AppError(
      `AWS operation failed (${/^[A-Za-z0-9]+$/.test(code) ? code : "AwsError"}). Check account permissions and the stack events in AWS.`,
      502,
      "AWS_OPERATION_FAILED",
    );
  }
}

export async function listSites(orgId: string, account: string) {
  const client = new CloudFormationClient(await accountClient(orgId, account));
  try {
    const rows = [];
    let NextToken: string | undefined;
    do {
      const result = await client.send(new DescribeStacksCommand({ NextToken }));
      for (const stack of result.Stacks ?? []) {
        if (
          stack.Tags?.some((t) => t.Key === "OpenshipOrganization" && t.Value === orgId) &&
          stack.Tags.some((t) => t.Key === "ManagedBy" && t.Value === "Openship")
        ) {
          rows.push({
            name: stack.Tags.find((t) => t.Key === "OpenshipSite")?.Value,
            status: stack.StackStatus,
            createdAt: stack.CreationTime,
          });
        }
      }
      NextToken = result.NextToken;
    } while (NextToken);
    return rows;
  } finally {
    client.destroy();
  }
}

export async function getSite(orgId: string, account: string, name: string) {
  const config = await accountClient(orgId, account);
  const client = new CloudFormationClient(config);
  const acm = new ACMClient(config);
  try {
    const stack = await ownedStack(client, orgId, name);
    const template = await client.send(
      new GetTemplateCommand({ StackName: stack.StackId, TemplateStage: "Original" }),
    );
    const configuration: SiteInput = JSON.parse(template.TemplateBody ?? "{}").Metadata
      ?.OpenshipSite ?? { name };
    const resources = await client.send(
      new ListStackResourcesCommand({ StackName: stack.StackId }),
    );
    const events = await client.send(new DescribeStackEventsCommand({ StackName: stack.StackId }));
    const certArn = resources.StackResourceSummaries?.find(
      (r) => r.LogicalResourceId === "Certificate",
    )?.PhysicalResourceId;
    const certificate = certArn
      ? (await acm.send(new DescribeCertificateCommand({ CertificateArn: certArn }))).Certificate
      : undefined;
    const outputs = Object.fromEntries(
      (stack.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]),
    );
    return {
      name,
      status: stack.StackStatus,
      outputs,
      configuration,
      certificateStatus: certificate?.Status,
      validationRecords:
        certificate?.DomainValidationOptions?.flatMap((v) =>
          v.ResourceRecord ? [v.ResourceRecord] : [],
        ) ?? [],
      resources: resources.StackResourceSummaries?.map((r) => ({
        logicalId: r.LogicalResourceId,
        id: r.PhysicalResourceId,
        status: r.ResourceStatus,
      })),
      events: events.StackEvents?.slice(0, 15).map((e) => ({
        resource: e.LogicalResourceId,
        status: e.ResourceStatus,
        time: e.Timestamp,
      })),
    };
  } finally {
    client.destroy();
    acm.destroy();
  }
}

export async function saveSite(orgId: string, account: string, input: SiteInput, update = false) {
  const name = siteName(orgId, input.name);
  const TemplateBody = JSON.stringify(siteTemplate(input));
  const client = new CloudFormationClient(await accountClient(orgId, account));
  try {
    if (update) {
      const stack = await ownedStack(client, orgId, input.name);
      try {
        await client.send(new UpdateStackCommand({ StackName: stack.StackId, TemplateBody }));
      } catch (error) {
        if (!(error instanceof Error && error.message === "No updates are to be performed."))
          throw error;
      }
    } else {
      await client.send(
        new CreateStackCommand({
          StackName: name,
          TemplateBody,
          Tags: [
            { Key: "ManagedBy", Value: "Openship" },
            { Key: "OpenshipOrganization", Value: orgId },
            { Key: "OpenshipSite", Value: input.name },
          ],
          OnFailure: "ROLLBACK",
        }),
      );
    }
    return { name: input.name, status: update ? "UPDATE_REQUESTED" : "CREATE_REQUESTED" };
  } finally {
    client.destroy();
  }
}

export async function deleteSite(orgId: string, account: string, name: string) {
  const client = new CloudFormationClient(await accountClient(orgId, account));
  try {
    const stack = await ownedStack(client, orgId, name);
    await client.send(new DeleteStackCommand({ StackName: stack.StackId }));
    return { status: "DELETE_REQUESTED", bucketRetained: true };
  } finally {
    client.destroy();
  }
}

export async function invalidateSite(orgId: string, account: string, name: string) {
  const config = await accountClient(orgId, account);
  const client = new CloudFormationClient(config);
  const cdn = new CloudFrontClient(config);
  try {
    const stack = await ownedStack(client, orgId, name);
    const DistributionId = stack.Outputs?.find(
      (o) => o.OutputKey === "DistributionId",
    )?.OutputValue;
    if (!DistributionId)
      throw new ValidationError("Wait for the distribution to finish provisioning.");
    const result = await cdn.send(
      new CreateInvalidationCommand({
        DistributionId,
        InvalidationBatch: {
          CallerReference: crypto.randomUUID(),
          Paths: { Quantity: 1, Items: ["/*"] },
        },
      }),
    );
    return { id: result.Invalidation?.Id, status: result.Invalidation?.Status };
  } finally {
    client.destroy();
    cdn.destroy();
  }
}
