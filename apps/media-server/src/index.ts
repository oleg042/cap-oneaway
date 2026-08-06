import app from "./app";
import { abortAllJobs } from "./lib/job-manager";
import { cancelAllMediaOperations } from "./lib/media-operations";

const port = Number(process.env.PORT) || 3456;

console.log(`[media-server] Starting on port ${port}`);

let shuttingDown = false;

const shutdown = async () => {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log("[media-server] Shutting down...");
	const abortedJobs = await abortAllJobs();
	if (abortedJobs > 0) {
		console.log(`[media-server] Aborted ${abortedJobs} active jobs`);
	}
	await cancelAllMediaOperations();
	process.exit(0);
};

process.on("SIGINT", () => {
	void shutdown();
});
process.on("SIGTERM", () => {
	void shutdown();
});
process.on("SIGHUP", () => {
	void shutdown();
});

export default {
	port,
	// Bind IPv6 (::) so the service is reachable over Railway's IPv6-only private network
	// (cap-web -> cap-media-server.railway.internal). A dual-stack :: socket still accepts IPv4.
	hostname: process.env.HOST || "::",
	fetch: app.fetch,
};
