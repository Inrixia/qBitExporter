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

const prefix = process.env.PROMETHEUS_PREFIX ?? "qBit_";

console.log(`Creating metric plex_device_bytes_used...`);
const metricInfo = [
	// Speed
	["dlspeed", "downSpeed", "Download speed (bytes/s)"],
	["upspeed", "upSpeed", "Upload speed (bytes/s)"],
	// Seeds/Leeches
	["num_complete", "seeders", "Number of seeds in the swarm"],
	["num_incomplete", "leechers", "Number of leechers in the swarm"],
	["num_seeds", "seedersConnected", "Number of seeds connected to"],
	["num_leechs", "leechersConnected", "Number of leechers connected to"],
	// General
	["ratio", "ratio", "Share ratio"],
	["progress", "progress", "Torrent precent done"],
	// Bytes
	["downloaded", "downloaded", "Downloaded bytes"],
	["uploaded", "uploaded", "Uploaded bytes"],
	["amount_left", "bytesLeft", "Bytes left to download"],
	// Times
	["last_activity", "lastActive", "Last time a chunk was downloaded/uploaded"],
	["seeding_time", "seedtime", "Total seeding time"],
	["eta", "eta", "Torrent ETA (seconds)"],
] as const;

console.log("Creating metrics...");
const metrics = metricInfo.map(
	([key, metric, help]) =>
		[
			key,
			new Gauge({
				name: `${prefix}${metric}`,
				help,
				labelNames: ["name", "tracker", "totalSize", "addedOn", "hash", "category", "tags", "state"] as const,
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
const peerPrefix = `peer_`;
const peer_dl_speed = new Gauge({
	name: `${prefix}${peerPrefix}downSpeed`,
	help: "Peer download speed (bytes/s)",
	labelNames,
});
const peer_dl_bytes = new Gauge({
	name: `${prefix}${peerPrefix}downloaded`,
	help: "Peer downloaded bytes",
	labelNames,
});
const peer_up_speed = new Gauge({
	name: `${prefix}${peerPrefix}upSpeed`,
	help: "Peer upload speed (bytes/s)",
	labelNames,
});
const peer_up_bytes = new Gauge({
	name: `${prefix}${peerPrefix}uploaded`,
	help: "Peer uploaded bytes",
	labelNames,
});
const peer_percent_complete = new Gauge({
	name: `${prefix}${peerPrefix}progress`,
	help: "Peer precent done",
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
						peer_percent_complete.inc(labels, peer.progress);
					}
				}
				for (const [key, metric] of metrics) {
					const value = torrent[<Exclude<typeof key, "seeding_time">>key];
					metric.set(
						{
							name: torrent.name,
							tracker: torrent.tracker,
							totalSize: torrent.total_size,
							addedOn: torrent.added_on * 1000,
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
