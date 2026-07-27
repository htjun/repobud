/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
	applicationDataArguments,
	prepareApplicationData,
	runProcess,
	runRequiredProcess,
} from './repobud-launch.mts';
import { repositoryRoot } from './repobud-package.mts';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
	throw new Error('The initial RepoBud development target requires macOS on Apple silicon.');
}

const npm = 'npm';
const devDataRoot = process.env.REPOBUD_DEV_DATA_DIR ??
	join(homedir(), '.repobud-dev');
const repositoryArguments = process.argv.slice(2);
if (repositoryArguments.length > 1 || repositoryArguments[0]?.startsWith('-')) {
	throw new Error('Usage: npm run dev [-- /path/to/repository]');
}
const repositoryArgument = repositoryArguments[0] ?? repositoryRoot;
const repositoryPath = resolve(repositoryRoot, repositoryArgument);
const repositoryStat = await stat(repositoryPath).catch(() => undefined);
if (!repositoryStat?.isDirectory()) {
	throw new Error(`The development repository path is not a directory: ${repositoryPath}`);
}
console.log('Building RepoBud for source development...');
await runRequiredProcess(npm, ['run', 'build-fast'], { cwd: repositoryRoot });
await runRequiredProcess(process.execPath, ['build/lib/preLaunch.ts'], { cwd: repositoryRoot });
const applicationData = await prepareApplicationData(devDataRoot);

const product = JSON.parse(await readFile(join(repositoryRoot, 'product.json'), 'utf8'));
const executablePath = join(
	repositoryRoot,
	'.build',
	'electron',
	`${product.nameLong}.app`,
	'Contents',
	'MacOS',
	product.nameShort
);
const environment = {
	...process.env,
	NODE_ENV: 'development',
	VSCODE_DEV: '1',
	VSCODE_CLI: '1',
	ELECTRON_ENABLE_STACK_DUMPING: '1',
	ELECTRON_ENABLE_LOGGING: '1',
};
delete environment.ELECTRON_RUN_AS_NODE;

const launchArguments = [
	repositoryRoot,
	...applicationDataArguments(applicationData),
	'--disable-workspace-trust',
	'--disable-extension=vscode.vscode-api-tests',
	`--folder-uri=${pathToFileURL(repositoryPath).toString()}`,
];

console.log(`Opening ${product.nameLong} from source with development data at ${devDataRoot}`);
process.exitCode = await runProcess(executablePath, launchArguments, {
	cwd: repositoryRoot,
	env: environment,
});
