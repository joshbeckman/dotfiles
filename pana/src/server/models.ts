// The model providers panad registers (INT-01): every built-in pi-ai provider whose credentials
// are present in panad's own environment. Model IDs are `provider/model-id`, as in
// `fireworks/accounts/fireworks/models/deepseek-v4p1-flash-1017`.
//
// Credentials are read from panad's environment only, through pi-ai's auth context. A session's
// `bash` never inherits that environment (ISO-03, ISO-04), and pana writes no key to disk.

import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

import { registerShopifyProvider } from "./shopify.ts";

export type ProviderEnv = Readonly<Record<string, string | undefined>>;

/**
 * Build the `Models` collection for panad from `env`. Providers without credentials are left
 * out, so `session create --model` names an unusable provider as `unknown_model` (400) instead
 * of failing the run later.
 */
export async function createProviderModels(env: ProviderEnv = process.env): Promise<MutableModels> {
	const models = createModels({
		authContext: {
			env: async (name) => {
				const value = env[name];
				return typeof value === "string" && value.trim().length > 0 ? value : undefined;
			},
			fileExists: async (path) => {
				try {
					await access(path.startsWith("~") ? homedir() + path.slice(1) : path);
					return true;
				} catch {
					return false;
				}
			},
		},
	});
	for (const provider of builtinProviders()) models.setProvider(provider);
	// Keep machine-specific provider code outside the public checkout's tracked files.
	const localModule = join(import.meta.dirname, "provider.local.ts");
	if (existsSync(localModule)) {
		const { registerLocalProvider } = (await import(localModule)) as {
			registerLocalProvider: (models: MutableModels, env: ProviderEnv) => void | Promise<void>;
		};
		await registerLocalProvider(models, env);
	}
	registerShopifyProvider(models, env);
	for (const provider of models.getProviders()) {
		const auth = await models.checkAuth(provider.id).catch(() => undefined);
		if (!auth) models.deleteProvider(provider.id);
	}
	return models;
}

/** Whether `name` (`provider/model-id`) is a model panad can run. */
export function hasModel(models: Pick<MutableModels, "getModel">, name: string): boolean {
	const slash = name.indexOf("/");
	if (slash <= 0) return false;
	return models.getModel(name.slice(0, slash), name.slice(slash + 1)) !== undefined;
}
