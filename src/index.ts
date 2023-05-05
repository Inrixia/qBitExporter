import { Gauge, register } from "prom-client";
import { createServer } from "http";
import { QBittorrent } from "@ctrl/qbittorrent";
import got from "got";

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
	["last_activity", "last_activity", "Last time a chunk was downloaded/uploaded"],
	["seeding_time", "seeding_time", "Total seeding time"],
	["eta", "eta", "Torrent ETA (seconds)"],
] as const;

console.log("Creating metrics...");
const metrics = metricInfo.map(
	([key, metric, help]) =>
		[
			key,
			new Gauge({
				name: `${process.env.PROMETHEUS_PREFIX ?? "qBit_"}${metric}`,
				help,
				labelNames: ["name", "tracker", "total_size", "added_on", "hash", "category", "tags", "state"] as const,
			}),
		] as const
);

type Peers = {
	peers: {
		[host: string]: {
			client: string;
			connection: string;
			country: string;
			country_code: string;
			dl_speed: number;
			downloaded: number;
			files: string;
			flags: string;
			flags_desc: string;
			ip: string;
			peer_id_client: string;
			port: number;
			progress: number;
			relevance: number;
			up_speed: number;
			uploaded: number;
		};
	};
};

const labelNames = ["country", "client", "ip", "port"] as const;
const peer_dl_speed = new Gauge({
	name: `${process.env.PROMETHEUS_PREFIX ?? "qBit_"}peer_dl_speed`,
	help: "Peer download speed (bytes/s)",
	labelNames,
});
const peer_dl_bytes = new Gauge({
	name: `${process.env.PROMETHEUS_PREFIX ?? "qBit_"}peer_dl_bytes`,
	help: "Peer downloaded bytes",
	labelNames,
});
const peer_up_speed = new Gauge({
	name: `${process.env.PROMETHEUS_PREFIX ?? "qBit_"}peer_up_speed`,
	help: "Peer upload speed (bytes/s)",
	labelNames,
});
const peer_up_bytes = new Gauge({
	name: `${process.env.PROMETHEUS_PREFIX ?? "qBit_"}peer_up_bytes`,
	help: "Peer uploaded bytes",
	labelNames,
});

console.log(`Creating http server...`);
createServer(async (req, res) => {
	if (req.url === "/metrics") {
		const torrents = await client.listTorrents();

		register.resetMetrics();

		await Promise.all(
			torrents.map(async (torrent) => {
				if (torrent.num_leechs + torrent.num_seeds > 0) {
					const { peers } = await got<Peers>(`${process.env.QBIT_URL}/api/v2/sync/torrentPeers?hash=${torrent.hash}`, {
						responseType: "json",
						resolveBodyOnly: true,
						https: { rejectUnauthorized: false },
					});
					for (const peer of Object.values(peers)) {
						const labels: { country: string; client?: string; ip: string; port: string } = {
							country: peer.country,
							ip: peer.ip.toString(),
							port: peer.port.toString(),
						};
						if (peer.client && peer.client !== "") labels.client = peer.client?.toString();
						peer_dl_bytes.inc(labels, peer.downloaded);
						peer_up_bytes.inc(labels, peer.uploaded);
						peer_dl_speed.inc(labels, peer.dl_speed);
						peer_up_speed.inc(labels, peer.up_speed);
					}
				}
				for (const [key, metric] of metrics) {
					const value = torrent[<Exclude<typeof key, "seeding_time">>key];
					metric.set(
						{
							name: torrent.name,
							tracker: torrent.tracker,
							total_size: torrent.total_size,
							added_on: torrent.added_on * 1000,
							hash: torrent.hash,
							category: torrent.category,
							tags: torrent.tags,
							state: torrent.state,
						},
						key === "last_activity" ? value * 1000 : value
					);
				}
			})
		);

		// Fetch and process the stats when the /metrics endpoint is called
		res.setHeader("Content-Type", register.contentType);
		res.end(await register.metrics());
	} else {
		res.statusCode = 404;
		res.end("Not found");
	}
}).listen(listenPort, () => console.log(`Server listening on port ${listenPort}`));
