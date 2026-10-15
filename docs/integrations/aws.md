# AWS integration

## Embedded Cognito sign-in

Sign-in stays on the Openship login page, which directly shows only the Cognito-backed form. It uses standard **Username or email**, **Password**, and **Sign in** labels, with the description **Authenticate using AWS Cognito**. The API uses the AWS SDK's `InitiateAuth` (`USER_PASSWORD_AUTH`) and `RespondToAuthChallenge` operations. No Cognito hosted-login domain or callback URL is required.

Create a Cognito User Pool and an app client with a client secret. In the app client's authentication flows, enable **ALLOW_USER_PASSWORD_AUTH**. This uses Cognito's public authentication APIs and does not require IAM access keys or an admin-auth flow.

Set only these variables on the **API** and restart it:

```dotenv
COGNITO_USER_POOL_ID=ap-south-1_EXAMPLE
COGNITO_CLIENT_ID=your-app-client-id
COGNITO_CLIENT_SECRET=your-app-client-secret
```

The API derives the AWS region from the user pool ID. No issuer URL or separate region setting is required. Never put the secret in a `NEXT_PUBLIC_*` variable. The API computes the app-client `SECRET_HASH`; the browser never receives the client secret or Cognito access, ID, refresh, or challenge session tokens. Use HTTPS for a deployed instance (localhost HTTP is for local testing).

Supported inline challenges include SMS and email codes, authenticator codes, MFA method selection, authenticator setup, and first-login password changes with Cognito-required attributes. Unsupported custom, passkey, or device-SRP challenges return an explicit error. Accounts requiring confirmation or a password reset must complete those steps through the pool's existing account-recovery process or administrator.

After AWS authenticates the user, the API calls `GetUser` with its returned access token and requires a verified email and immutable subject. Identity is bound to **user pool + subject**, not browser-supplied JWT claims. Only then does it create an HttpOnly Better Auth session cookie. Challenge sessions are encrypted in a separate short-lived HttpOnly cookie and cannot create an application session before all challenges finish. Sign-in and challenge endpoints share the existing tight authentication rate limit and origin checks.

Better Auth continues to manage application sessions, organizations, invitations, and permissions. New identities run through its normal provisioning hooks, preserving self-hosted invitation restrictions. Cognito groups never grant Openship administrator rights. Existing Openship accounts are not automatically linked by matching email; an unlinked identity with an already-used email returns `COGNITO_ACCOUNT_LINK_REQUIRED`. Account linking is not exposed in this version. Existing password, GitHub and Google login paths remain available as before.

The API endpoints are:

```text
POST /api/auth/cognito/sign-in    # { username, password }
POST /api/auth/cognito/challenge  # { code?, newPassword?, attributes?, mfaType? }
```

A challenge response returns only the next challenge description and, when required, an authenticator enrollment key. The browser-bound AWS session stays in its encrypted cookie. A successful response is `{ "authenticated": true }` plus the application session cookie.

## Connect AWS

In **Settings → Credentials**, add an AWS credential:

- AWS account ID: the 12-digit account in which resources will be created.
- Access key ID and secret access key: a dedicated IAM principal.
- Session token: required if using temporary credentials; reconnect when they expire.
- Role ARN and external ID: optional, for assuming a provisioner role. The account ID must match the assumed role's account.

Credentials are encrypted by the existing credential vault and verified with STS before storage. Operations recheck the destination account. An administrator or owner of the active organization is required for all AWS endpoints, including reads. A role's permissions and trust policy must permit `sts:AssumeRole` when configured.

For a provisioner policy, allow the actions required by the resources below, scoped to your AWS account and Openship stacks/resources wherever the AWS action supports resource-level restrictions:

| Service | Required operations |
| --- | --- |
| STS | GetCallerIdentity; AssumeRole only when configured |
| CloudFormation | CreateStack, UpdateStack, DeleteStack, DescribeStacks, GetTemplate, ListStackResources, DescribeStackEvents |
| S3 | CreateBucket, bucket encryption/versioning/ownership/public-access configuration, bucket policy and tagging operations and corresponding reads |
| CloudFront | Create/Get/Update/DeleteDistribution, distribution tagging, origin access control create/get/update/delete, CreateInvalidation |
| ACM | RequestCertificate, DescribeCertificate, DeleteCertificate, certificate tag operations |
| Route 53 (optional) | Hosted zone reads, ChangeResourceRecordSets, GetChange for the selected hosted zone |

