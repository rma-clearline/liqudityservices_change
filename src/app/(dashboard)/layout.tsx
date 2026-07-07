import { AlertsBanner, DataStatusProvider } from "@/components/freshness";
import { Tabs } from "@/components/tabs";
import { getSession } from "@/lib/auth/dal";

// Shared chrome for every tab. Layouts preserve state across navigation, so
// DataStatusProvider fetches /api/data-status once and the freshness badges +
// alerts banner stay populated as you switch tabs.
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  return (
    <main className="px-6 py-10">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold mb-1">LQDT Analytics</h1>
          <p className="text-gray-500 text-sm">
            Liquidity Services — marketplace &amp; auction GMV, quarterly revenue forecast, and federal/state procurement activity
          </p>
        </div>
        {session && (
          <div className="flex shrink-0 items-center gap-3 text-sm">
            <span className="hidden text-gray-500 sm:inline">{session.email}</span>
            <form action="/api/auth/logout" method="post">
              <button
                type="submit"
                className="rounded-md border border-gray-300 px-3 py-1.5 font-medium text-gray-700 transition-colors hover:bg-gray-50"
              >
                Sign out
              </button>
            </form>
          </div>
        )}
      </header>
      <DataStatusProvider>
        <Tabs />
        <AlertsBanner />
        {children}
      </DataStatusProvider>
    </main>
  );
}
