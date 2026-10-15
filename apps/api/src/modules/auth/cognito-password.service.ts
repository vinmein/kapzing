import { createHash, createHmac } from "node:crypto";
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  GetUserCommand,
  AssociateSoftwareTokenCommand,
  VerifySoftwareTokenCommand,
  type InitiateAuthCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";
import { APIError } from "better-auth/api";
import { AppError, ValidationError } from "@repo/core";
import { withAdvisoryLock } from "@repo/db";
import { env } from "../../config/env";
import { auth } from "../../lib/auth";
import { cognitoIssuer } from "../../lib/cognito-config";
import { mapCognitoProfile } from "../../lib/cognito";

export type ChallengeState = {
  username: string;
  session: string;
  challenge: string;
  expiresAt: number;
  poolId: string;
  clientId: string;
  requiredAttributes: string[];
};
export type ChallengeAnswer = {
  code?: string;
  newPassword?: string;
  attributes?: Record<string, string>;
  mfaType?: string;
};

export function secretHash(username: string, clientId: string, clientSecret: string) {
  return createHmac("sha256", clientSecret)
    .update(username + clientId)
    .digest("base64");
}
export function cognitoConfig() {
  if (!env.COGNITO_USER_POOL_ID || !env.COGNITO_CLIENT_ID || !env.COGNITO_CLIENT_SECRET)
    throw new AppError("Cognito is not configured.", 503, "COGNITO_DISABLED");
  cognitoIssuer(env.COGNITO_USER_POOL_ID); // validate before constructing an SDK endpoint
  return {
    poolId: env.COGNITO_USER_POOL_ID,
    clientId: env.COGNITO_CLIENT_ID,
    clientSecret: env.COGNITO_CLIENT_SECRET,
  };
}
function client() {
  const config = cognitoConfig();
  return new CognitoIdentityProviderClient({ region: config.poolId.split("_")[0], maxAttempts: 1 });
}

/** No user passwords, Cognito tokens or raw AWS error messages are ever returned or logged. */
export async function cognitoOperation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof APIError)
      throw new AppError(
        error.body?.message ?? "Your account cannot sign in to this instance.",
        error.statusCode,
        "COGNITO_ACCOUNT_DENIED",
      );
    const name = error instanceof Error ? error.name : "";
    if (["NotAuthorizedException", "UserNotFoundException"].includes(name))
      throw new AppError("Invalid username or password.", 401, "INVALID_CREDENTIALS");
    if (["CodeMismatchException", "ExpiredCodeException"].includes(name))
      throw new AppError(
        "The verification code is incorrect or expired.",
        400,
        "COGNITO_INVALID_CODE",
      );
    if (name === "UserNotConfirmedException")
      throw new AppError(
        "Confirm your Cognito account before signing in.",
        403,
        "COGNITO_NOT_CONFIRMED",
      );
    if (name === "PasswordResetRequiredException")
      throw new AppError(
        "Your Cognito password must be reset. Contact your account administrator.",
        403,
        "COGNITO_PASSWORD_RESET_REQUIRED",
      );
    if (name === "InvalidPasswordException")
      throw new ValidationError("The new password does not meet your Cognito password policy.");
    if (name === "InvalidParameterException")
      throw new AppError(
        "Cognito rejected this authentication request. Enable ALLOW_USER_PASSWORD_AUTH on the app client and check its required attributes.",
        400,
        "COGNITO_AUTH_CONFIGURATION",
      );
    if (name === "TooManyRequestsException")
      throw new AppError(
        "Too many sign-in attempts. Try again shortly.",
        429,
        "COGNITO_RATE_LIMITED",
      );
    throw new AppError(
      "Cognito authentication is temporarily unavailable.",
      502,
      "COGNITO_UNAVAILABLE",
    );
  }
}

export async function startCognitoSignIn(username: string, password: string) {
  const config = cognitoConfig();
  const sdk = client();
  try {
    const result = await sdk.send(
      new InitiateAuthCommand({
        ClientId: config.clientId,
        AuthFlow: "USER_PASSWORD_AUTH",
        AuthParameters: {
          USERNAME: username,
          PASSWORD: password,
          SECRET_HASH: secretHash(username, config.clientId, config.clientSecret),
        },
      }),
    );
    return await nextStep(sdk, result, username);
  } finally {
    sdk.destroy();
  }
}

export async function answerCognitoChallenge(state: ChallengeState, answer: ChallengeAnswer) {
  const config = cognitoConfig();
  if (
    state.expiresAt < Date.now() ||
    state.poolId !== config.poolId ||
    state.clientId !== config.clientId
  )
    throw new AppError("Sign-in expired. Start again.", 401, "COGNITO_CHALLENGE_EXPIRED");
  const responses: Record<string, string> = {
    USERNAME: state.username,
    SECRET_HASH: secretHash(state.username, config.clientId, config.clientSecret),
  };
  const sdk = client();
  try {
    let session = state.session;
    switch (state.challenge) {
      case "NEW_PASSWORD_REQUIRED":
        if (!answer.newPassword) throw new ValidationError("Enter a new password.");
        responses.NEW_PASSWORD = answer.newPassword;
        for (const key of state.requiredAttributes) {
          if (!answer.attributes?.[key]) throw new ValidationError(`Enter ${key}.`);
          responses[`userAttributes.${key}`] = answer.attributes[key];
        }
        break;
      case "SELECT_MFA_TYPE":
        if (!["SMS_MFA", "SOFTWARE_TOKEN_MFA", "EMAIL_OTP"].includes(answer.mfaType ?? ""))
          throw new ValidationError("Select an MFA method.");
        responses.ANSWER = answer.mfaType!;
        break;
      case "SMS_MFA":
      case "SOFTWARE_TOKEN_MFA":
      case "EMAIL_OTP":
      case "SMS_OTP":
        if (!answer.code) throw new ValidationError("Enter the verification code.");
        responses[
          {
            SMS_MFA: "SMS_MFA_CODE",
            SOFTWARE_TOKEN_MFA: "SOFTWARE_TOKEN_MFA_CODE",
            EMAIL_OTP: "EMAIL_OTP_CODE",
            SMS_OTP: "SMS_OTP_CODE",
          }[state.challenge]!
        ] = answer.code;
        break;
      case "MFA_SETUP": {
        if (!answer.code) throw new ValidationError("Enter the authenticator code.");
        const verified = await sdk.send(
          new VerifySoftwareTokenCommand({ Session: session, UserCode: answer.code }),
        );
        if (verified.Status !== "SUCCESS" || !verified.Session)
          throw new ValidationError("Authenticator verification failed.");
        session = verified.Session;
        break;
      }
      default:
        throw new ValidationError(
          "This Cognito authentication challenge is not supported. Contact your account administrator.",
        );
    }
    const result = await sdk.send(
      new RespondToAuthChallengeCommand({
        ClientId: config.clientId,
        ChallengeName: state.challenge as "SMS_MFA",
        Session: session,
        ChallengeResponses: responses,
      }),
    );
    return await nextStep(sdk, result, state.username);
  } finally {
    sdk.destroy();
  }
}

