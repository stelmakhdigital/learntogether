import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	server: {
		port: 5173,
		// Same-origin for the app API: the dev server forwards /api to the
		// application server, so the browser never crosses an origin.
		proxy: {
			"/api": {
				rewrite: (path: string) => path.replace(/^\/api/, ""),
				target: "http://127.0.0.1:8765",
			},
		},
	},
});
