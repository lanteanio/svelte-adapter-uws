import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';

const files = fileURLToPath(new URL('./files', import.meta.url).href);

// Empty default WebSocket handler - subscribe/unsubscribe is handled
// by handler.js for ALL messages regardless of user handler.
const DEFAULT_WS_HANDLER = '// Built-in: subscribe/unsubscribe handled by the runtime\n';

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
				// Resolve the handler: explicit path > auto-discovered > built-in default
				let handlerFile = websocket.handler;

				if (!handlerFile) {
					// Auto-discover src/hooks.ws.{js,ts,mjs}
					const candidates = ['src/hooks.ws.js', 'src/hooks.ws.ts', 'src/hooks.ws.mjs'];
					for (const candidate of candidates) {
						if (existsSync(candidate)) {
							handlerFile = candidate;
							break;
						}
					}
				}

				if (handlerFile) {
					// Bundle through esbuild to resolve SvelteKit aliases ($lib, $env, $app)
					// and handle TypeScript. Without this, these imports survive into
					// the Rollup step which doesn't know about SvelteKit virtual modules.
					const esbuild = await import('esbuild');
					const { loadEnv } = await import('vite');
					const libDir = path.resolve(builder.config.kit.files?.lib || 'src/lib');
					const publicPrefix = builder.config.kit.env?.publicPrefix ?? 'PUBLIC_';
					const allEnv = loadEnv('production', process.cwd(), '');
					const version = builder.config.kit.version?.name ?? '';

					await esbuild.build({
						entryPoints: [path.resolve(handlerFile)],
						bundle: true,
						format: 'esm',
						platform: 'node',
						outfile: `${tmp}/ws-handler.js`,
						alias: { '$lib': libDir },
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
									const entries = Object.entries(allEnv).filter(([k]) =>
										(isPublic ? k.startsWith(publicPrefix) : !k.startsWith(publicPrefix))
										&& /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k)
									);
									if (isStatic) {
										return { contents: entries.map(([k, v]) => `export const ${k} = ${JSON.stringify(v)};`).join('\n') || 'export {};' };
									}
									// dynamic: read from process.env at runtime
									return { contents: entries.map(([k]) => `export const ${k} = process.env[${JSON.stringify(k)}];`).join('\n') || 'export {};' };
								});
							}
						}]
					});
					builder.log.minor(`WebSocket handler: ${handlerFile}`);
				} else {
					// No handler found - use built-in default (subscribe/unsubscribe only)
					writeFileSync(`${tmp}/ws-handler.js`, DEFAULT_WS_HANDLER);
					builder.log.minor('WebSocket enabled (built-in handler)');
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
			const wsOpts = {
				maxPayloadLength: websocket?.maxPayloadLength ?? 16 * 1024,
				idleTimeout: websocket?.idleTimeout ?? 120,
				maxBackpressure: websocket?.maxBackpressure ?? 1024 * 1024,
				sendPingsAutomatically: websocket?.sendPingsAutomatically ?? true,
				compression: websocket?.compression ?? false,
				allowedOrigins: websocket?.allowedOrigins ?? 'same-origin',
				upgradeTimeout: websocket?.upgradeTimeout ?? 10
			};

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
					HEALTH_CHECK_PATH: JSON.stringify(healthCheckPath)
				}
			});

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
					// Vite plugin sets this when installed
					if (globalThis.__uws_dev_platform) {
						return globalThis.__uws_dev_platform;
					}

					// No Vite plugin - if WebSocket isn't configured, that's fine
					if (!websocket) return undefined;

					// WebSocket IS configured but plugin is missing - return a
					// helpful proxy that throws only when actually used
					const msg =
						'WebSocket platform not available in dev. Add the Vite plugin to your vite.config.js:\n\n' +
						"  import uwsDev from 'svelte-adapter-uws/vite';\n" +
						'  export default { plugins: [sveltekit(), uwsDev()] };';
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
