import { ProjectMemoryDurableObject, SessionDurableObject } from "../src/index.ts";

export { ProjectMemoryDurableObject, SessionDurableObject };

export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/health") return Response.json({ status: "ok" });
    return Response.json({ _tag: "NotFound" }, { status: 404 });
  },
};
