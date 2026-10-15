import { describe, expect, it } from "vitest";
import { mapCognitoProfile } from "./cognito";
describe("Cognito identity", () => {
  it("uses immutable subject and never accepts provider roles", () => {
    expect(
      mapCognitoProfile({
        sub: "abc",
        email: "a@example.com",
        email_verified: true,
        role: "admin",
      }),
    ).toEqual({ id: "abc", email: "a@example.com", name: "a@example.com", emailVerified: true });
  });
  it.each([false, undefined, "false", "TRUE", 1])(
    "rejects unverified or ambiguous email verification %s",
    (email_verified) => {
      expect(() =>
        mapCognitoProfile({ sub: "abc", email: "a@example.com", email_verified }),
      ).toThrow();
    },
  );
  it("accepts Cognito userinfo's documented string verification claim", () => {
    expect(
      mapCognitoProfile({ sub: "abc", email: "a@example.com", email_verified: "true" })
        .emailVerified,
    ).toBe(true);
  });
  it("requires a subject", () =>
    expect(() => mapCognitoProfile({ email: "a@example.com", email_verified: true })).toThrow());
});
