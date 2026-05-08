import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';

const files = fileURLToPath(new URL('./files', import.meta.url).href);

// Empty default WebSocket handler - subscribe/unsubscribe is handled
// by handler.js for ALL messages regardless of user handler.
const DEFAULT_WS_HANDLER = '// Built-in: subscribe/unsubscribe handled by the runtime\n';

/**
 * Scan a bundled WS handler for `upgradeResponse(..., { 'set-cookie': ... })`
 * usage. Emits a loud warning at build time because Cloudflare Tunnel and some
 * other strict edge proxies silently drop WebSocket connections whose 101
 * response carries Set-Cookie -- symptom is 1006 TCP FIN immediately after
 * open fires server-side. The recommended fix is the `authenticate` hook.
 *
 * @param {string} source
 * @returns {boolean}
 */
function detectSetCookieOnUpgrade(source) {
	// Scan each upgradeResponse( call for a 'set-cookie' / "Set-Cookie" literal
	// inside its arguments. Works against bundler output (esbuild/rollup/Vite),
	// which preserves these as literals even after minification rewrites the
	// surrounding identifiers.
	const re = /upgradeResponse\s*\(/gi;
	let match;
	while ((match = re.exec(source)) !== null) {
		// Walk forward matching parens to find the end of the call
		let depth = 1;
		let i = match.index + match[0].length;
		let inStr = '';
		let esc = false;
		for (; i < source.length && depth > 0; i++) {
			const c = source[i];
			if (esc) { esc = false; continue; }
			if (inStr) {
				if (c === '\\') esc = true;
				else if (c === inStr) inStr = '';
				continue;
			}
			if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
			if (c === '(') depth++;
			else if (c === ')') depth--;
		}
		const args = source.slice(match.index + match[0].length, i - 1);
		if (/['"`]\s*set-cookie\s*['"`]/i.test(args)) return true;
	}
	return false;
}

/** @type {import('./index.js').default} */
export default function (opts = {}) {
	const { out = 'build', precompress = true, envPrefix = '', healthCheckPath = '/healthz' } = opts;

	// Normalize websocket config: true -> {}, false/undefined -> null
	const websocket =
		opts.websocket === true
			? {}
			: opts.websocket || null;

	return {
		name: 'adapter-uws',

		async adapt(builder) {
			// Verify uWebSockets.js is installed - it's a native addon from GitHub,
			// so install failures are common and produce confusing runtime errors
			try {
				await import('uWebSockets.js');
			} catch {
				throw new Error(
					'Could not load uWebSockets.js. Make sure it is installed:\n' +
					'  npm install uNetworking/uWebSockets.js#v20.60.0\n\n' +
					'It is a native addon installed from GitHub (not npm) and may fail ' +
					'on some platforms. Check the uWebSockets.js README for details.'
				);
			}

			const tmp = builder.getBuildDirectory('adapter-uws');

			builder.rimraf(out);
			builder.rimraf(tmp);
			builder.mkdirp(tmp);

			builder.log.minor('Copying assets');
			builder.writeClient(`${out}/client${builder.config.kit.paths.base}`);
			builder.writePrerendered(`${out}/prerendered${builder.config.kit.paths.base}`);

			if (precompress) {
				builder.log.minor('Compressing assets');
				await Promise.all([
					builder.compress(`${out}/client`),
					builder.compress(`${out}/prerendered`)
				]);
			}

			builder.log.minor('Building server');

			builder.writeServer(tmp);

			writeFileSync(
				`${tmp}/manifest.js`,
				[
					`export const manifest = ${builder.generateManifest({ relativePath: './' })};`,
					`export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});`,
					`export const base = ${JSON.stringify(builder.config.kit.paths.base)};`
				].join('\n\n')
			);

			// Write the WebSocket handler module
			if (websocket) {
				// If the Vite plugin was used, ws-handler.js is already in the
				// writeServer output - built through the same Vite pipeline as
				// hooks.server.ts, with $lib/$env/$app resolved and shared modules.
				if (existsSync(`${tmp}/ws-handler.js`)) {
					builder.log.minor('WebSocket handler: built by Vite plugin');
				} else {
					// Vite plugin not installed - resolve handler ourselves
					let handlerFile = websocket.handler;

					if (!handlerFile) {
						const candidates = ['src/hooks.ws.js', 'src/hooks.ws.ts', 'src/hooks.ws.mjs'];
						for (const candidate of candidates) {
							if (existsSync(candidate)) {
								handlerFile = candidate;
								break;
							}
						}
					}

					if (handlerFile) {
						// Bundle through esbuild to resolve SvelteKit aliases and handle TS.
						// This is the fallback path - the Vite plugin is preferred because
						// it shares modules with the server bundle (no duplication).
						const esbuild = await import('esbuild');
						const { loadEnv } = await import('vite');
						const libDir = path.resolve(builder.config.kit.files?.lib || 'src/lib');
						const publicPrefix = builder.config.kit.env?.publicPrefix ?? 'PUBLIC_';
						const allEnv = loadEnv('production', process.cwd(), '');
						const version = builder.config.kit.version?.name ?? '';

						const aliasMap = { '$lib': libDir };
						const kitAliases = builder.config.kit.alias;
						if (kitAliases) {
							for (const [key, value] of Object.entries(kitAliases)) {
								if (!(key in aliasMap)) {
									aliasMap[key] = path.resolve(value);
								}
							}
						}

						await esbuild.build({
							entryPoints: [path.resolve(handlerFile)],
							bundle: true,
							format: 'esm',
							platform: 'node',
							outfile: `${tmp}/ws-handler.js`,
							alias: aliasMap,
							packages: 'external',
							plugins: [{
								name: 'sveltekit-virtual-modules',
								setup(build) {
									build.onResolve({ filter: /^\$(env|app)\// }, (args) => ({
										path: args.path,
										namespace: 'sveltekit'
									}));
									build.onLoad({ filter: /.*/, namespace: 'sveltekit' }, (args) => {
										if (args.path === '$app/environment') {
											return { contents: `export const dev = false;\nexport const building = false;\nexport const version = ${JSON.stringify(version)};` };
										}
										const isPublic = args.path.includes('/public');
										const isStatic = args.path.includes('/static');
										if (!isStatic) {
											if (isPublic) {
												return { contents: `export const env = new Proxy(process.env, { get(t, k) { return typeof k === 'string' && k.startsWith(${JSON.stringify(publicPrefix)}) ? t[k] : undefined; }, ownKeys(t) { return Object.keys(t).filter(k => k.startsWith(${JSON.stringify(publicPrefix)})); }, has(t, k) { return typeof k === 'string' && k.startsWith(${JSON.stringify(publicPrefix)}) && k in t; }, getOwnPropertyDescriptor(t, k) { if (typeof k === 'string' && k.startsWith(${JSON.stringify(publicPrefix)}) && k in t) return { value: t[k], enumerable: true, configurable: true }; return undefined; } });` };
											}
											return { contents: 'export const env = process.env;' };
										}
										const entries = Object.entries(allEnv).filter(([k]) =>
											(isPublic ? k.startsWith(publicPrefix) : !k.startsWith(publicPrefix))
											&& /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k)
										);
										return { contents: entries.map(([k, v]) => `export const ${k} = ${JSON.stringify(v)};`).join('\n') || 'export {};' };
									});
								}
							}]
						});
						builder.log.minor(`WebSocket handler: ${handlerFile} (esbuild fallback)`);
						builder.log.warn(
							'Add the Vite plugin to share modules between hooks.ws and the server bundle:\n' +
							"  import uws from 'svelte-adapter-uws/vite';\n" +
							'  export default { plugins: [sveltekit(), uws()] };'
						);
					} else {
						// No handler found - use built-in default (subscribe/unsubscribe only)
						writeFileSync(`${tmp}/ws-handler.js`, DEFAULT_WS_HANDLER);
						builder.log.minor('WebSocket enabled (built-in handler)');
					}
				}
			} else {
				// No WebSocket - empty module
				writeFileSync(`${tmp}/ws-handler.js`, '// No WebSocket handler configured\n');
			}

			const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

			/** @type {Record<string, string>} */
			const input = {
				index: `${tmp}/index.js`,
				manifest: `${tmp}/manifest.js`,
				'ws-handler': `${tmp}/ws-handler.js`
			};

			if (builder.hasServerInstrumentationFile?.()) {
				input['instrumentation.server'] = `${tmp}/instrumentation.server.js`;
			}

			// Include extra entry files written by Vite plugins (e.g. __live-registry.js).
			// Only picks up __-prefixed files to avoid bundling SvelteKit internals.
			const knownEntries = new Set(Object.values(input).map(f => path.basename(f)));
			/** @type {string[]} */
			const extraEntries = [];
			for (const file of readdirSync(tmp)) {
				if (file.startsWith('__') && file.endsWith('.js') && !knownEntries.has(file)) {
					const name = file.replace(/\.js$/, '');
					input[name] = `${tmp}/${file}`;
					extraEntries.push(name);
				}
			}

			// Bundle the Vite output so that deployments only need
			// their production dependencies. Anything in devDependencies
			// will get included in the bundled code.
			const bundle = await rollup({
				input,
				external: [
					// dependencies could have deep exports, so we need a regex
					...Object.keys(pkg.dependencies || {}).map((d) => new RegExp(`^${d}(\\/.*)?$`)),
					// uWebSockets.js must stay external - it's a native addon
					/^uWebSockets\.js$/
				],
				plugins: [
					nodeResolve({
						preferBuiltins: true,
						exportConditions: ['node']
					}),
					commonjs({ strictRequires: true }),
					json()
				]
			});

			await bundle.write({
				dir: `${out}/server`,
				format: 'esm',
				sourcemap: true,
				chunkFileNames: 'chunks/[name]-[hash].js'
			});

			// WebSocket config - serialized as globals for the runtime template
			const wsPath = websocket?.path ?? '/ws';
			if (wsPath[0] !== '/') {
				throw new Error(
					`websocket.path must start with '/' - got '${wsPath}'. ` +
					`Use '/${wsPath}' instead.`
				);
			}
			const wsAuthPath = websocket?.authPath ?? '/__ws/auth';
			if (wsAuthPath[0] !== '/') {
				throw new Error(
					`websocket.authPath must start with '/' - got '${wsAuthPath}'. ` +
					`Use '/${wsAuthPath}' instead.`
				);
			}
			if (wsAuthPath === wsPath) {
				throw new Error(
					`websocket.authPath ('${wsAuthPath}') must differ from websocket.path ('${wsPath}').`
				);
			}
			const wsOpts = {
				// Default raised from 16 KB to 1 MB in next.19. Aligns with
				// socket.io's default and Cloudflare Workers' WS message
				// cap, both 1 MB. uWS itself defaults to 16 MB; 16 KB was
				// excessively conservative and forced chunked-upload
				// frameworks to use ~12 KB chunks. DoS exposure is bounded
				// by `upgradeAdmission.maxConcurrent` (connection count)
				// and `maxBackpressure` (per-conn outbound queue, also
				// 1 MB), so per-frame cost stays predictable. Apps that
				// want a stricter cap can pin via
				// `websocket.maxPayloadLength` in svelte.config.js.
				maxPayloadLength: websocket?.maxPayloadLength ?? 1024 * 1024,
				idleTimeout: websocket?.idleTimeout ?? 120,
				maxBackpressure: websocket?.maxBackpressure ?? 1024 * 1024,
				sendPingsAutomatically: websocket?.sendPingsAutomatically ?? true,
				compression: websocket?.compression ?? false,
				allowedOrigins: websocket?.allowedOrigins ?? 'same-origin',
				upgradeTimeout: websocket?.upgradeTimeout ?? 10,
				upgradeRateLimit: websocket?.upgradeRateLimit ?? 10,
				upgradeRateLimitWindow: websocket?.upgradeRateLimitWindow ?? 10,
				upgradeAdmission: websocket?.upgradeAdmission,
				pressure: websocket?.pressure
			};

			// Scan the bundled WS handler for `upgradeResponse(..., { 'set-cookie': ... })`
			// and warn loudly. Cloudflare Tunnel and some other strict edge proxies
			// silently close WebSocket connections whose 101 response carries
			// Set-Cookie (1006 TCP FIN immediately after the server-side open fires).
			if (websocket && existsSync(`${tmp}/ws-handler.js`)) {
				try {
					const handlerSrc = readFileSync(`${tmp}/ws-handler.js`, 'utf8');
					if (detectSetCookieOnUpgrade(handlerSrc)) {
						builder.log.warn(
							'[adapter-uws] Your upgrade() hook attaches Set-Cookie to the 101 response ' +
							'via upgradeResponse(). This fails silently behind Cloudflare Tunnel, ' +
							"Cloudflare's proxy, and some other strict edge proxies: the WebSocket " +
							'opens, then closes with code 1006 before any frames are exchanged.\n' +
							'\n' +
							'Migrate to the `authenticate` hook to refresh session cookies over a ' +
							'normal HTTP response that works behind every proxy:\n' +
							'\n' +
							'  export function authenticate({ cookies }) {\n' +
							"    const session = validateSession(cookies.get('session'));\n" +
							'    if (!session) return false;\n' +
							"    cookies.set('session', renewSession(session), { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });\n" +
							'  }\n' +
							'\n' +
							'Then opt in from the client: connect({ auth: true }).\n' +
							'This warning is safe to ignore if you do not deploy behind Cloudflare.'
						);
					}
				} catch {
					// Scanner is best-effort; ignore IO errors
				}
			}

			builder.copy(files, out, {
				replace: {
					ENV: './env.js',
					HANDLER: './handler.js',
					MANIFEST: './server/manifest.js',
					SERVER: './server/index.js',
					SHIMS: './shims.js',
					WS_HANDLER: './server/ws-handler.js',
					ENV_PREFIX: JSON.stringify(envPrefix),
					PRECOMPRESS: JSON.stringify(precompress),
					WS_ENABLED: JSON.stringify(!!websocket),
					WS_PATH: JSON.stringify(wsPath),
					WS_OPTIONS: JSON.stringify(wsOpts),
					WS_AUTH_PATH: JSON.stringify(wsAuthPath),
					HEALTH_CHECK_PATH: JSON.stringify(healthCheckPath)
				}
			});

			// Import discovered __-prefixed entries so they execute at startup
			if (extraEntries.length > 0) {
				const entryImports = extraEntries
					.map(name => `import './server/${name}.js';`)
					.join('\n');
				const indexPath = `${out}/index.js`;
				const indexContent = readFileSync(indexPath, 'utf8');
				writeFileSync(indexPath, entryImports + '\n' + indexContent);
				builder.log.minor(`Extra entries: ${extraEntries.join(', ')}`);
			}

			if (builder.hasServerInstrumentationFile?.()) {
				builder.instrument?.({
					entrypoint: `${out}/index.js`,
					instrumentation: `${out}/server/instrumentation.server.js`,
					module: {
						exports: ['host', 'port']
					}
				});
			}
		},

		supports: {
			read: () => true,
			instrumentation: () => true
		},

		emulate() {
			return {
				platform() {
					// Vite plugin sets this when installed. Wrap with a fresh
					// requestId per call - Kit invokes platform() once per
					// dev request, but without access to the request itself,
					// so X-Request-ID is not honoured in dev (production
					// reads the header).
					if (globalThis.__uws_dev_platform) {
						const clone = Object.create(globalThis.__uws_dev_platform);
						clone.requestId = randomUUID();
						return clone;
					}

					// No Vite plugin - if WebSocket isn't configured, that's fine
					if (!websocket) return undefined;

					// WebSocket IS configured but plugin is missing - return a
					// helpful proxy that throws only when actually used
					const msg =
						'WebSocket platform not available in dev. Add the Vite plugin to your vite.config.js:\n\n' +
						"  import uws from 'svelte-adapter-uws/vite';\n" +
						'  export default { plugins: [sveltekit(), uws()] };';
					return new Proxy(/** @type {any} */ ({}), {
						get(_, prop) {
							if (typeof prop === 'symbol' || prop === 'then') return undefined;
							throw new Error(msg);
						}
					});
				}
			};
		}
	};
}
