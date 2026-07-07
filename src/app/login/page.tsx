import { redirect } from "next/navigation";
import { allowedDomain } from "@/lib/auth/config";
import { getSession } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

export const metadata = { title: "Sign in — LQDT Analytics" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; returnTo?: string; signedout?: string }>;
}) {
  // Already signed in → straight to the app.
  if (await getSession()) redirect("/");

  const { error, returnTo, signedout } = await searchParams;
  const domain = allowedDomain();

  const errorMessage =
    error === "domain"
      ? `That account isn't a @${domain} address. Please sign in with your Clearline account.`
      : error === "cancelled"
        ? "Sign-in was cancelled. Please try again."
        : error === "session"
          ? "Your sign-in session expired. Please try again."
          : error === "config"
            ? "Sign-in isn't configured on the server yet. Contact an administrator."
            : error
              ? "Something went wrong during sign-in. Please try again."
              : null;

  const loginHref = `/api/auth/login${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`;

  return (
    <div className="flex min-h-full flex-1 items-center justify-center bg-gray-50 px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
          <h1 className="text-xl font-bold text-gray-900">LQDT Analytics</h1>
          <p className="mt-1 text-sm text-gray-500">
            Sign in to continue. Access is restricted to{" "}
            <span className="font-medium text-gray-700">@{domain}</span> accounts.
          </p>

          {errorMessage && (
            <p
              role="alert"
              className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {errorMessage}
            </p>
          )}

          {signedout && !errorMessage && (
            <p className="mt-4 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600">
              You've been signed out.
            </p>
          )}

          <a
            href={loginHref}
            className="mt-6 flex w-full items-center justify-center gap-3 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-800 transition-colors hover:bg-gray-50"
          >
            <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
              <rect x="1" y="1" width="9" height="9" fill="#F25022" />
              <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
              <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
              <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
            </svg>
            Continue with Microsoft
          </a>
        </div>
        <p className="mt-4 text-center text-xs text-gray-400">
          Liquidity Services (LQDT) tracker · Clearline Capital
        </p>
      </div>
    </div>
  );
}
