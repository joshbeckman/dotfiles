// WP20: observability. The logs panad writes, and what they add up to.
//
// `src/server/log.ts` writes one line per request (SRV-01). This package reads that file and the
// client log (OBS-03) back as counts, errors, and percentiles, serves them at `GET /stats/requests`,
// and holds the writer for the PWA's own samples.

export { appendClientSamples, clientLine, clientSamples, CLIENT_BATCH_MAX, CLIENT_DURATION_MAX_MS, CLIENT_NAME_MAX, type ClientSample } from "./client.ts";
export { readLogTail, STATS_READ_BYTES, type LogTail } from "./log.ts";
export {
	bucketOf,
	parseClientLines,
	parseRequestLines,
	parseSince,
	percentile,
	selectRequests,
	summarizeClientFile,
	summarizeRequests,
	summarizeRequestsFile,
	CLIENT_KINDS,
	type Bucket,
	type ClientBucket,
	type ClientEntry,
	type ClientKind,
	type ClientSummary,
	type ClientSummaryOptions,
	type RequestEntry,
	type RequestSummary,
	type RequestSummaryOptions,
	type RouteBucket,
	type WindowInfo,
} from "./summary.ts";
