import test from 'ava';
import {Agent} from 'undici';
import {
	createProxiedFetch,
	getProxyDispatcher,
	isNoProxyMatch,
	shouldUseProxy,
} from './proxy-config.js';

/**
 * Snapshot and restore the proxy-related env so tests cannot leak state —
 * this module reads the environment on every call.
 */
async function withProxyEnv(
	env: Record<string, string | undefined>,
	run: () => void | Promise<void>,
): Promise<void> {
	const keys = [
		'HTTP_PROXY',
		'http_proxy',
		'HTTPS_PROXY',
		'https_proxy',
		'NO_PROXY',
		'no_proxy',
	];
	const saved = new Map<string, string | undefined>();
	for (const key of keys) {
		saved.set(key, process.env[key]);
		if (env[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = env[key];
		}
	}
	try {
		await run();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

test('shouldUseProxy returns false when no proxy env is set', async t => {
	await withProxyEnv({}, () => {
		t.false(shouldUseProxy('https://api.openai.com/v1'));
		t.is(getProxyDispatcher(), undefined);
	});
});

test('shouldUseProxy returns true for remote hosts when HTTPS_PROXY is set', async t => {
	await withProxyEnv({HTTPS_PROXY: 'http://192.0.2.1:8889'}, () => {
		t.true(shouldUseProxy('https://api.openai.com/v1'));
		t.true(shouldUseProxy('https://models.dev/api.json'));
		t.truthy(getProxyDispatcher());
	});
});

test('shouldUseProxy honors lowercase proxy spellings', async t => {
	await withProxyEnv({https_proxy: 'http://192.0.2.1:8889'}, () => {
		t.true(shouldUseProxy('https://api.openai.com/v1'));
	});
});

test('shouldUseProxy never proxies loopback hosts (Ollama stays direct)', async t => {
	await withProxyEnv(
		{
			HTTPS_PROXY: 'http://192.0.2.1:8889',
			HTTP_PROXY: 'http://192.0.2.1:8889',
		},
		() => {
			t.false(shouldUseProxy('http://localhost:11434'));
			t.false(shouldUseProxy('http://127.0.0.1:11434'));
			t.false(shouldUseProxy('http://0.0.0.0:1234'));
			t.false(shouldUseProxy('http://[::1]:11434'));
		},
	);
});

test('shouldUseProxy honors NO_PROXY entries', async t => {
	await withProxyEnv(
		{
			HTTPS_PROXY: 'http://192.0.2.1:8889',
			NO_PROXY: 'localhost,127.0.0.1,.internal.example.com',
		},
		() => {
			t.false(shouldUseProxy('https://internal.example.com/v1'));
			t.false(shouldUseProxy('https://sub.internal.example.com/v1'));
			t.true(shouldUseProxy('https://api.openai.com/v1'));
		},
	);
});

test('shouldUseProxy respects NO_PROXY=*', async t => {
	await withProxyEnv(
		{HTTPS_PROXY: 'http://192.0.2.1:8889', NO_PROXY: '*'},
		() => {
			t.false(shouldUseProxy('https://api.openai.com/v1'));
		},
	);
});

test('isNoProxyMatch mirrors undici semantics: exact vs suffix', async t => {
	await withProxyEnv({}, () => {
		// Exact entries do not match subdomains (undici behaviour).
		process.env.NO_PROXY = 'example.com';
		t.true(isNoProxyMatch('sub.example.com'));
		t.false(isNoProxyMatch('example.com'));

		// Leading-dot entries match the domain and its subdomains (the
		// common curl/requests reading of NO_PROXY).
		process.env.NO_PROXY = '.example.com';
		t.false(isNoProxyMatch('sub.example.com'));
		t.false(isNoProxyMatch('example.com'));
		process.env.NO_PROXY = '*.example.com';
		t.false(isNoProxyMatch('sub.example.com'));

		// Port-qualified entries only match that port.
		process.env.NO_PROXY = 'example.com:443';
		t.false(isNoProxyMatch('example.com', 443));
		t.true(isNoProxyMatch('example.com', 8443));
	});
});

test('getProxyDispatcher rebuilds when the proxy env changes', async t => {
	await withProxyEnv({HTTPS_PROXY: 'http://192.0.2.1:8889'}, () => {
		const first = getProxyDispatcher();
		t.truthy(first);
		process.env.HTTPS_PROXY = 'http://198.51.100.1:9999';
		const second = getProxyDispatcher();
		t.truthy(second);
		t.not(first, second);
		// Same env → same cached agent.
		t.is(second, getProxyDispatcher());
	});
});

test('createProxiedFetch falls back to the base dispatcher with no proxy env', async t => {
	await withProxyEnv({}, async () => {
		const baseAgent = new Agent();
		const fetchFn = createProxiedFetch(baseAgent);
		t.is(typeof fetchFn, 'function');
	});
});
