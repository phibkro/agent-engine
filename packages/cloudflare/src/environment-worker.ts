import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";

export { ContainerProxy } from "@cloudflare/sandbox";

export class Sandbox extends CloudflareSandbox {
  override enableInternet = false;
  override interceptHttps = true;
}

export * from "./environment-do.ts";
export * from "./environment-runtime.ts";
