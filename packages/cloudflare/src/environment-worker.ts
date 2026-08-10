import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";

export { ContainerProxy } from "@cloudflare/sandbox";

export class Sandbox extends CloudflareSandbox {
  override enableInternet = false;
  override interceptHttps = true;
  override allowedHosts = ["*.r2.cloudflarestorage.com"];
  override entrypoint = [
    "/bin/sh",
    "-lc",
    "if [ -f /etc/cloudflare/certs/cloudflare-containers-ca.crt ]; then cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/ && update-ca-certificates; fi; exec /container-server/sandbox",
  ];
}

export * from "./environment-do.ts";
export * from "./environment-runtime.ts";
