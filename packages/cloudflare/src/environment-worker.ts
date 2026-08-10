import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";

export { ContainerProxy } from "@cloudflare/sandbox";

export class Sandbox extends CloudflareSandbox {
  override enableInternet = false;
  override interceptHttps = true;
  override entrypoint = [
    "/bin/sh",
    "-lc",
    "cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cloudflare-containers-ca.crt && update-ca-certificates && exec /container-server/sandbox",
  ];
}

export * from "./environment-do.ts";
export * from "./environment-runtime.ts";
