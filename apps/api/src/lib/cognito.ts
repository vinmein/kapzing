import { APIError } from "better-auth/api";

export function mapCognitoProfile(profile: Record<string, unknown>) {
  if (
    typeof profile.sub !== "string" ||
    !profile.sub ||
    typeof profile.email !== "string" ||
    !profile.email ||
    (profile.email_verified !== true && profile.email_verified !== "true")
  ) {
    throw new APIError("FORBIDDEN", { message: "A verified Cognito email address is required." });
  }
  return {
    id: profile.sub,
    name: typeof profile.name === "string" && profile.name ? profile.name : profile.email,
    email: profile.email,
    emailVerified: true,
  };
}
