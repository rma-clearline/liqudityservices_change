import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { useAzureData } from "@/lib/data-backend";
import { azFetchListings } from "@/lib/azure-tables";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (useAzureData()) {
      return NextResponse.json(await azFetchListings());
    }
    const { data, error } = await supabase
      .from("listings")
      .select("*")
      .order("date", { ascending: false })
      .order("timestamp", { ascending: false });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
