import { defineConfig } from "vitest/config";

// The browser suite (`npm run test:web`) needs the installed Chrome and the chrome-devtools
// CLI. It is separate from `npm test`, which must pass without a browser.
export default defineConfig({
	test: {
		include: ["test/browser/**/*.spec.ts"],
		testTimeout: 180_000,
		hookTimeout: 60_000,
		// One CLI daemon and one Chrome page at a time; parallel files would fight over both.
		fileParallelism: false,
		sequence: { concurrent: false },
	},
});