CloudFormation executes using the connected principal; this implementation does not create or pass an execution role. STS verification confirms identity, not permission to provision every resource. Missing provisioning permissions appear as failed stack events. Detailed AWS failure reasons are available in the AWS CloudFormation console; API errors avoid echoing provider requests or secrets.

## Create and manage a site

Open **Create AWS site** in the main sidebar (`/aws-sites`) and select the account. Enter a stable site name and, optionally, a custom domain, Route 53 hosted zone ID, and SPA fallback setting.

Each site is a CloudFormation stack in **us-east-1**. This initial version also places its S3 bucket there, keeping CloudFront's ACM certificate in the required region. Resource names and tags bind stacks to the organization. CloudFormation durably tracks asynchronous operations and rollback, so provisioning survives API restarts without an additional database migration or worker.

The stack creates a private, encrypted, versioned S3 bucket, CloudFront Origin Access Control, a bucket policy scoped to that distribution, and an HTTPS-redirecting distribution. SPA fallback is opt-in; it rewrites S3 403/404 responses to `/index.html`.

- **Route 53:** specify an existing public hosted zone authoritative for the domain, in the same AWS account. CloudFormation creates validation records and A/AAAA aliases. Merely creating a hosted zone without delegating the domain to it is insufficient.
- **Cloudflare or another DNS provider:** leave the zone ID empty. Open the site and refresh until certificate validation CNAME records appear, then publish them with your provider. Once the certificate is issued and the distribution finishes, create the domain CNAME targeting `CloudFrontDomain`. Use DNS-only mode for Cloudflare. Root domains require provider-supported apex routing/flattening. DNS configuration at external providers is manual in this version.
- **No custom domain:** use the generated `https://*.cloudfront.net` URL.

Refresh lists to see provisioning progress and recent resource events. **Edit configuration** reloads the saved domain, zone, and SPA settings. Applying changes runs a CloudFormation update. **Clear CDN cache** requests a `/*` invalidation. Creating an already-named site does not create a second stack; AWS rejects the duplicate. To retry failed initial creation, inspect its events, delete the rolled-back stack, and create again.

Upload a static build using the AWS CLI or your deployment pipeline, using `BucketName` from the site details:

```sh
aws s3 sync ./dist s3://YOUR_BUCKET/
```

You can also bind the created bucket through the existing project object-storage integration. Provisioning does not change the project's current deployment target or automatically publish build artifacts. S3 serves static files; SSR applications and APIs still require their compute runtime. An empty newly-created site returns an access error until `index.html` is uploaded.

## Removal and ownership

Deleting a site requests asynchronous stack deletion, including its distribution, OAC, certificate and managed DNS records. **The S3 bucket and its data are retained**, including on replacement. Retained buckets can continue to incur charges and require separate cleanup through AWS. Retained buckets are not automatically imported into a later site of the same name. External DNS records require manual cleanup. Review certificate validation record retention behavior in AWS before removing records needed for certificate renewal.

AWS billing remains with the connected account. Site operations are recorded in the organization audit log. Changing AWS credentials does not transfer ownership of stacks; organization tags are checked before updates, deletion and invalidation. AWS IAM is the ultimate boundary against principals operating outside Openship.

## API

All paths are relative to `/api`; every route requires an authenticated organization admin/owner plus the corresponding settings permission.

```text
GET    /aws/:account/sites
GET    /aws/:account/sites/:name
POST   /aws/:account/sites                 # { name, domain?, hostedZoneId?, spa? }
PUT    /aws/:account/sites                 # complete desired configuration
POST   /aws/:account/sites/:name/invalidate
DELETE /aws/:account/sites/:name
```

Mutations return HTTP 202 after AWS accepts the request. Use the detail endpoint to follow progress. Client timeouts do not cancel an AWS operation: refresh the site list before retrying creation.


### Multiple custom domains
Each site supports up to 10 custom domains serving the same S3 content through one CloudFront distribution. Use **Add domain** in **Create AWS site**, or edit an existing site's configuration. The first domain is the primary URL; keep it first when adding aliases. HTTPS certificates cover every configured domain.

Provide a Route 53 hosted zone ID for every domain (zones may differ), or leave all zone IDs empty and publish the displayed certificate validation records and CloudFront routing records manually. Manual DNS also works for domains hosted with different providers. Validate every domain before provisioning can finish. Apex domains need ALIAS/ANAME or CNAME flattening support. Existing single-domain configurations remain editable.
