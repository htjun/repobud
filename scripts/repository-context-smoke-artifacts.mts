/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const maximumLogFiles = 50;
const maximumLogBytes = 2 * 1024 * 1024;

/**
 * Escapes a literal value for use in a regular expression.
 */
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redacts credentials and caller-provided sensitive values from diagnostic text.
 */
export function redactSmokeText(value, sensitiveValues = []) {
	let redacted = String(value ?? '');
	const exactValues = [...new Set(sensitiveValues.filter(Boolean))]
		.sort((left, right) => right.length - left.length);

	for (const sensitiveValue of exactValues) {
		redacted = redacted.replace(
			new RegExp(escapeRegExp(sensitiveValue), 'g'),
			sensitiveValue.includes('repository-context-smoke-') ? '$SMOKE_ROOT' : '[REDACTED]'
		);
	}

	return redacted
		.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
		.replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, '://[REDACTED]@')
		.replace(
			/\b(authorization|access[_-]?token|refresh[_-]?token|password|secret)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
			'$1$2[REDACTED]'
		);
}

/**
 * Collects a bounded set of regular log files without following symbolic links.
 */
async function listLogFiles(root, output = []) {
	if (output.length >= maximumLogFiles) {
		return output;
	}

	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (error?.code === 'ENOENT') {
			return output;
		}
		throw error;
	}

	for (const entry of entries) {
		if (output.length >= maximumLogFiles) {
			break;
		}
		if (entry.isSymbolicLink()) {
			continue;
		}
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			await listLogFiles(path, output);
		} else if (entry.isFile() && entry.name.endsWith('.log')) {
			output.push(path);
		}
	}
	return output;
}

/**
 * Produces a filesystem-safe UTC timestamp for an artifact directory.
 */
function artifactTimestamp() {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Captures a bounded, sanitized diagnostic bundle for a packaged smoke failure.
 */
export async function captureSmokeFailureArtifacts(options) {
	const artifactBase = resolve(
		options.artifactBase ?? join(repositoryRoot, 'test-results', 'repository-context-shell')
	);
	const artifactDirectory = join(
		artifactBase,
		`failure-${artifactTimestamp()}-${process.pid}`
	);
	const sensitiveValues = [
		homedir(),
		options.temporaryRoot,
		options.temporaryRoot && basename(options.temporaryRoot),
		...(options.sensitiveValues ?? []),
	].filter(Boolean);
	const writtenFiles = [];

	await mkdir(artifactDirectory, { recursive: true });

	if (options.page) {
		try {
			await options.page.evaluate((values) => {
				for (const input of document.querySelectorAll('input, textarea')) {
					if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
						if (input.type === 'password' || values.some(value => input.value.includes(value))) {
							input.value = '';
						}
					}
				}
				const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
				let node;
				while ((node = walker.nextNode())) {
					if (!node.textContent) {
						continue;
					}
					for (const value of values) {
						node.textContent = node.textContent.replaceAll(value, '[REDACTED]');
					}
				}
			}, sensitiveValues);
		} catch {
			// A renderer failure must not prevent the remaining diagnostics from being captured.
		}

		const screenshotPath = join(artifactDirectory, 'screenshot.png');
		try {
			await options.page.screenshot({ path: screenshotPath, fullPage: true });
			writtenFiles.push('screenshot.png');
		} catch {
			// Continue with text diagnostics when the renderer cannot produce a screenshot.
		}

		let accessibility = 'Accessibility snapshot was unavailable.';
		try {
			accessibility = await options.page.locator('body').ariaSnapshot();
		} catch {
			// The fallback still records why this diagnostic is absent.
		}
		await writeFile(
			join(artifactDirectory, 'accessibility.txt'),
			`${redactSmokeText(accessibility, sensitiveValues)}\n`
		);
		writtenFiles.push('accessibility.txt');
	}

	const textArtifacts = [
		['application.log', (options.applicationLog ?? []).join('')],
		['console.log', (options.consoleErrors ?? []).join('\n')],
		['failure.log', options.error?.stack ?? options.error?.message ?? String(options.error)],
	];
	for (const [name, content] of textArtifacts) {
		await writeFile(
			join(artifactDirectory, name),
			`${redactSmokeText(content, sensitiveValues)}\n`
		);
		writtenFiles.push(name);
	}

	if (options.userDataPath) {
		const logRoot = join(options.userDataPath, 'logs');
		for (const sourcePath of await listLogFiles(logRoot)) {
			const targetRelativePath = join('runtime-logs', relative(logRoot, sourcePath));
			const targetPath = join(artifactDirectory, targetRelativePath);
			const content = (await readFile(sourcePath)).subarray(0, maximumLogBytes).toString('utf8');
			await mkdir(dirname(targetPath), { recursive: true });
			await writeFile(targetPath, redactSmokeText(content, sensitiveValues));
			writtenFiles.push(targetRelativePath);
		}
	}

	await writeFile(
		join(artifactDirectory, 'manifest.json'),
		`${JSON.stringify({
			schemaVersion: 1,
			createdAt: new Date().toISOString(),
			files: [...writtenFiles, 'manifest.json'].sort(),
			rawFixtureRetained: false,
		}, null, '\t')}\n`
	);

	return artifactDirectory;
}
