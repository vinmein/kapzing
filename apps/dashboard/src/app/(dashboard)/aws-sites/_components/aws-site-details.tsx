"use client";
import { useState } from "react";
import type { AwsSite } from "@/lib/api/aws";
import { Button } from "@/components/ui/button";
import { AwsSitePublishing } from "./aws-site-publishing";

function Status({ value }: { value: string }) {
  const pending = value.includes("IN_PROGRESS") || value === "PENDING_VALIDATION";
  const failed = /FAILED|ROLLBACK|EXPIRED|REVOKED/.test(value);
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${failed ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400" : pending ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}`}
    >
      {value.toLowerCase().replaceAll("_", " ")}
    </span>
  );
}
function DnsValue({ label, value }: { label: string; value: string }) {
  const [feedback, setFeedback] = useState("");
  return (
    <div className="space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-start gap-2 rounded-md bg-muted/60 p-2">
        <code className="min-w-0 flex-1 break-all text-xs leading-5">{value}</code>
        <button
          type="button"
          className="shrink-0 text-xs underline"
          aria-label={`Copy ${label}: ${value}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setFeedback("Copied");
            } catch {
              setFeedback("Select and copy the value");
            }
          }}
        >
          Copy
        </button>
      </div>
      {feedback && (
        <p role="status" className="text-xs text-muted-foreground">
          {feedback}
        </p>
      )}
    </div>
  );
}
export function AwsSiteDetails({
  site,
  busy,
  onVerify,
}: {
  site: AwsSite;
  busy: boolean;
  onVerify: () => void;
}) {
  const domains =
    site.configuration?.domains ??
    (site.configuration?.domain
      ? [{ hostname: site.configuration.domain, hostedZoneId: site.configuration.hostedZoneId }]
      : []);
  const pending = site.status.endsWith("_IN_PROGRESS");
  const validationPending = site.certificateStatus === "PENDING_VALIDATION";
  const records = [...new Map((site.validationRecords ?? []).map((r) => [r.Name, r])).values()];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Site overview</p>
          <h3 className="text-xl font-semibold">{site.name}</h3>
        </div>
        <Status value={site.status} />
      </div>
      {(pending || validationPending) && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">
            {validationPending ? "Waiting for domain verification" : "AWS is applying changes"}
          </p>
          <p className="mt-1 text-muted-foreground">
            {validationPending
              ? "Publish every CNAME below. Provisioning continues automatically after AWS validates all domains."
              : "CloudFront and other resources may take several minutes to finish."}{" "}
            Status refreshes automatically every 15 seconds while provisioning.
          </p>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="space-y-3 rounded-lg border border-border p-4">
          <h4 className="font-medium">Custom domains</h4>
          {domains.length ? (
            domains.map((d, i) => (
              <div
                key={d.hostname}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3 last:border-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="break-all text-sm font-medium">{d.hostname}</p>
                  <p className="text-xs text-muted-foreground">
                    {d.hostedZoneId ? `Route 53 · ${d.hostedZoneId}` : "Manual DNS"}
                    {i === 0 ? " · Primary URL" : ""}
                  </p>
                </div>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">Using the default CloudFront address.</p>
          )}
          {site.outputs?.Url && (
            <a
              href={site.outputs.Url}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-sm underline"
            >
              Open site ↗
            </a>
          )}
        </section>
        <section className="space-y-3 rounded-lg border border-border p-4">
          <h4 className="font-medium">HTTPS certificate</h4>
          {site.certificateStatus ? (
            <Status value={site.certificateStatus} />
          ) : (
            <p className="text-sm text-muted-foreground">No custom certificate available.</p>
          )}
          {validationPending && (
            <>
              <p className="text-sm text-muted-foreground">
                AWS checks DNS automatically. Verify validation fetches its latest status.
              </p>
              <Button type="button" variant="outline" disabled={busy} onClick={onVerify}>
                {busy ? "Checking…" : "Verify validation"}
              </Button>
            </>
          )}
        </section>
      </div>
      {!!records.length && (
        <section className="space-y-3">
          <div>
            <h4 className="font-medium">Certificate validation records</h4>
            <p className="text-sm text-muted-foreground">
              {validationPending
                ? "Add these CNAME records at your DNS provider. Keep them for automatic certificate renewal."
                : "Keep these CNAME records in DNS for automatic certificate renewal."}
            </p>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {records.map((r, i) => (
              <div key={r.Name} className="space-y-3 rounded-lg border border-border p-4">
                <p className="text-sm font-medium">
                  Validation record {i + 1}{" "}
                  <span className="ml-2 rounded bg-muted px-2 py-1 text-xs">{r.Type}</span>
                </p>
                <DnsValue label="DNS name / host" value={r.Name} />
                <DnsValue label="Target / value" value={r.Value} />
              </div>
            ))}
          </div>
        </section>
      )}
      {site.outputs?.CloudFrontDomain && (
        <section className="space-y-3 rounded-lg border border-border p-4">
          <h4 className="font-medium">Point your domains to CloudFront</h4>
          <p className="text-sm text-muted-foreground">
            For each manual DNS subdomain, add a CNAME to this target. With Cloudflare, use DNS-only
            mode. Root domains need ALIAS, ANAME, or CNAME flattening.
          </p>
          <DnsValue label="CloudFront target" value={site.outputs.CloudFrontDomain} />
        </section>
      )}
      <AwsSitePublishing site={site} />
      {!!site.resources?.length && (
        <section className="space-y-3">
          <h4 className="font-medium">Current resource status</h4>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-3 font-medium">Resource</th>
                  <th className="p-3 font-medium">Latest status</th>
                </tr>
              </thead>
              <tbody>
                {site.resources.map((r) => (
                  <tr key={r.logicalId} className="border-t border-border">
                    <td className="p-3">{r.logicalId}</td>
                    <td className="p-3">
                      <Status value={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <details className="rounded-lg border border-border p-4 text-sm">
        <summary className="cursor-pointer font-medium">Activity history</summary>
        <p className="my-3 text-xs text-muted-foreground">
          Past events are shown newest first. Earlier “in progress” entries remain after completion;
          use current resource status above to see what is still running.
        </p>
        <div className="space-y-3">
          {site.events?.map((e, i) => (
            <div
              key={i}
              className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3"
            >
              <div>
                <p>{e.resource}</p>
                <time className="text-xs text-muted-foreground">
                  {new Date(e.time).toLocaleString()}
                </time>
              </div>
              <Status value={e.status} />
            </div>
          ))}
        </div>
      </details>
      <details className="rounded-lg border border-border p-4 text-sm">
        <summary className="cursor-pointer font-medium">Infrastructure details</summary>
        <dl className="mt-3 space-y-2">
          {Object.entries(site.outputs ?? {}).map(([key, value]) => (
            <div key={key}>
              <dt className="text-xs text-muted-foreground">{key}</dt>
              <dd className="break-all font-mono text-xs">{value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
