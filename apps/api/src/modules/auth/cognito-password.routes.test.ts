import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const m = vi.hoisted(() => ({ start: vi.fn(), answer: vi.fn(), session: vi.fn() }));
vi.mock("../../config/env", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-key-with-enough-length-to-sign",
    CLOUD_MODE: false,
    OPENSHIP_PUBLIC_URL: "http://localhost:3490",
  },
}));
vi.mock("../../lib/auth", () => ({
  auth: {
    $context: Promise.resolve({
      authCookies: {
        sessionToken: {
          name: "configured.session_token",
          attributes: { path: "/", secure: false },
        },
        sessionData: { name: "configured.session_data", attributes: { path: "/" } },
      },
    }),
  },
}));
vi.mock("./cognito-password.service", () => ({
  startCognitoSignIn: m.start,
  answerCognitoChallenge: m.answer,
  createCognitoAppSession: m.session,
  cognitoOperation: (fn: () => unknown) => fn(),
}));
vi.mock("../../middleware/auth", () => ({
  authMiddleware: (_c: unknown, next: () => unknown) => next(),
}));
vi.mock("../../middleware/rate-limiter", () => ({
  rateLimiterFor: () => (_c: unknown, next: () => unknown) => next(),
}));
vi.mock("../../lib/route-permission", () => ({
  requirePermission: () => (_c: unknown, next: () => unknown) => next(),
  publicRoute: () => (_c: unknown, next: () => unknown) => next(),
  registerRoute: () => {},
  isPublicSpec: (s: { public?: boolean }) => s.public === true,
}));
import { cognitoPasswordRoutes } from "./cognito-password.routes";
const app = new Hono().route("/cognito", cognitoPasswordRoutes);
app.onError((error, c) =>
  c.json({ error: error.message }, ((error as { statusCode?: number }).statusCode as 401) ?? 500),
);
const post = (path: string, body: unknown, cookie?: string) =>
  app.request(`/cognito/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
beforeEach(() => vi.resetAllMocks());
describe("Cognito embedded auth endpoints", () => {
  it("validates credentials without accepting provider tokens from clients", async () => {
    expect(
      (await post("sign-in", { username: "test", password: "pw", accessToken: "forged" })).status,
    ).toBe(400);
    expect((await post("sign-in", { username: "test" })).status).toBe(400);
    expect(m.start).not.toHaveBeenCalled();
  });
  it("encrypts challenge state in an HttpOnly cookie and returns no AWS session", async () => {
    m.start.mockResolvedValue({
      state: {
        session: "private-session",
        username: "test",
        challenge: "SMS_MFA",
        poolId: "pool",
        clientId: "client",
        expiresAt: Date.now() + 180000,
        requiredAttributes: [],
      },
      challenge: "SMS_MFA",
      requiredAttributes: [],
    });
    const response = await post("sign-in", { username: "test", password: "pw" });
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("private-session");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      authenticated: false,
      challenge: "SMS_MFA",
      requiredAttributes: [],
    });
    expect(m.session).not.toHaveBeenCalled();
  });
  it("rejects missing and tampered challenge cookies", async () => {
    expect((await post("challenge", { code: "123456" })).status).toBe(401);
    expect(
      (await post("challenge", { code: "123456" }, "openship.cognito_challenge=forged")).status,
    ).toBe(401);
    expect(m.answer).not.toHaveBeenCalled();
  });
  it("resumes only the encrypted browser-bound challenge", async () => {
    m.start.mockResolvedValue({
      state: {
        session: "private-session",
        username: "canonical",
        challenge: "SMS_MFA",
        poolId: "pool",
        clientId: "client",
        expiresAt: Date.now() + 180000,
        requiredAttributes: [],
      },
      challenge: "SMS_MFA",
      requiredAttributes: [],
    });
    const first = await post("sign-in", { username: "test", password: "pw" });
    const cookies = first.headers.getSetCookie();
    const cookie = cookies
      .find((s) => s.startsWith("openship.cognito_challenge=") && s.includes("HttpOnly"))!
      .split(";")[0];
    m.answer.mockResolvedValue({ profile: { id: "subject" } });
    m.session.mockResolvedValue({ token: "app-session", expiresAt: new Date(Date.now() + 60000) });
    const response = await post("challenge", { code: "123456" }, cookie);
    expect(m.answer).toHaveBeenCalledWith(
      expect.objectContaining({ session: "private-session", username: "canonical" }),
      { code: "123456" },
    );
    expect(await response.json()).toEqual({ authenticated: true });
    expect(response.headers.get("set-cookie")).toContain("configured.session_token=");
    expect(response.headers.get("set-cookie")).toContain("configured.session_data=");
  });
});
