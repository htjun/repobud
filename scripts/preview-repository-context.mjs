/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Repository Context Workbench contributors.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const product = JSON.parse(await readFile(join(repositoryRoot, 'product.json'), 'utf8'));
const previewDataRoot = process.env.REPOSITORY_CONTEXT_PREVIEW_DATA_DIR ??
	join(homedir(), '.repository-context-workbench-preview');
const userDataDirectory = join(previewDataRoot, 'user-data');
const extensionsDirectory = join(previewDataRoot, 'extensions');
const sharedDataDirectory = join(previewDataRoot, 'shared-data');

await Promise.all([
	mkdir(userDataDirectory, { recursive: true }),
	mkdir(extensionsDirectory, { recursive: true }),
	mkdir(sharedDataDirectory, { recursive: true }),
]);

function run(command, args, environment = process.env) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: repositoryRoot,
			env: environment,
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

const prelaunchCode = await run(process.execPath, ['build/lib/preLaunch.ts']);
if (prelaunchCode !== 0) {
	process.exitCode = prelaunchCode;
} else {
	const executable = join(
		repositoryRoot,
		'.build',
		'electron',
		`${product.nameLong}.app`,
		'Contents',
		'MacOS',
		product.nameShort
	);
	const applicationArgs = [
		`--user-data-dir=${userDataDirectory}`,
		`--extensions-dir=${extensionsDirectory}`,
		`--shared-data-dir=${sharedDataDirectory}`,
		'--disable-workspace-trust',
		'--disable-extension=vscode.vscode-api-tests',
		...process.argv.slice(2),
	];
	const environment = {
		...process.env,
		NODE_ENV: 'development',
		VSCODE_DEV: '1',
		VSCODE_CLI: '1',
		ELECTRON_ENABLE_STACK_DUMPING: '1',
		ELECTRON_ENABLE_LOGGING: '1',
	};

	console.log(`Launching ${product.nameLong} with preview data at ${previewDataRoot}`);
	process.exitCode = await run(executable, applicationArgs, environment);
}
