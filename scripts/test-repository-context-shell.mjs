/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Repository Context Workbench contributors.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const repositoryRoot = process.cwd();
const applicationPath = process.env.REPOSITORY_CONTEXT_APP_PATH ??
	join(repositoryRoot, '..', 'VSCode-darwin-arm64', 'Repository Context Workbench.app');
const executablePath = join(applicationPath, 'Contents', 'MacOS', 'Repository Context');

function runGit(cwd, args) {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
	}
}

async function reservePort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	const port = address.port;
	await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	return port;
}

async function waitForCdp(port, child) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`Application exited before CDP was ready with code ${child.exitCode}.`);
		}

		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (response.ok) {
				return;
			}
		} catch {
			// The endpoint is not ready yet.
		}

		await new Promise(resolve => setTimeout(resolve, 100));
	}

	throw new Error('Timed out waiting for the packaged application CDP endpoint.');
}

async function stopApplication(child) {
	if (child.exitCode !== null) {
		return;
	}

	child.kill('SIGTERM');
	await Promise.race([
		new Promise(resolve => child.once('exit', resolve)),
		new Promise(resolve => setTimeout(resolve, 5_000)),
	]);

	if (child.exitCode === null) {
		child.kill('SIGKILL');
	}
}

async function main() {
	assert.ok(existsSync(executablePath), `Packaged application not found at ${executablePath}`);

	const temporaryBase = process.env.REPOSITORY_CONTEXT_SMOKE_TMPDIR ?? '/tmp';
	const temporaryRoot = await mkdtemp(join(temporaryBase, 'repository-context-smoke-'));
	const fixturePath = join(temporaryRoot, 'fixture');
	const userDataPath = join(temporaryRoot, 'profile');
	const extensionsPath = join(temporaryRoot, 'extensions');
	const sharedDataPath = join(temporaryRoot, 'shared');
	const applicationLog = [];
	let browser;
	let child;
	let page;

	try {
		await Promise.all([
			mkdir(fixturePath),
			mkdir(userDataPath),
			mkdir(extensionsPath),
			mkdir(sharedDataPath),
		]);
		runGit(fixturePath, ['init', '-b', 'main']);
		runGit(fixturePath, ['config', 'user.name', 'Repository Context Smoke']);
		runGit(fixturePath, ['config', 'user.email', 'smoke@example.invalid']);
		await writeFile(join(fixturePath, 'README.md'), '# Repository Context Smoke\n');
		runGit(fixturePath, ['add', 'README.md']);
		runGit(fixturePath, ['commit', '-m', 'Initial fixture']);
		await appendFile(join(fixturePath, 'README.md'), '\nModified in the working tree.\n');

		const cdpPort = await reservePort();
		child = spawn(executablePath, [
			`--user-data-dir=${userDataPath}`,
			`--extensions-dir=${extensionsPath}`,
			`--shared-data-dir=${sharedDataPath}`,
			`--remote-debugging-port=${cdpPort}`,
			'--disable-workspace-trust',
			'--use-mock-keychain',
			`--folder-uri=${pathToFileURL(fixturePath).toString()}`,
		], {
			env: { ...process.env, TMPDIR: temporaryRoot },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		child.stdout.on('data', chunk => applicationLog.push(chunk.toString()));
		child.stderr.on('data', chunk => applicationLog.push(chunk.toString()));

		await waitForCdp(cdpPort, child);
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
		page = browser.contexts().flatMap(context => context.pages())
			.find(candidate => candidate.url().includes('/workbench/workbench'));
		assert.ok(page, 'Workbench page was not exposed through CDP.');

		const consoleErrors = [];
		page.on('console', message => {
			if (message.type() === 'error') {
				consoleErrors.push(message.text());
			}
		});
		page.on('pageerror', error => consoleErrors.push(error.message));

		await page.getByRole('tablist', { name: 'Active View Switcher' }).waitFor();
		await page.getByRole('treeitem', { name: 'README.md, Modified' }).waitFor();
		await page.getByRole('treeitem', { name: /Initial fixture/ }).waitFor();

		assert.equal(await page.getByRole('tab').count(), 3);
		assert.equal(await page.getByRole('tab', { name: /^Source Control/ }).count(), 1);
		assert.equal(await page.getByRole('tab', { name: 'Skills' }).count(), 1);
		assert.equal(await page.getByRole('tab', { name: 'Integrations' }).count(), 1);
		assert.equal(await page.getByRole('button', { name: 'Generate Commit Message' }).count(), 0);
		assert.equal(await page.getByRole('button', { name: /^(Agents|Chat|Accounts|Manage)$/ }).count(), 0);

		await page.getByRole('button', { name: 'Switch Repository' }).click();
		await page.getByRole('option', { name: /check fixture,/ }).waitFor();
		assert.equal(await page.getByRole('option', { name: /Open Existing Repository/ }).count(), 1);
		assert.equal(await page.getByRole('option', { name: /Clone Repository/ }).count(), 1);
		assert.equal(await page.getByRole('option', { name: /Initialize Repository/ }).count(), 1);
		await page.keyboard.press('Escape');

		await page.keyboard.press('Meta+N');
		await page.keyboard.press('Meta+Shift+P');
		await page.keyboard.press('Control+Backquote');
		await page.keyboard.press('F5');
		const shellState = await page.evaluate(() => {
			const isVisible = element => {
				if (!(element instanceof HTMLElement)) {
					return false;
				}
				const style = getComputedStyle(element);
				return style.display !== 'none' && style.visibility !== 'hidden' && element.getBoundingClientRect().height > 0;
			};
			return {
				title: document.title,
				editorIsEmpty: Boolean(document.querySelector('.editor-group-container.empty')),
				quickInputIsVisible: isVisible(document.querySelector('.quick-input-widget')),
				terminalIsVisible: Array.from(document.querySelectorAll('.terminal-wrapper')).some(isVisible),
				panelIsVisible: isVisible(document.querySelector('.part.panel')),
			};
		});
		assert.equal(shellState.editorIsEmpty, true, JSON.stringify(shellState));
		assert.equal(shellState.quickInputIsVisible, false, JSON.stringify(shellState));
		assert.equal(shellState.terminalIsVisible, false, JSON.stringify(shellState));
		assert.equal(shellState.panelIsVisible, false, JSON.stringify(shellState));
		assert.match(shellState.title, /fixture/);
		assert.doesNotMatch(shellState.title, /Untitled/);
		assert.equal(await page.getByRole('dialog').count(), 0);
		assert.equal(consoleErrors.length, 0, consoleErrors.join('\n'));
		assert.doesNotMatch(applicationLog.join(''), /AgentHostProcessManager: agent host started/);

		console.log('Repository Context packaged shell smoke test passed.');
	} catch (error) {
		if (page) {
			console.error(await page.locator('body').ariaSnapshot().catch(() => 'Unable to capture accessibility snapshot.'));
		}
		if (applicationLog.length > 0) {
			console.error(applicationLog.join(''));
		}
		throw error;
	} finally {
		await browser?.close().catch(() => undefined);
		if (child) {
			await stopApplication(child);
		}
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

await main();
