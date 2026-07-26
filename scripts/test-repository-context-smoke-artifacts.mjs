/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Repository Context Workbench contributors.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	captureSmokeFailureArtifacts,
	redactSmokeText,
} from './repository-context-smoke-artifacts.mjs';

const temporaryRoot = await mkdtemp(join(tmpdir(), 'repository-context-artifact-test-'));
const artifactBase = join(temporaryRoot, 'artifacts');
const userDataPath = join(temporaryRoot, 'profile');
const runtimeLogPath = join(userDataPath, 'logs', 'session', 'renderer.log');
const fixtureToken = 'fixture-token-should-never-survive';
let passwordInputsCleared = false;

const page = {
	async evaluate() {
		passwordInputsCleared = true;
	},
	async screenshot({ path }) {
		await writeFile(path, Buffer.from('mock-png'));
	},
	locator() {
		return {
			async ariaSnapshot() {
				return `Token ${fixtureToken} from ${temporaryRoot}`;
			},
		};
	},
};

try {
	await mkdir(join(userDataPath, 'logs', 'session'), { recursive: true });
	await writeFile(
		runtimeLogPath,
		`authorization: Bearer ${fixtureToken}\npath=${temporaryRoot}\n`
	);

	const artifactDirectory = await captureSmokeFailureArtifacts({
		artifactBase,
		temporaryRoot,
		userDataPath,
		sensitiveValues: [fixtureToken],
		applicationLog: [`password=${fixtureToken}\n`],
		consoleErrors: [`https://user:${fixtureToken}@example.invalid/repository`],
		error: new Error(`Failed at ${temporaryRoot} with ${fixtureToken}`),
		page,
	});

	assert.equal(passwordInputsCleared, true);
	assert.deepEqual(
		(await readdir(artifactDirectory)).sort(),
		[
			'accessibility.txt',
			'application.log',
			'console.log',
			'failure.log',
			'manifest.json',
			'runtime-logs',
			'screenshot.png',
		]
	);

	const textFiles = [
		'accessibility.txt',
		'application.log',
		'console.log',
		'failure.log',
		'manifest.json',
		join('runtime-logs', 'session', 'renderer.log'),
	];
	for (const relativePath of textFiles) {
		const content = await readFile(join(artifactDirectory, relativePath), 'utf8');
		assert.doesNotMatch(content, new RegExp(fixtureToken));
		assert.doesNotMatch(content, new RegExp(temporaryRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	}

	assert.equal(
		redactSmokeText('Bearer exposed https://user:password@example.invalid'),
		'Bearer [REDACTED] https://[REDACTED]@example.invalid'
	);
	console.log('Repository Context smoke artifact redaction test passed.');
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
