import { v1Route } from "@/server/v1/route";

export const maxDuration = 300;

export const POST = v1Route("createRun");
export const GET = v1Route("listRuns");
