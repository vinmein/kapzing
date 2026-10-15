import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { ValidationError } from "@repo/core";

export const AWS_REGION = "us-east-1";
export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};
const config = { region: AWS_REGION, maxAttempts: 2 };

export async function awsCredentials(
  fields: Record<string, string>,
  secrets: Record<string, string>,
): Promise<AwsCredentials> {
  if (!secrets.accessKeyId || !secrets.secretAccessKey)
    throw new ValidationError("Reconnect AWS credentials.");
  const source = {
    accessKeyId: secrets.accessKeyId,
    secretAccessKey: secrets.secretAccessKey,
    sessionToken: secrets.sessionToken || undefined,
  };
  if (!fields.roleArn) return source;
  if (!/^arn:aws:iam::\d{12}:role\/[\w+=,.@/\-]+$/.test(fields.roleArn))
    throw new ValidationError("Invalid AWS role ARN.");
  const client = new STSClient({ ...config, credentials: source });
  try {
    const result = await client.send(
      new AssumeRoleCommand({
        RoleArn: fields.roleArn,
        RoleSessionName: "openship",
        ExternalId: secrets.externalId || undefined,
      }),
    );
    const c = result.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken)
      throw new ValidationError("AWS returned no role credentials.");
    return {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
    };
  } finally {
    client.destroy();
  }
}

export async function awsAccountId(credentials: AwsCredentials) {
  const client = new STSClient({ ...config, credentials });
  try {
    return (await client.send(new GetCallerIdentityCommand({}))).Account;
  } finally {
    client.destroy();
  }
}
