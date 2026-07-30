import { NextResponse } from "next/server";
import { azFetchListings } from "@/lib/azure-tables";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await azFetchListings());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
