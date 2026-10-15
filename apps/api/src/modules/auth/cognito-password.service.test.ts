import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
const m = vi.hoisted(() => ({
  send: vi.fn(),
  adapter: {
    findAccountByProviderId: vi.fn(),
    findUserByEmail: vi.fn(),
    createUser: vi.fn(),
    createAccount: vi.fn(),
    createSession: vi.fn(),
  },
}));
vi.mock("../../config/env", () => ({
  env: {
    COGNITO_USER_POOL_ID: "ap-south-1_Test",
    COGNITO_CLIENT_ID: "app-id",
    COGNITO_CLIENT_SECRET: "app-secret",
  },
}));
vi.mock("../../lib/auth", () => ({
  auth: { $context: Promise.resolve({ internalAdapter: m.adapter }) },
}));
vi.mock("@repo/db", () => ({ withAdvisoryLock: async (_key: string, fn: () => unknown) => fn() }));
vi.mock("@aws-sdk/client-cognito-identity-provider", () => {
  class Command {
    constructor(public input: unknown) {}
  }
  return {
    CognitoIdentityProviderClient: class {
      send = m.send;
      destroy() {}
    },
    InitiateAuthCommand: Command,
    RespondToAuthChallengeCommand: Command,
    GetUserCommand: Command,
    AssociateSoftwareTokenCommand: Command,
    VerifySoftwareTokenCommand: Command,
  };
});
import {
  secretHash,
  startCognitoSignIn,
  answerCognitoChallenge,
  createCognitoAppSession,
  cognitoOperation,
  type ChallengeState,
} from "./cognito-password.service";
const profile = { id: "subject", name: "User", email: "user@example.com", emailVerified: true };
const state: ChallengeState = {
  username: "canonical-user",
  session: "aws-session",
  challenge: "SOFTWARE_TOKEN_MFA",
  poolId: "ap-south-1_Test",
  clientId: "app-id",
  expiresAt: Date.now() + 60000,
  requiredAttributes: [],
};
beforeEach(() => {
  vi.resetAllMocks();
});
describe("embedded Cognito authentication", () => {
  it("calculates the app client secret hash server-side", () => {
    expect(secretHash("alice", "client", "secret")).toBe(
      createHmac("sha256", "secret").update("aliceclient").digest("base64"),
    );
  });
  it("authenticates with the SDK and verifies identity with GetUser", async () => {
    m.send
      .mockResolvedValueOnce({
        AuthenticationResult: { AccessToken: "private-token", IdToken: "untrusted-claims" },
      })
      .mockResolvedValueOnce({
        UserAttributes: [
          { Name: "sub", Value: "subject" },
          { Name: "name", Value: "User" },
          { Name: "email", Value: "user@example.com" },
          { Name: "email_verified", Value: "true" },
        ],
      });
    const result = await startCognitoSignIn("alice", "password");
    expect(m.send.mock.calls[0][0].input).toMatchObject({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: "app-id",
      AuthParameters: {
        USERNAME: "alice",
        PASSWORD: "password",
        SECRET_HASH: secretHash("alice", "app-id", "app-secret"),
      },
    });
    expect(m.send.mock.calls[1][0].input).toEqual({ AccessToken: "private-token" });
    expect(result).toEqual({ profile });
    expect(JSON.stringify(result)).not.toContain("private-token");
  });
  it("does not accept unsigned ID-token claims as proof of identity", async () => {
    m.send.mockResolvedValue({ AuthenticationResult: { IdToken: "pretend-token" } });
    await expect(startCognitoSignIn("alice", "password")).rejects.toThrow();
  });
  it("keeps challenge state separate from the public challenge description", async () => {
    m.send.mockResolvedValue({
      ChallengeName: "SMS_MFA",
      Session: "private-aws-session",
      ChallengeParameters: { USER_ID_FOR_SRP: "canonical-user" },
    });
    const result = await startCognitoSignIn("alias", "password");
    expect(result.state?.username).toBe("canonical-user");
    expect(result.state?.session).toBe("private-aws-session");
    expect(result.challenge).toBe("SMS_MFA");
    expect(m.adapter.createSession).not.toHaveBeenCalled();
  });
  it("rejects expired and wrong-client challenges before calling AWS", async () => {
    await expect(
      answerCognitoChallenge({ ...state, expiresAt: 0 }, { code: "123456" }),
    ).rejects.toThrow("expired");
    await expect(
      answerCognitoChallenge({ ...state, clientId: "other-client" }, { code: "123456" }),
    ).rejects.toThrow("expired");
    expect(m.send).not.toHaveBeenCalled();
  });
  it("uses the pinned canonical username and secret hash for MFA", async () => {
    m.send.mockResolvedValue({ ChallengeName: "SOFTWARE_TOKEN_MFA", Session: "next-session" });
    await answerCognitoChallenge(state, { code: "123456" });
    expect(m.send.mock.calls[0][0].input).toMatchObject({
      Session: "aws-session",
      ChallengeResponses: {
        USERNAME: "canonical-user",
        SOFTWARE_TOKEN_MFA_CODE: "123456",
        SECRET_HASH: secretHash("canonical-user", "app-id", "app-secret"),
      },
    });
  });
  it("only sends required attributes during forced password changes", async () => {
    m.send.mockResolvedValue({ ChallengeName: "SMS_MFA", Session: "next-session" });
    await answerCognitoChallenge(
      { ...state, challenge: "NEW_PASSWORD_REQUIRED", requiredAttributes: ["name"] },
      { newPassword: "NewPassword123!", attributes: { name: "User", role: "admin" } },
    );
    expect(m.send.mock.calls[0][0].input.ChallengeResponses).toMatchObject({
      NEW_PASSWORD: "NewPassword123!",
      "userAttributes.name": "User",
    });
    expect(m.send.mock.calls[0][0].input.ChallengeResponses).not.toHaveProperty(
      "userAttributes.role",
    );
  });
  it("supports authenticator setup before completing MFA_SETUP", async () => {
    m.send
      .mockResolvedValueOnce({ ChallengeName: "MFA_SETUP", Session: "initial" })
      .mockResolvedValueOnce({ Session: "setup", SecretCode: "authenticator-key" });
    const result = await startCognitoSignIn("alice", "password");
    expect(result.secret).toBe("authenticator-key");
    expect(result.state?.session).toBe("setup");
    m.send
      .mockReset()
      .mockResolvedValueOnce({ Status: "SUCCESS", Session: "verified" })
      .mockResolvedValueOnce({ ChallengeName: "SMS_MFA", Session: "next" });
    await answerCognitoChallenge(result.state!, { code: "123456" });
    expect(m.send.mock.calls[1][0].input).toMatchObject({
      ChallengeName: "MFA_SETUP",
      Session: "verified",
    });
  });
  it("never includes upstream errors or credentials in API failures", async () => {
    await expect(
      cognitoOperation(async () => {
        throw Object.assign(new Error("password: secret"), { name: "NotAuthorizedException" });
      }),
    ).rejects.toThrow("Invalid username or password");
    await expect(
      cognitoOperation(async () => {
        throw new Error("password: secret");
      }),
    ).rejects.toThrow("temporarily unavailable");
  });
});
describe("Cognito application session", () => {
  it("uses the pool and immutable subject to resolve an existing account", async () => {
    m.adapter.findAccountByProviderId.mockResolvedValue({ userId: "local-user" });
    m.adapter.createSession.mockResolvedValue({ token: "app-cookie" });
    await createCognitoAppSession(profile, {});
    expect(m.adapter.findAccountByProviderId).toHaveBeenCalledWith(
      "subject",
      "cognito:ap-south-1_Test",
    );
    expect(m.adapter.createSession).toHaveBeenCalledWith("local-user", false, expect.anything());
    expect(m.adapter.createUser).not.toHaveBeenCalled();
  });
  it("rejects automatic email-based account takeover", async () => {
    m.adapter.findUserByEmail.mockResolvedValue({ user: { id: "existing-admin" } });
    await expect(createCognitoAppSession(profile, {})).rejects.toThrow(
      "already has an Openship account",
    );
    expect(m.adapter.createAccount).not.toHaveBeenCalled();
    expect(m.adapter.createSession).not.toHaveBeenCalled();
  });
  it("runs new users through Better Auth hooks and does not grant a provider role", async () => {
    m.adapter.createUser.mockResolvedValue({ id: "new-user" });
    m.adapter.createSession.mockResolvedValue({ token: "app-cookie" });
    await createCognitoAppSession(profile, {});
    expect(m.adapter.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: "user@example.com", emailVerified: true }),
    );
    expect(m.adapter.createUser.mock.calls[0][0]).not.toHaveProperty("role");
    expect(m.adapter.createAccount).toHaveBeenCalledWith({
      userId: "new-user",
      accountId: "subject",
      providerId: "cognito:ap-south-1_Test",
    });
  });
});
