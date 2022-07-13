import fs from 'fs';
import http from 'http';
import * as ports from 'port-authority';
import { test as base, devices } from '@playwright/test';

export const test = base.extend({
	app: async ({ page }, use) => {
		// these are assumed to have been put in the global scope by the layout
		use({
			/**
			 * @param {string} url
			 * @param {{ replaceState?: boolean }} opts
			 * @returns {Promise<void>}
			 */
			goto: (url, opts) =>
				page.evaluate(
					(/** @type {{ url: string, opts: { replaceState?: boolean } }} */ { url, opts }) =>
						goto(url, opts),
					{ url, opts }
				),

			/**
			 * @param {string} url
			 * @returns {Promise<void>}
			 */
			invalidate: (url) => page.evaluate((/** @type {string} */ url) => invalidate(url), url),

			/**
			 * @param {(url: URL) => void | boolean | Promise<void | boolean>} fn
			 * @returns {Promise<void>}
			 */
			beforeNavigate: (fn) =>
				page.evaluate((/** @type {(url: URL) => any} */ fn) => beforeNavigate(fn), fn),

			/**
			 * @returns {Promise<void>}
			 */
			afterNavigate: () => page.evaluate(() => afterNavigate(() => {})),

			/**
			 * @param {string} url
			 * @returns {Promise<void>}
			 */
			prefetch: (url) => page.evaluate((/** @type {string} */ url) => prefetch(url), url),

			/**
			 * @param {string[]} [urls]
			 * @returns {Promise<void>}
			 */
			prefetchRoutes: (urls) =>
				page.evaluate((/** @type {string[]} */ urls) => prefetchRoutes(urls), urls)
		});
	},

	clicknav: async ({ page, javaScriptEnabled }, use) => {
		/**
		 * @param {string} selector
		 * @param {{ timeout: number }} options
		 */
		async function clicknav(selector, options) {
			if (javaScriptEnabled) {
				await Promise.all([page.waitForNavigation(options), page.click(selector)]);
			} else {
				await page.click(selector);
			}
		}

		use(clicknav);
	},

	in_view: async ({ page }, use) => {
		/** @param {string} selector */
		async function in_view(selector) {
			const box = await page.locator(selector).boundingBox();
			const view = await page.viewportSize();
			return box && view && box.y < view.height && box.y + box.height > 0;
		}

		use(in_view);
	},

	page: async ({ page, javaScriptEnabled }, use) => {
		if (javaScriptEnabled) {
			page.addInitScript({
				content: `
					addEventListener('sveltekit:start', () => {
						document.body.classList.add('started');
					});
				`
			});
		}

		// automatically wait for kit started event after navigation functions if js is enabled
		const page_navigation_functions = ['goto', 'goBack', 'reload'];
		page_navigation_functions.forEach((fn) => {
			// @ts-ignore
			const page_fn = page[fn];
			if (!page_fn) {
				throw new Error(`function does not exist on page: ${fn}`);
			}
			// @ts-ignore
			page[fn] = async function (...args) {
				const res = await page_fn.call(page, ...args);
				if (javaScriptEnabled) {
					/**
					 * @type {Promise<any>[]}
					 */
					const page_ready_conditions = [page.waitForSelector('body.started', { timeout: 5000 })];
					if (process.env.DEV && fn !== 'goBack') {
						// if it is an spa back, there is no new connect
						page_ready_conditions.push(wait_for_vite_connected_message(page, 5000));
					}
					await Promise.all(page_ready_conditions);
				}
				return res;
			};
		});

		await use(page);
	},

	// eslint-disable-next-line
	read_errors: ({}, use) => {
		/** @param {string} path */
		function read_errors(path) {
			const errors =
				fs.existsSync('test/errors.json') &&
				JSON.parse(fs.readFileSync('test/errors.json', 'utf8'));
			return errors[path];
		}

		use(read_errors);
	}
});
const test_browser = process.env.KIT_E2E_BROWSER ?? 'chromium';
const known_devices = {
	chromium: devices['Desktop Chrome'],
	firefox: devices['Desktop Firefox'],
	safari: devices['Desktop Safari']
};

// @ts-expect-error indexed access
const test_browser_device = known_devices[test_browser];

if (!test_browser_device) {
	throw new Error(
		`invalid test browser specified: KIT_E2E_BROWSER=${
			process.env.KIT_E2E_BROWSER
		}. Allowed values: ${Object.keys(known_devices).join(', ')}`
	);
}

const port = 3000;

/** @type {import('@playwright/test').PlaywrightTestConfig} */
export const config = {
	forbidOnly: !!process.env.CI,
	// generous timeouts on CI
	timeout: process.env.CI ? 45000 : 15000,
	webServer: {
		command: process.env.DEV
			? `npm run dev -- --port ${port}`
			: `npm run build && npm run preview -- --port ${port}`,
		port
	},
	retries: process.env.CI ? 5 : 0,
	projects: [
		{
			name: `${test_browser}-${process.env.DEV ? 'dev' : 'build'}+js`,
			use: {
				javaScriptEnabled: true
			}
		},
		{
			name: `${test_browser}-${process.env.DEV ? 'dev' : 'build'}-js`,
			use: {
				javaScriptEnabled: false
			}
		}
	],
	use: {
		...test_browser_device,
		screenshot: 'only-on-failure',
		trace: process.env.KIT_E2E_TRACE ? 'retain-on-failure' : 'on-first-retry'
	},
	workers: process.env.CI ? 2 : undefined
};

/**
 * @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler
 * @param {number} [start]
 */
export async function start_server(handler, start = 4000) {
	const port = await ports.find(start);
	const server = http.createServer(handler);

	await new Promise((fulfil) => {
		server.listen(port, 'localhost', () => {
			fulfil(undefined);
		});
	});

	return {
		port,
		close: () => {
			return new Promise((fulfil, reject) => {
				server.close((err) => {
					if (err) {
						reject(err);
					} else {
						fulfil(undefined);
					}
				});
			});
		}
	};
}

export const plugin = process.env.CI
	? (await import('../dist/vite.js')).sveltekit
	: (await import('../src/vite/index.js')).sveltekit;

/**
 * wait for the vite client to log "[vite] connected." on browser console
 *
 * @param page {import('@playwright/test').Page}
 * @param timeout {number}
 * @returns {Promise<void>}
 */
async function wait_for_vite_connected_message(page, timeout) {
	// remove once https://github.com/microsoft/playwright/issues/15550 is fixed/released
	if (process.env.KIT_E2E_BROWSER === 'firefox') {
		// crude wait instead of checking the console
		return new Promise((resolve) => setTimeout(resolve, 100));
	}
	// @ts-ignore
	return page.waitForEvent('console', {
		predicate: async (message) => message?.text()?.includes('[vite] connected.'),
		timeout
	});
}
