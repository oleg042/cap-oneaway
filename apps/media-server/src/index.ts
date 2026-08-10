import os from "node:os";
import app from "./app";
import { abortAllJobs, getSystemResources } from "./lib/job-manager";
import { cancelAllMediaOperations } from "./lib/media-operations";

const port = Number(process.env.PORT) || 3456;

console.log(`[media-server] Starting on port ${port}`);

// Boot diagnostic: report the container's REAL CPU/memory budget (cgroup-derived) so FFmpeg -threads
// can be sized to the box instead of guessed. os.cpus() = raw host cores (over-reports in a container);
// getSystemResources().cpuCapacity/effectiveMax reflect the actual container allotment + concurrency cap.
try {
	console.log(
		`[media-server] boot-resources: hostCores=${os.cpus().length} ${JSON.stringify(getSystemResources())}`,
	);
} catch (err) {
	console.log(
		`[media-server] boot-resources: unavailable (${(err as Error)?.message})`,
	);
}

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
