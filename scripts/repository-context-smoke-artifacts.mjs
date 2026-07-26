/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Repository Context Workbench contributors.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const maximumLogFiles = 50;
const maximumLogBytes = 2 * 1024 * 1024;

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

function artifactTimestamp() {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

export async function captureSmokeFailureArtifacts(options) {
	const artifactBase = resolve(
		options.artifactBase ?? join(repositoryRoot, 'test-results', 'repository-context-shell')
	);
	const artifactDirectory = join(
		artifactBase,
		`failure-${artifactTimestamp()}-${process.pid}`
	);
	const sensitiveValues = [
		options.temporaryRoot,
		...(options.sensitiveValues ?? []),
	].filter(Boolean);
	const writtenFiles = [];

	await mkdir(artifactDirectory, { recursive: true });

	if (options.page) {
		await options.page.evaluate(() => {
			for (const input of document.querySelectorAll('input[type="password"], [data-secret] input')) {
				if (input instanceof HTMLInputElement) {
					input.value = '';
				}
			}
		}).catch(() => undefined);

		const screenshotPath = join(artifactDirectory, 'screenshot.png');
		await options.page.screenshot({ path: screenshotPath, fullPage: true })
			.then(() => writtenFiles.push('screenshot.png'))
			.catch(() => undefined);

		const accessibility = await options.page.locator('body').ariaSnapshot()
			.catch(() => 'Accessibility snapshot was unavailable.');
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
