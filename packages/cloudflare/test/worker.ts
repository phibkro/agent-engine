import { ProjectDurableObject } from "../src/authority.ts";

export { ProjectDurableObject };

export default {
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    return new Response("not found", { status: 404 });
  },
};
