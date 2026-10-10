import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					ANTHROPIC_API_KEY: "test-key",
					DEXTER_PASSPHRASE: "correct horse battery staple",
					NTFY_TOPIC: "dexter-test-topic",
				},
			},
		}),
	],
	test: { include: ["test/**/*.test.ts"] },
});
