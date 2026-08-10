import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";

export class Sandbox extends CloudflareSandbox {
  override enableInternet = false;
}

export * from "./environment-do.ts";
export * from "./environment-runtime.ts";
