/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { verifyRepositoryContextPackage } from './repository-context-package.mts';

const previewDataRoot = process.env.REPOSITORY_CONTEXT_PREVIEW_DATA_DIR ??
	join(homedir(), '.repository-context-workbench-preview');
const userDataDirectory = join(previewDataRoot, 'user-data');
const extensionsDirectory = join(previewDataRoot, 'extensions');
const sharedDataDirectory = join(previewDataRoot, 'shared-data');
const allowStale = process.argv.includes('--allow-stale');
const applicationArgs = process.argv.slice(2).filter(argument => argument !== '--allow-stale');

await Promise.all([
	mkdir(userDataDirectory, { recursive: true }),
	mkdir(extensionsDirectory, { recursive: true }),
	mkdir(sharedDataDirectory, { recursive: true }),
]);

/**
 * Opens the verified package and returns the launcher exit code.
 */
function run(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: process.env,
			stdio: 'inherit',
		});
		child.once('error', reject);
		child.once('exit', (code, signal) => {
			if (signal) {
				reject(new Error(`${command} stopped with signal ${signal}.`));
				return;
			}
			resolve(code ?? 1);
		});
	});
}

const packaged = await verifyRepositoryContextPackage({ allowStale });
const launchArguments = [
	'-n',
	packaged.applicationPath,
	'--args',
	`--user-data-dir=${userDataDirectory}`,
	`--extensions-dir=${extensionsDirectory}`,
	`--shared-data-dir=${sharedDataDirectory}`,
	'--disable-workspace-trust',
	...applicationArgs,
];

console.log(`Opening ${packaged.name} with preview data at ${previewDataRoot}`);
process.exitCode = await run('/usr/bin/open', launchArguments);
