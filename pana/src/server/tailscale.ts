// The machine's tailnet name, for API-05. Tailscale Serve proxies `https://<name>` to panad's
// loopback port and keeps that name in the Host header, so panad must accept it.
//
// Detected at start rather than configured, as agent-mail-web does: the tailnet DNS name can
// change, and a stale name in config would be a 403 on the phone that nobody sees. A machine
// without tailscale, or with it stopped, stays loopback-only.

import { execFile } from "node:child_process";

export function detectTailscaleNames(command = "tailscale"): Promise<string[]> {
	return new Promise((resolve) => {
		execFile(command, ["status", "--json"], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
			if (error) return resolve([]);
			try {
				const status = JSON.parse(stdout) as { Self?: { DNSName?: unknown } };
				const name = typeof status.Self?.DNSName === "string" ? status.Self.DNSName.replace(/\.$/, "") : "";
				resolve(name ? [name.toLowerCase()] : []);
			} catch {
				resolve([]);
			}
		});
	});
}
