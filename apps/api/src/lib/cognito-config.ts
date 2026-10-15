/** Cognito pool IDs embed their AWS region, so no separate issuer or region is required. */
export const COGNITO_USER_POOL_ID_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d_[A-Za-z0-9]+$/;

export function cognitoIssuer(userPoolId: string): string {
  if (!COGNITO_USER_POOL_ID_PATTERN.test(userPoolId)) {
    throw new Error("Invalid Cognito user pool ID. Expected a value such as us-east-1_EXAMPLE.");
  }
  const region = userPoolId.split("_")[0];
  const dnsSuffix = region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
  return `https://cognito-idp.${region}.${dnsSuffix}/${userPoolId}`;
}
