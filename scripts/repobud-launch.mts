/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

/**
 * Creates the isolated application data directories below the provided root.
 */
export async function prepareApplicationData(dataRoot) {
	const paths = {
		userDataDirectory: join(dataRoot, 'user-data'),
		extensionsDirectory: join(dataRoot, 'extensions'),
		sharedDataDirectory: join(dataRoot, 'shared-data'),
	};
	await Promise.all([
		mkdir(paths.userDataDirectory, { recursive: true }),
		mkdir(paths.extensionsDirectory, { recursive: true }),
		mkdir(paths.sharedDataDirectory, { recursive: true }),
	]);
	return paths;
}

/**
 * Returns command-line arguments for isolated application data.
 */
export function applicationDataArguments(paths) {
	return [
		`--user-data-dir=${paths.userDataDirectory}`,
		`--extensions-dir=${paths.extensionsDirectory}`,
		`--shared-data-dir=${paths.sharedDataDirectory}`,
	];
}

/**
 * Runs a command and returns its exit code.
 */
export function runProcess(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: process.env,
			stdio: 'inherit',
			...options,
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

/**
 * Runs a required command and rejects when it fails.
 */
export async function runRequiredProcess(command, args, options = {}) {
	const exitCode = await runProcess(command, args, options);
	if (exitCode !== 0) {
		throw new Error(`${command} exited with code ${exitCode}.`);
	}
}