async function nextStep(
  sdk: CognitoIdentityProviderClient,
  result: InitiateAuthCommandOutput,
  username: string,
) {
  const config = cognitoConfig();
  if (result.AuthenticationResult?.AccessToken) {
    // Cognito validates this token itself; identity never comes from browser-submitted JWT claims.
    const verified = await sdk.send(
      new GetUserCommand({ AccessToken: result.AuthenticationResult.AccessToken }),
    );
    const attrs = Object.fromEntries(
      (verified.UserAttributes ?? []).map((a) => [a.Name!, a.Value!]),
    );
    return { profile: mapCognitoProfile(attrs) };
  }
  const supported = [
    "NEW_PASSWORD_REQUIRED",
    "SMS_MFA",
    "SOFTWARE_TOKEN_MFA",
    "EMAIL_OTP",
    "SMS_OTP",
    "SELECT_MFA_TYPE",
    "MFA_SETUP",
  ];
  if (!result.Session || !result.ChallengeName || !supported.includes(result.ChallengeName))
    throw new ValidationError(
      "This Cognito authentication challenge is not supported. Contact your account administrator.",
    );
  const params = result.ChallengeParameters ?? {};
  let required: string[] = [];
  try {
    required = JSON.parse(params.requiredAttributes ?? "[]");
  } catch {
    throw new ValidationError("Invalid Cognito challenge attributes.");
  }
  if (!Array.isArray(required) || required.some((k) => typeof k !== "string"))
    throw new ValidationError("Invalid Cognito challenge attributes.");
  const requiredAttributes = required.map((k) => k.replace(/^userAttributes\./, ""));
  let session = result.Session;
  let secret: string | undefined;
  if (result.ChallengeName === "MFA_SETUP") {
    const setup = await sdk.send(new AssociateSoftwareTokenCommand({ Session: session }));
    if (!setup.Session || !setup.SecretCode)
      throw new ValidationError("Could not start authenticator setup.");
    session = setup.Session;
    secret = setup.SecretCode;
  }
  const state: ChallengeState = {
    username: params.USERNAME || params.USER_ID_FOR_SRP || username,
    session,
    challenge: result.ChallengeName,
    requiredAttributes,
    expiresAt: Date.now() + 180_000,
    poolId: config.poolId,
    clientId: config.clientId,
  };
  let mfaOptions: string[] = [];
  try {
    const options = JSON.parse(params.MFAS_CAN_CHOOSE ?? "[]");
    if (Array.isArray(options))
      mfaOptions = options.filter((o) =>
        ["SMS_MFA", "SOFTWARE_TOKEN_MFA", "EMAIL_OTP"].includes(o),
      );
  } catch {
    /* No selectable methods. */
  }
  return { state, challenge: state.challenge, requiredAttributes, mfaOptions, secret };
}

/** Hooks enforce the same invite-only policy and personal-org setup as normal sign-in. */
export async function createCognitoAppSession(
  profile: ReturnType<typeof mapCognitoProfile>,
  request: { ipAddress?: string | null; userAgent?: string | null },
) {
  const { poolId } = cognitoConfig();
  const providerId = `cognito:${poolId}`;
  return withAdvisoryLock(`cognito-login:${poolId}:${profile.id}`, async () => {
    const adapter = (await auth.$context).internalAdapter;
    const account = await adapter.findAccountByProviderId(profile.id, providerId);
    let userId = account?.userId;
    if (!userId) {
      const localId = `cog_${createHash("sha256").update(`${poolId}:${profile.id}`).digest("hex").slice(0, 32)}`;
      const existing = await adapter.findUserByEmail(profile.email.toLowerCase());
      if (existing && existing.user.id !== localId)
        throw new AppError(
          "This email already has an Openship account. Ask your administrator to link your Cognito identity.",
          409,
          "COGNITO_ACCOUNT_LINK_REQUIRED",
        );
      const user =
        existing?.user ??
        (await adapter.createUser({
          id: localId,
          name: profile.name,
          email: profile.email.toLowerCase(),
          emailVerified: true,
        }));
      await adapter.createAccount({ accountId: profile.id, providerId, userId: user.id });
      userId = user.id;
    }
    const session = await adapter.createSession(userId, false, {
      ipAddress: request.ipAddress,
      userAgent: request.userAgent,
    });
    if (!session) throw new AppError("Could not create a session.", 503, "AUTH_UNAVAILABLE");
    return session;
  });
}
