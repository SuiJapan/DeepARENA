import { handleOracleStatesPost } from "@/lib/server/predict/oracle-states";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
    return handleOracleStatesPost(request);
}
