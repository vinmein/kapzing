import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie, setSignedCookie } from "hono/cookie";
import { Type } from "@sinclair/typebox";
import { tbValidator } from "@hono/typebox-validator";
import { z } from "zod";
import { AppError } from "@repo/core";
import { env } from "../../config/env";
import { secureRouter } from "../../lib/secure-router";
import { encryptWithKey, decryptWithKey } from "../../lib/encryption";
import { auth } from "../../lib/auth";
import * as service from "./cognito-password.service";

const r = secureRouter(new Hono(), { module: "cognito-auth", basePath: "/api/auth/cognito" });
const cookieName = "openship.cognito_challenge";
const key = () =>
  createHash("sha256").update(`openship:cognito-challenge:${env.BETTER_AUTH_SECRET}`).digest();
const cookieOptions = () => ({
  httpOnly: true,
  sameSite: "Lax" as const,
  secure: env.CLOUD_MODE || !!env.OPENSHIP_PUBLIC_URL?.startsWith("https://"),
  path: "/",
  maxAge: 180,
});
const State = z.object({
  username: z.string().min(1),
  session: z.string().min(1),
  challenge: z.string(),
  expiresAt: z.number(),
  poolId: z.string(),
  clientId: z.string(),
  requiredAttributes: z.array(z.string()),
});

async function finish(c: Context, result: Awaited<ReturnType<typeof service.startCognitoSignIn>>) {
  c.header("Cache-Control", "no-store");
  if (result.profile) {
    const session = await service.createCognitoAppSession(result.profile, {
      ipAddress: c.get("clientIp") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
    });
    deleteCookie(c, cookieName, { path: "/" });
    const cookies = (await auth.$context).authCookies;
    // Match Better Auth's configured name/domain, including secure prefixes on SaaS.
    // Discard a previous user's cached session so it cannot shadow this new login.
    deleteCookie(c, cookies.sessionData.name, {
      path: cookies.sessionData.attributes.path ?? "/",
      domain: cookies.sessionData.attributes.domain,
    });
    await setSignedCookie(c, cookies.sessionToken.name, session.token, env.BETTER_AUTH_SECRET, {
      httpOnly: true,
      secure: cookies.sessionToken.attributes.secure,
      sameSite: "Lax",
      path: cookies.sessionToken.attributes.path ?? "/",
      domain: cookies.sessionToken.attributes.domain,
      expires: session.expiresAt,
    });
    return c.json({ authenticated: true });
  }
  const sealed = encryptWithKey(key(), JSON.stringify(result.state));
  if (sealed.length > 3800)
    throw new AppError(
      "Cognito challenge is too large. Contact your administrator.",
      502,
      "COGNITO_CHALLENGE_INVALID",
    );
  setCookie(c, cookieName, sealed, cookieOptions());
  return c.json({
    authenticated: false,
    challenge: result.challenge,
    requiredAttributes: result.requiredAttributes,
    mfaOptions: result.mfaOptions,
    setupSecret: result.secret,
  });
}

const SignInBody = Type.Object(
  {
    username: Type.String({ minLength: 1, maxLength: 128 }),
    password: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);
const ChallengeBody = Type.Object(
  {
    code: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    newPassword: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    attributes: Type.Optional(
      Type.Record(Type.String({ maxLength: 128 }), Type.String({ minLength: 1, maxLength: 2048 })),
    ),
    mfaType: Type.Optional(Type.String({ maxLength: 32 })),
  },
  { additionalProperties: false },
);
// secureRouter's automatic body validation only applies to permission-tagged routes.
// Public sign-in routes validate explicitly and never echo submitted credentials.
const validate = (schema: typeof SignInBody | typeof ChallengeBody) =>
  tbValidator("json", schema, (result, c) => {
    c.header("Cache-Control", "no-store");
    if (!result.success)
      return c.json(
        { error: "Invalid authentication request.", code: "INVALID_AUTH_REQUEST" },
        400,
      );
  });
r.post(
  "/sign-in",
  {
    public: true,
    reason: "Authenticate with Cognito credentials before an application session exists.",
    rateLimit: "auth-tight",
  },
  validate(SignInBody),
  async (c) => {
    deleteCookie(c, cookieName, { path: "/" });
    const { username, password } = await c.req.json<{ username: string; password: string }>();
    return service.cognitoOperation(async () =>
      finish(c, await service.startCognitoSignIn(username.trim(), password)),
    );
  },
);
r.post(
  "/challenge",
  {
    public: true,
    reason: "Complete an encrypted, short-lived Cognito challenge bound to this browser.",
    rateLimit: "auth-tight",
  },
  validate(ChallengeBody),
  async (c) => {
    let state: service.ChallengeState;
    try {
      const cookie = getCookie(c, cookieName);
      if (!cookie) throw new Error("Missing challenge");
      state = State.parse(JSON.parse(decryptWithKey(key(), cookie)));
    } catch {
      deleteCookie(c, cookieName, { path: "/" });
      throw new AppError("Sign-in expired. Start again.", 401, "COGNITO_CHALLENGE_EXPIRED");
    }
    const answer = await c.req.json<service.ChallengeAnswer>();
    return service.cognitoOperation(async () =>
      finish(c, await service.answerCognitoChallenge(state, answer)),
    );
  },
);
export const cognitoPasswordRoutes = r.hono;
