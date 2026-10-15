"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useToast } from "@/components/toast";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useAuthContext } from "../providers";
import { AuthShell } from "@/components/auth-shell";
import { CognitoSignIn } from "@/components/cognito-sign-in";
import { Button } from "@/components/ui/button";
import { Loader2, ExternalLink } from "lucide-react";
import { getApiBaseUrl } from "@/lib/api/client";
import { getApiOrigin } from "@/lib/api/urls";
import {
  clearZeroAuthAttempt,
  markZeroAuthAttempt,
  readZeroAuthAttempt,
  resolveZeroAuthLogin,
  type ZeroAuthDecision,
} from "@/lib/zero-auth";
import {
  buildDesktopAuthorizeUrl,
  getPostAuthRedirect,
  preparePkceFlow,
  startDesktopCloudAuth,
} from "@/lib/cloud-auth";

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <AuthShell>
          <div className="flex justify-center py-8">
            <div className="size-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          </div>
        </AuthShell>
      }
    >
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const { t } = useI18n();
  const { authMode, cloudAuthUrl } = useAuthContext();

  const isDesktop = typeof window !== "undefined" && !!window.desktop?.isDesktop;
  const handleBack = isDesktop
    ? () => {
        void window.desktop?.reset?.();
      }
    : undefined;

  const [loading, setLoading] = useState(false);

  const callbackError = searchParams.get("error");

  const postLoginUrl = getPostAuthRedirect(searchParams);

  // Zero-auth mode has no form — the page exists only to bounce the browser at
  // desktop-login. Decide that BEFORE navigating, so a browser the server will
  // never mint a session for is told why instead of being sent to its own
  // loopback address (#484).
  const zeroAuth = useMemo<ZeroAuthDecision>(() => {
    if (authMode !== "none") return { action: "wait" };
    return resolveZeroAuthLogin({
      pageOrigin: typeof window !== "undefined" ? window.location.origin : undefined,
      // The same base every other API call uses: correct under the single-port
      // proxy and on the desktop's dynamic port, both of which a target-table
      // lookup of window.location gets wrong.
      apiBaseUrl: getApiBaseUrl(),
      attemptedAt: readZeroAuthAttempt(),
      now: Date.now(),
    });
  }, [authMode]);

  useEffect(() => {
    if (zeroAuth.action !== "redirect") return;
    markZeroAuthAttempt(Date.now());
    window.location.href = zeroAuth.url;
  }, [zeroAuth]);

  async function handleCloudSignIn(callbackUrl: string) {
    if (!isDesktop || !window.desktop?.onboarding) {
      // Mint + stash a fresh PKCE verifier so cloud-callback can finish
      // a PKCE exchange instead of accepting a bearer code.
      const { state, codeChallenge } = await preparePkceFlow();
      const cloudLoginUrl = buildDesktopAuthorizeUrl({
        cloudAuthUrl,
        callbackUrl,
        state,
        codeChallenge,
      });
      window.location.href = cloudLoginUrl;
      return;
    }

    setLoading(true);
    try {
      const result = await startDesktopCloudAuth({ desktop: window.desktop });
      if (!result.ok) {
        toast(
          "error",
          result.reason === "start_failed"
            ? "Could not start cloud authentication."
            : "Authentication failed. Please try again.",
        );
        return;
      }
    } finally {
      setLoading(false);
    }
  }

  /* ── Zero-auth mode (desktop): auto-redirect to create session ── */
  if (authMode === "none") {
    if (zeroAuth.action === "explain") {
      const pageOrigin = typeof window !== "undefined" ? window.location.origin : "";
      return (
        <AuthShell onBack={handleBack}>
          <div className="text-center">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              {t.auth.zeroAuth.title}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {zeroAuth.reason === "remote_browser"
                ? interpolate(t.auth.zeroAuth.remoteBrowser, { origin: pageOrigin })
                : t.auth.zeroAuth.refused}
            </p>
          </div>

          <div className="mt-6 rounded-xl border border-warning-border bg-warning-bg p-4 text-start">
            <p className="text-sm text-warning">{t.auth.zeroAuth.remedy}</p>
            <code
              dir="ltr"
              className="mt-2 block rounded-md bg-background/60 px-2 py-1.5 font-mono text-xs text-foreground"
            >
              OPENSHIP_AUTH_MODE=local
            </code>
            <p className="mt-2 text-sm text-warning">{t.auth.zeroAuth.remedyAdmin}</p>
          </div>

          <Button
            variant="outline"
            className="mt-4 w-full"
            onClick={() => {
              clearZeroAuthAttempt();
              window.location.reload();
            }}
          >
            {t.auth.zeroAuth.retry}
          </Button>
        </AuthShell>
      );
    }
    // Redirecting (see the effect above) — or server-rendering, where there's no
    // origin to judge yet.
    return (
      <AuthShell>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      </AuthShell>
    );
  }

  /* ── Cloud mode (desktop): redirect to Openship Cloud for all auth ── */
  if (authMode === "cloud") {
    const apiUrl = getApiOrigin(typeof window !== "undefined" ? window.location.origin : undefined);
    const callbackUrl = `${apiUrl}/api/auth/cloud-callback`;
    // The actual cloud-authorize URL is built inside handleCloudSignIn so
    // PKCE state can be minted + stashed in localStorage just before the
    // redirect (must happen in a click handler, not render).

    return (
      <AuthShell onBack={handleBack}>
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            {t.auth.login.title}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in with your Openship account to continue.
          </p>
        </div>

        {callbackError && (
          <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {callbackError === "missing_code"
              ? "Authentication was cancelled."
              : callbackError === "missing_state"
                ? "Authentication request expired. Please try again."
                : "Authentication failed. Please try again."}
          </div>
        )}

        <Button
          className="w-full"
          size="lg"
          disabled={loading}
          onClick={() => {
            void handleCloudSignIn(callbackUrl);
          }}
        >
          {loading ? (
            <Loader2 className="me-2 size-4 animate-spin" />
          ) : (
            <ExternalLink className="me-2 size-4" />
          )}
          {loading ? "Opening Openship Cloud..." : "Sign in with Openship"}
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell onBack={handleBack}>
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t.auth.login.title}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">Authenticate using AWS Cognito.</p>
      </div>
      <CognitoSignIn callbackURL={postLoginUrl ?? "/"} embedded />
    </AuthShell>
  );
}
