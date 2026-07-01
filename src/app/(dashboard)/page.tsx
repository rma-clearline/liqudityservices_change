import { supabase } from "@/lib/supabase";
import type { ListingRow } from "@/lib/supabase";
import { ListingsView } from "@/components/listings-view";

export const dynamic = "force-dynamic";

export default async function ListingsPage() {
  const { data } = await supabase
    .from("listings")
    .select("*")
    .order("date", { ascending: false })
    .order("timestamp", { ascending: false });

  return <ListingsView listings={(data ?? []) as ListingRow[]} />;
}
