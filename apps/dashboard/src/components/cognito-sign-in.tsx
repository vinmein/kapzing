"use client";
import { useState, type FormEvent } from "react";
import { getAuthBaseUrl } from "@/lib/api/urls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Challenge {
  authenticated: boolean;
  challenge?: string;
  requiredAttributes?: string[];
  mfaOptions?: string[];
  setupSecret?: string;
}
export function CognitoSignIn({
  callbackURL = "/",
  embedded = false,
}: {
  callbackURL?: string;
  embedded?: boolean;
}) {
  const [open, setOpen] = useState(embedded);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<Challenge | null>(null);
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [attributes, setAttributes] = useState<Record<string, string>>({});
  const [mfaType, setMfaType] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `${getAuthBaseUrl().replace(/\/$/, "")}/cognito/${step ? "challenge" : "sign-in"}`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            step
              ? {
                  code: code || undefined,
                  newPassword: newPassword || undefined,
                  attributes,
                  mfaType: mfaType || undefined,
                }
              : { username, password },
          ),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        setError(data.message || data.error || "Sign-in failed. Please try again.");
        if (data.code === "COGNITO_CHALLENGE_EXPIRED") {
          setStep(null);
          setPassword("");
          setNewPassword("");
          setCode("");
        }
        return;
      }
      setPassword("");
      setNewPassword("");
      setCode("");
      if (data.authenticated) {
        // Only return to this dashboard; external callback values are never followed.
        const target = new URL(callbackURL, window.location.origin);
        window.location.assign(target.origin === window.location.origin ? target.href : "/");
      } else {
        setStep(data);
        setMfaType(data.mfaOptions?.[0] ?? "");
      }
    } catch {
      setError("Could not reach the authentication server. Try again.");
    } finally {
      setBusy(false);
    }
  }
  if (!open)
    return (
      <Button
        type="button"
        variant="ghost"
        className="w-full bg-foreground/[0.04]"
        onClick={() => setOpen(true)}
      >
        Continue with AWS Cognito
      </Button>
    );
  return (
    <form
      onSubmit={submit}
      className={embedded ? "space-y-4" : "space-y-3 rounded-xl border border-border p-4"}
    >
      {!embedded && <h3 className="text-sm font-medium">Authenticate using AWS Cognito</h3>}
      {!step && (
        <>
          <label className="block text-sm">
            Username or email
            <Input
              autoComplete="username"
              required
              value={username}
              disabled={busy}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            Password
            <Input
              autoComplete="current-password"
              type="password"
              required
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        </>
      )}
      {step?.challenge === "NEW_PASSWORD_REQUIRED" && (
        <>
          <p className="text-sm text-muted-foreground">
            Choose a new password to complete your first sign-in.
          </p>
          <label className="block text-sm">
            New password
            <Input
              type="password"
              autoComplete="new-password"
              required
              value={newPassword}
              disabled={busy}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </label>
          {step.requiredAttributes?.map((key) => (
            <label key={key} className="block text-sm">
              {key}
              <Input
                required
                value={attributes[key] ?? ""}
                disabled={busy}
                onChange={(e) => setAttributes({ ...attributes, [key]: e.target.value })}
              />
            </label>
          ))}
        </>
      )}
      {step?.challenge === "SELECT_MFA_TYPE" && (
        <label className="block text-sm">
          Verification method
          <select
            className="w-full rounded border border-border bg-background p-2"
            required
            value={mfaType}
            onChange={(e) => setMfaType(e.target.value)}
          >
            {step.mfaOptions?.map((method) => (
              <option key={method} value={method}>
                {method === "SOFTWARE_TOKEN_MFA"
                  ? "Authenticator app"
                  : method === "EMAIL_OTP"
                    ? "Email code"
                    : "SMS code"}
              </option>
            ))}
          </select>
        </label>
      )}
      {step?.setupSecret && (
        <div className="text-sm">
          <p>Add this setup key to your authenticator app, then enter its code.</p>
          <code className="block break-all rounded bg-muted p-2">{step.setupSecret}</code>
        </div>
      )}
      {step && !["NEW_PASSWORD_REQUIRED", "SELECT_MFA_TYPE"].includes(step.challenge ?? "") && (
        <label className="block text-sm">
          {step.challenge === "SOFTWARE_TOKEN_MFA" || step.challenge === "MFA_SETUP"
            ? "Authenticator code"
            : "Verification code"}
          <Input
            autoComplete="one-time-code"
            inputMode="numeric"
            required
            value={code}
            disabled={busy}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy} className={embedded ? "w-full" : undefined}>
          {busy ? "Signing in…" : step ? "Continue" : "Sign in"}
        </Button>
        {(!embedded || step) && (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setOpen(embedded);
              setStep(null);
              setPassword("");
              setNewPassword("");
              setCode("");
              setAttributes({});
              setError("");
            }}
          >
            {embedded ? "Start again" : "Cancel"}
          </Button>
        )}
      </div>
    </form>
  );
}
