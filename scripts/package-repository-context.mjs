/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Repository Context Workbench contributors.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { repositoryRoot, verifyRepositoryContextPackage } from './repository-context-package.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
	throw new Error('The initial Repository Context package target requires macOS on Apple silicon.');
}

function run(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: repositoryRoot,
			env: process.env,
			stdio: 'inherit',
		});
		child.once('error', reject);
		child.once('exit', (code, signal) => {
			if (signal) {
				reject(new Error(`${command} stopped with signal ${signal}.`));
				return;
			}
			if (code !== 0) {
				reject(new Error(`${command} exited with code ${code ?? 1}.`));
				return;
			}
			resolve();
		});
	});
}

await run(process.execPath, [
	'--experimental-strip-types',
	'--max-old-space-size=8192',
	join(repositoryRoot, 'node_modules', 'gulp', 'bin', 'gulp.js'),
	'vscode-darwin-arm64',
]);

const result = await verifyRepositoryContextPackage();
console.log(`Packaged ${result.name} at ${result.applicationPath}`);
