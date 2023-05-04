import { Gauge, register } from "prom-client";
import { createServer } from "http";
import { QBittorrent } from "@ctrl/qbittorrent";

if (process.env.QBIT_URL === undefined) throw new Error("QBIT_URL environment variable not set");
const listenPort = process.env.LISTEN_PORT ?? 3001;

const client = new QBittorrent({
	baseUrl: process.env.QBIT_URL,
	username: process.env.QBIT_USER ?? "",
	password: process.env.QBIT_PASS ?? "",
});

console.log(`Creating metric plex_device_bytes_used...`);
const metricInfo = [
	// Speed
	["dlspeed", "dl_speed_bytes", "Download speed (bytes/s)"],
	["upspeed", "up_speed_bytes", "Upload speed (bytes/s)"],
	// Seeds/Leeches
	["num_complete", "seeders_total", "Number of seeds in the swarm"],
	["num_incomplete", "leechers_total", "Number of leechers in the swarm"],
	["num_seeds", "seeders_connected", "Number of seeds connected to"],
	["num_leechs", "leechers_connected", "Number of leechers connected to"],
	// General
	["ratio", "ratio", "Share ratio"],
	["progress", "percent_complete", "Torrent progress (percentage/100)"],
	// Bytes
	["downloaded", "dl_total_bytes", "Downloaded bytes"],
	["uploaded", "up_total_bytes", "Uploaded bytes"],
	["amount_left", "bytes_left", "Bytes left to download"],
	// Times
	["last_activity", "last_activity", "Last time a chunk was downloaded/uploaded", (n: number) => n * 1000],
	["seeding_time", "seeding_time", "Total seeding time", (n: number) => n * 1000],
	["eta", "eta", "Torrent ETA (seconds)", (n: number) => n * 1000],
] as const;

console.log("Creating metrics...");
const metrics = metricInfo.map(
	([key, metric, help, cast]) =>
		[
			key,
			new Gauge({
				name: `${process.env.PROMETHEUS_PREFIX ?? "qBit_"}${metric}`,
				help,
				labelNames: ["name", "tracker", "total_size", "added_on", "hash", "category", "tags", "state"] as const,
			}),
			cast,
		] as const
);

console.log(`Creating http server...`);
createServer(async (req, res) => {
	if (req.url === "/metrics") {
		const torrents = await client.listTorrents();

		metrics.forEach(([key, metric, cast]) => {
			metric.reset();
			torrents.forEach((t) => {
				const value = t[<Exclude<typeof key, "seeding_time">>key];
				metric.set(
					{
						name: t.name,
						tracker: t.tracker,
						total_size: t.total_size,
						added_on: t.added_on,
						hash: t.hash,
						category: t.category,
						tags: t.tags,
						state: t.state,
					},
					cast ? cast(value) : value
				);
			});
		});
		// Fetch and process the stats when the /metrics endpoint is called
		res.setHeader("Content-Type", register.contentType);
		res.end(await register.metrics());
	} else {
		res.statusCode = 404;
		res.end("Not found");
	}
}).listen(listenPort, () => console.log(`Server listening on port ${listenPort}`));
