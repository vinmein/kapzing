import type { AwsSite } from "@/lib/api/aws";

export function AwsSitePublishing({ site }: { site: AwsSite }) {
  const domains =
    site.configuration?.domains ??
    (site.configuration?.domain
      ? [{ hostname: site.configuration.domain, hostedZoneId: site.configuration.hostedZoneId }]
      : []);
  const target = site.outputs?.CloudFrontDomain;
  const bucket = site.outputs?.BucketName;
  return (
    <div className="space-y-5">
      <section className="space-y-3 rounded-lg border border-border p-4">
        <h4 className="font-medium">DNS routing records</h4>
        <p className="text-sm text-muted-foreground">
          Certificate validation records above verify domain ownership. You also need a routing
          record for each domain so visitors reach CloudFront.
        </p>
        {target && domains.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className="p-2">Full DNS name</th>
                  <th className="p-2">Record</th>
                  <th className="p-2">Target</th>
                </tr>
              </thead>
              <tbody>
                {domains.map((d) => (
                  <tr key={d.hostname} className="border-t border-border">
                    <td className="break-all p-2">{d.hostname}</td>
                    <td className="p-2">
                      {d.hostedZoneId ? "A + AAAA alias (managed)" : "CNAME for subdomains"}
                    </td>
                    <td className="break-all p-2 font-mono text-xs">{target}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Routing targets appear after CloudFront is provisioned.
          </p>
        )}
        <p className="text-sm">
          <strong>Do I need an A record?</strong> For a subdomain using external DNS, use a CNAME to
          CloudFront; no separate A record is needed. Do not use a fixed CloudFront IP address.
        </p>
        <p className="text-sm text-muted-foreground">
          For a root domain such as example.com, use your provider’s ALIAS/ANAME or CNAME
          flattening. Route 53 uses A and AAAA alias records, which Openship manages when hosted
          zone IDs are configured. In Cloudflare, select DNS only.
        </p>
        <p className="text-xs text-muted-foreground">
          The table shows full names. If your DNS provider appends the zone automatically, enter
          only the relative host (for example www in the example.com zone). Keep ACM validation
          CNAME records for certificate renewal.
        </p>
      </section>
      <section className="space-y-4 rounded-lg border border-border p-4">
        <div>
          <h4 className="font-medium">Publish website content from GitHub</h4>
          <p className="mt-1 text-sm text-muted-foreground">
            Creating an AWS site provisions infrastructure. Upload your built static website to
            publish content. An empty bucket can return AccessDenied.
          </p>
        </div>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>Clone your repository and check out the branch you want to deploy.</li>
          <li>Install dependencies and run the repository’s production build command.</li>
          <li>
            Upload the contents of the build output folder to S3. Place index.html at the bucket
            root. Vite commonly uses dist/; Next.js requires a static export and uses out/.
          </li>
          <li>Clear the CloudFront cache after uploading, then open your site.</li>
        </ol>
        {bucket && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Example: deploy an npm / Vite project</p>
            <p className="text-xs text-muted-foreground">
              Run locally or in GitHub Actions with an authorized AWS identity. Replace the
              repository URL, branch, and output folder to match your project.
            </p>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-6">{`git clone --branch YOUR_BRANCH YOUR_REPOSITORY_URL website
cd website
npm ci
npm run build
aws s3 sync ./dist/ s3://${bucket}/ --region us-east-1${
              site.outputs?.DistributionId
                ? `
aws cloudfront create-invalidation --distribution-id ${site.outputs.DistributionId} --paths "/*"`
                : ""
            }`}</pre>
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          For automatic deployment on pushes, run these build and upload steps in GitHub Actions.
          Authenticate with AWS OIDC and an IAM role restricted to your repository, this bucket, and
          this distribution. Grant only the required S3 upload/list and CloudFront invalidation
          permissions. Keep the bucket private.
        </p>
        <p className="text-xs text-muted-foreground">
          This is a deployment guide; repository builds and uploads are not run from this page.
          Server-rendered applications and APIs require a compute runtime.
        </p>
      </section>
    </div>
  );
}
