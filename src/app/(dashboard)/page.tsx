import { ListingsView } from "@/components/listings-view";
import { getListings } from "@/lib/dashboard-data";

export const dynamic = "force-dynamic";

export default async function ListingsPage() {
  const listings = await getListings();
  return <ListingsView listings={listings} />;
}
