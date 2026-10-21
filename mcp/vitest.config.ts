import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					DEXTER_PASSPHRASE: "correct horse battery staple",
					// A fixed, fake test key: the bytes 0..31. Never a real secret.
					BRIDGE_SECRET: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
				},
			},
		}),
	],
	test: { include: ["test/**/*.test.ts"] },
});
