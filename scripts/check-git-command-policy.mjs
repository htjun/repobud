/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Repository Context Workbench contributors.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
	classifyGitCommand,
	createGitManifestInventory,
	downstreamInventory,
	excludedCommands,
	internalCommands,
} from './git-command-inventory.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(resolve(repositoryRoot, 'extensions/git/package.json'), 'utf8'));
const product = JSON.parse(await readFile(resolve(repositoryRoot, 'product.json'), 'utf8'));

const inventory = createGitManifestInventory(manifest);
const commands = inventory.commandIds;
const commandSet = new Set(commands);

assert.equal(inventory.commandCount, downstreamInventory.commandCount, 'Git command count changed; review and update the policy.');
assert.equal(inventory.commandHash, downstreamInventory.commandHash, 'Git command IDs changed; review and update the policy.');
assert.equal(inventory.menuCount, downstreamInventory.menuCount, 'Git menu count changed; review and update the policy.');
assert.equal(inventory.menuHash, downstreamInventory.menuHash, 'Git menu declarations changed; review and update the policy.');

for (const command of [...excludedCommands.keys(), ...internalCommands]) {
	assert.ok(commandSet.has(command), `Policy references missing command: ${command}`);
}

const blockedCommands = new Set(product.repositoryContextWorkbench?.blockedCommandIds ?? []);
for (const command of excludedCommands.keys()) {
	assert.ok(blockedCommands.has(command), `Excluded command is not blocked by the product: ${command}`);
}

const policy = commands.map(command => ({
	command,
	status: classifyGitCommand(command),
	reason: excludedCommands.get(command) ?? '',
}));

if (process.argv.includes('--report')) {
	console.log('| Command | Status | Reason |');
	console.log('| --- | --- | --- |');
	for (const entry of policy) {
		console.log(`| \`${entry.command}\` | ${entry.status} | ${entry.reason} |`);
	}
}

const counts = Object.groupBy(policy, entry => entry.status);
console.log([
	`Git command policy passed: ${policy.length} commands`,
	`${counts.supported?.length ?? 0} supported`,
	`${counts.internal?.length ?? 0} internal`,
	`${counts.excluded?.length ?? 0} excluded`,
].join(', '));
