"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { awsApi, type AwsSite, type AwsSiteInput } from "@/lib/api/aws";
import { credentialsApi } from "@/lib/api/credentials";
import { getApiErrorMessage } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { AwsSiteDetails } from "./aws-site-details";

export function AwsSitesManager({ detail }: { detail?: { account: string; name: string } }) {
  const router = useRouter();
  const [accounts, setAccounts] = useState<string[]>(detail ? [detail.account] : []);
  const [account, setAccount] = useState(detail?.account ?? "");
  const [sites, setSites] = useState<AwsSite[]>([]);
  const [selected, setSelected] = useState<AwsSite | null>(null);
  const [input, setInput] = useState<AwsSiteInput>({ name: "", spa: false });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (detail) {
      setAccounts([detail.account]);
      return;
    }
    let live = true;
    credentialsApi
      .list()
      .then(({ data }) => {
        if (!live) return;
        const ids = [
          ...new Set(
            data
              .filter((c) => c.provider === "aws" && c.status === "active")
              .map((c) => c.selector)
              .filter((s): s is string => !!s),
          ),
        ];
        setAccounts(ids);
        setAccount(ids[0] ?? "");
      })
      .catch((e) => {
        if (live) setError(getApiErrorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [detail?.account]);
  useEffect(() => {
    setSelected(null);
    setSites([]);
    setEditing(false);
    setInput({ name: "", spa: false });
    if (!account) return;
    let live = true;
    if (detail) {
      awsApi
        .get(account, detail.name)
        .then(({ data }) => {
          if (live) setSelected(data);
        })
        .catch((e) => {
          if (live) setError(getApiErrorMessage(e));
        });
      return () => {
        live = false;
      };
    }
    awsApi
      .list(account)
      .then(({ data }) => {
        if (live) setSites(data);
      })
      .catch((e) => {
        if (live) setError(getApiErrorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [account, detail?.name]);
  async function run(action: () => Promise<unknown>, message = "") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(message);
    } catch (e) {
      setError(getApiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    setSites((await awsApi.list(account)).data);
    if (selected) setSelected((await awsApi.get(account, selected.name)).data);
  }
  useEffect(() => {
    if (
      !selected ||
      busy ||
      (!selected.status.endsWith("_IN_PROGRESS") &&
        selected.certificateStatus !== "PENDING_VALIDATION")
    )
      return;
    let live = true;
    const timer = window.setTimeout(() => {
      awsApi
        .get(account, selected.name)
        .then(({ data }) => {
          if (live) setSelected(data);
        })
        .catch((e) => {
          if (live) setError(getApiErrorMessage(e));
        });
    }, 15000);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [account, selected, busy]);
  useEffect(() => {
    if (selected)
      setSites((current) =>
        current.map((site) =>
          site.name === selected.name ? { ...site, status: selected.status } : site,
        ),
      );
  }, [selected]);
  const fieldClass = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";
  return (
    <section className="space-y-5 rounded-xl border border-border p-5">
      <div>
        {detail ? (
          <Link href="/aws-sites" className="text-sm underline">
            ← All AWS sites
          </Link>
        ) : (
          <h2 className="text-lg font-medium">AWS sites</h2>
        )}
        <p className="text-sm text-muted-foreground">
          {detail
            ? `AWS account ${detail.account} · US East (N. Virginia)`
            : "Create and manage private S3 storage with CloudFront and HTTPS. Resources are created in US East (N. Virginia)."}
        </p>
        <Link className="text-sm underline" href="/settings?tab=credentials">
          Connect an AWS account in Credentials
        </Link>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {!accounts.length ? (
        <p className="text-sm text-muted-foreground">Connect an AWS credential to get started.</p>
      ) : (
        <>
          {!detail && (
            <label className="block text-sm">
              AWS account
              <select
                className={fieldClass}
                value={account}
                disabled={busy}
                onChange={(e) => setAccount(e.target.value)}
              >
                {accounts.map((id) => (
                  <option key={id}>{id}</option>
                ))}
              </select>
            </label>
          )}
          {(!detail || editing) && (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                const value = {
                  ...input,
                  domains: (input.domains ?? []).map((entry) => ({
                    hostname: entry.hostname.trim(),
                    hostedZoneId: entry.hostedZoneId?.trim() || undefined,
                  })),
                };
                void run(async () => {
                  if (editing) await awsApi.update(account, value);
                  else await awsApi.create(account, value);
                  setSites((await awsApi.list(account)).data);
                  if (detail) {
                    setSelected((await awsApi.get(account, value.name)).data);
                    setEditing(false);
                  } else
                    router.push(
                      `/aws-sites/${encodeURIComponent(account)}/${encodeURIComponent(value.name)}`,
                    );
                }, "Request accepted. Refresh to follow provisioning progress.");
              }}
            >
              <h3 className="font-medium">{editing ? "Update site" : "Create site"}</h3>
              <label className="block text-sm">
                Site name
                <input
                  className={fieldClass}
                  required
                  pattern="[a-z][a-z0-9-]{1,39}"
                  maxLength={40}
                  value={input.name}
                  disabled={editing || busy}
                  onChange={(e) => setInput({ ...input, name: e.target.value })}
                />
              </label>
              <fieldset className="space-y-3" disabled={busy}>
                <legend className="text-sm font-medium">Custom domains (optional)</legend>
                <p className="text-xs text-muted-foreground">
                  Add up to 10 domains. All domains serve the same site. Keep the first domain as
                  your primary URL.
                </p>
                {(input.domains ?? []).map((entry, index) => (
                  <div key={index} className="space-y-2 rounded border border-border p-3">
                    <label className="block text-sm">
                      Domain {index + 1}
                      <input
                        className={fieldClass}
                        required
                        maxLength={253}
                        placeholder="www.example.com"
                        value={entry.hostname}
                        onChange={(e) =>
                          setInput({
                            ...input,
                            domains: input.domains!.map((item, i) =>
                              i === index ? { ...item, hostname: e.target.value } : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="block text-sm">
                      Route 53 hosted zone ID for domain {index + 1} (optional)
                      <input
                        className={fieldClass}
                        placeholder="Z0123456789"
                        value={entry.hostedZoneId ?? ""}
                        onChange={(e) =>
                          setInput({
                            ...input,
                            domains: input.domains!.map((item, i) =>
                              i === index ? { ...item, hostedZoneId: e.target.value } : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        setInput({
                          ...input,
                          domains: input.domains!.filter((_, i) => i !== index),
                        })
                      }
                    >
                      Remove domain {index + 1}
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="ghost"
                  disabled={(input.domains?.length ?? 0) >= 10}
                  onClick={() =>
                    setInput({ ...input, domains: [...(input.domains ?? []), { hostname: "" }] })
                  }
                >
                  Add domain
                </Button>
              </fieldset>
              <p className="text-xs text-muted-foreground">
                Provide a Route 53 zone ID for every domain to automate DNS, or leave all zone IDs
                empty for manual DNS with Cloudflare or another provider. Add the certificate
                validation records shown below, then point your domain to CloudFront. Root domains
                require your provider's apex routing support.
              </p>
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!input.spa}
                  onChange={(e) => setInput({ ...input, spa: e.target.checked })}
                />
                Single-page application fallback to index.html
              </label>
              <p className="text-xs text-muted-foreground">
                Creating resources incurs AWS charges. Deleting a site retains its bucket and
                uploaded data.
              </p>
              <Button type="submit" disabled={busy}>
                {busy ? "Working…" : editing ? "Apply changes" : "Create AWS site"}
              </Button>
              {editing && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setEditing(false);
                    setInput({ name: "", spa: false });
                  }}
                >
                  Cancel editing
                </Button>
              )}
            </form>
          )}
          {!detail && (
            <>
              <div className="flex items-center justify-between">
                <h3 className="font-medium">Managed sites</h3>
                <Button variant="ghost" disabled={busy} onClick={() => void run(refresh)}>
                  Refresh
                </Button>
              </div>
              {!sites.length && (
                <p className="text-sm text-muted-foreground">No managed sites in this account.</p>
              )}
              {sites.map((site) => (
                <Link
                  key={site.name}
                  href={`/aws-sites/${encodeURIComponent(account)}/${encodeURIComponent(site.name)}`}
                  className="flex w-full items-center justify-between rounded-lg border border-border p-4 text-sm hover:bg-muted/50"
                >
                  <span className="font-medium">{site.name}</span>
                  <span className="text-muted-foreground">
                    {site.status.toLowerCase().replaceAll("_", " ")} →
                  </span>
                </Link>
              ))}
            </>
          )}
          {detail && !selected && !error && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading site details…
            </p>
          )}
          {selected && (
            <div className="space-y-3 border-t border-border pt-4">
              <AwsSiteDetails
                site={selected}
                busy={busy}
                onVerify={() =>
                  void run(async () => {
                    setSelected((await awsApi.get(account, selected.name)).data);
                  }, "Latest status loaded from AWS.")
                }
              />
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" disabled={busy} onClick={() => void run(refresh)}>
                  Refresh status
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    const config = selected.configuration ?? { name: selected.name };
                    setInput({
                      name: config.name,
                      spa: config.spa,
                      domains:
                        config.domains ??
                        (config.domain
                          ? [{ hostname: config.domain, hostedZoneId: config.hostedZoneId }]
                          : []),
                    });
                    setEditing(true);
                    setNotice("");
                  }}
                >
                  Edit configuration
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy || !selected.outputs?.DistributionId}
                  onClick={() =>
                    void run(
                      () => awsApi.invalidate(account, selected.name),
                      "Cache invalidation requested.",
                    )
                  }
                >
                  Clear CDN cache
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete ${selected.name}? CloudFront, certificate and managed Route 53 records will be removed. The S3 bucket and its data will be retained and may continue to incur charges.`,
                      )
                    ) {
                      void run(async () => {
                        await awsApi.remove(account, selected.name);
                        router.push("/aws-sites");
                      }, "Deletion requested. S3 bucket retained.");
                    }
                  }}
                >
                  Delete site
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
