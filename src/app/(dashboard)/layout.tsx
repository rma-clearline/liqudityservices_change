import { AlertsBanner, DataStatusProvider } from "@/components/freshness";
import { Tabs } from "@/components/tabs";

// Shared chrome for every tab. Layouts preserve state across navigation, so
// DataStatusProvider fetches /api/data-status once and the freshness badges +
// alerts banner stay populated as you switch tabs.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="px-6 py-10">
      <header className="mb-4">
        <h1 className="text-2xl font-bold mb-1">LQDT Analytics</h1>
        <p className="text-gray-500 text-sm">
          Liquidity Services — marketplace &amp; auction GMV, quarterly revenue forecast, and federal/state procurement activity
        </p>
      </header>
      <DataStatusProvider>
        <Tabs />
        <AlertsBanner />
        {children}
      </DataStatusProvider>
    </main>
  );
}
