/**
 * Proxy support for provider requests.
 *
 * Nanocoder's provider requests flow through undici dispatchers, which —
 * unlike Node's global fetch with `NODE_USE_ENV_PROXY=1` — ignore the
 * standard proxy environment variables. In sandboxed or corporate setups
 * where the only egress route is an HTTP(S) proxy (often one that injects
 * credentials for the provider host), that bypass meant direct connections
 * that fail with 401s or time out entirely.
 *
 * This module reads `HTTPS_PROXY`/`https_proxy`, `HTTP_PROXY`/`http_proxy`
 * and `NO_PROXY`/`no_proxy` and builds an undici `EnvHttpProxyAgent` that
 * mirrors their semantics (including per-request no_proxy matching, see
 * `isNoProxyMatch`). The agent is cached per environment fingerprint so a
 * mid-session change to the proxy variables takes effect on the next call.
 */
import {
	Agent,
	type Dispatcher,
	EnvHttpProxyAgent,
	fetch as undiciFetch,
} from 'undici';

/** Hostnames that must never be routed through a proxy. */
const LOCAL_HOSTNAMES = new Set([
	'localhost',
	'127.0.0.1',
	'0.0.0.0',
	'[::1]',
	'::1',
]);

function readProxyEnv(): {http: string | undefined; https: string | undefined} {
	return {
		// undici's EnvHttpProxyAgent reads the lowercase spellings first, so
		// mirror that precedence here for the "is a proxy configured" check.
		http: process.env.http_proxy ?? process.env.HTTP_PROXY,
		https: process.env.https_proxy ?? process.env.HTTPS_PROXY,
	};
}

/**
 * True when a proxy is configured via environment variables, and the host
 * is one Nanocoder should send through it. Loopback hosts are always
 * excluded: providers on localhost (Ollama, LM Studio, llama.cpp) are
 * reached directly even when a proxy is set, matching curl's behaviour.
 */
export function shouldUseProxy(url: string): boolean {
	const {http, https} = readProxyEnv();
	if (!http && !https) {
		return false;
	}

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		// Unparseable URLs are treated as remote so a broken value cannot
		// silently bypass a credential-injecting egress proxy.
		return true;
	}

	const hostname = parsedUrl.hostname.toLowerCase();
	if (LOCAL_HOSTNAMES.has(hostname)) {
		return false;
	}

	const port = parsedUrl.port
		? Number.parseInt(parsedUrl.port, 10)
		: parsedUrl.protocol === 'https:'
			? 443
			: 80;

	return isNoProxyMatch(hostname, port);
}

/**
 * NO_PROXY matching modelled on undici's EnvHttpProxyAgent: entries are
 * comma/space separated, may carry a `:port`, and match by exact hostname
 * or — when the entry starts with a dot or asterisk — by suffix. A leading
 * dot also excludes the bare domain itself (the common curl/requests
 * reading of NO_PROXY), which is the safe direction here: this check only
 * decides whether to hand the request to the proxy dispatcher, and undici
 * applies its own NO_PROXY rules on top.
 */
export function isNoProxyMatch(hostname: string, port?: number): boolean {
	const noProxy = process.env.no_proxy ?? process.env.NO_PROXY ?? '';
	if (!noProxy.trim()) {
		return true;
	}
	if (noProxy.trim() === '*') {
		return false;
	}

	const normalizedHost = hostname.toLowerCase();

	for (const rawEntry of noProxy.split(/[,\s]/)) {
		const entry = rawEntry.trim().toLowerCase();
		if (!entry) {
			continue;
		}

		const parsed = entry.match(/^(.+):(\d+)$/);
		const entryHost = parsed ? parsed[1] : entry;

		// Port-qualified entries only apply to that port (undici skips
		// entries whose port does not match).
		if (parsed && port !== undefined) {
			if (Number.parseInt(parsed[2], 10) !== port) {
				continue;
			}
		}

		if (!/^[.*]/.test(entryHost)) {
			// No wildcard: only an exact hostname match is excluded.
			if (normalizedHost === entryHost) {
				return false;
			}
		} else if (normalizedHost.endsWith(entryHost.replace(/^[.*]/, ''))) {
			return false;
		}
	}

	return true;
}

let cachedProxyAgent: EnvHttpProxyAgent | undefined;
let cachedProxyEnvKey = '';

function currentProxyEnvKey(): string {
	const {http, https} = readProxyEnv();
	if (!http && !https) {
		return '';
	}
	return `${https ?? ''}|${http ?? ''}`;
}

/**
 * Dispatcher for requests that should honor the proxy environment. Returns
 * `undefined` when no proxy is configured, so callers keep using their
 * existing agent unchanged (matching `NODE_USE_ENV_PROXY` semantics, where
 * plain environments behave exactly as before). Re-reads the environment on
 * every call and rebuilds the agent if the proxy variables changed.
 */
export function getProxyDispatcher(): Dispatcher | undefined {
	const envKey = currentProxyEnvKey();
	if (!envKey) {
		cachedProxyAgent = undefined;
		cachedProxyEnvKey = '';
		return undefined;
	}
	if (envKey !== cachedProxyEnvKey || !cachedProxyAgent) {
		cachedProxyAgent?.close().catch(() => {});
		cachedProxyAgent = new EnvHttpProxyAgent();
		cachedProxyEnvKey = envKey;
	}
	return cachedProxyAgent;
}

/**
 * Fetch wrapper for auxiliary provider requests (token refreshes, model
 * lists) that must take the same egress route as chat traffic. Uses the
 * proxy dispatcher for remote hosts and falls back to the given base
 * dispatcher (or a plain undici Agent) otherwise.
 */
export function createProxiedFetch(baseDispatcher?: Dispatcher): typeof fetch {
	const fallback = baseDispatcher ?? new Agent();
	return async (input, init) => {
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: input.url;
		const dispatcher = shouldUseProxy(url) ? getProxyDispatcher() : fallback;
		return undiciFetchWith(dispatcher, input, init);
	};
}

async function undiciFetchWith(
	dispatcher: Dispatcher | undefined,
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
): Promise<Response> {
	return undiciFetch(input as string | URL, {
		...((init ?? {}) as Record<string, unknown>),
		dispatcher,
	}) as unknown as Response;
}
