/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Repository Context Workbench contributors.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(resolve(repositoryRoot, 'extensions/git/package.json'), 'utf8'));
const product = JSON.parse(await readFile(resolve(repositoryRoot, 'product.json'), 'utf8'));

const expectedCommandCount = 184;
const expectedCommandHash = '75f7421839c861fb0f062804d58fe89ade255561c3033c6419d03da8399dee9f';

const excludedCommands = new Map([
	['git.acceptMerge', 'Conflict resolution belongs in an external editor.'],
	['git.blame.toggleStatusBarItem', 'The product has no status bar.'],
	['git.close', 'The repository catalog owns active-repository lifecycle.'],
	['git.closeOtherRepositories', 'The product never combines repository trees.'],
	['git.commitMessageAccept', 'Commit-message editor workflows are not part of the viewer.'],
	['git.commitMessageDiscard', 'Commit-message editor workflows are not part of the viewer.'],
	['git.continueInLocalClone', 'Remote edit-session continuation is outside product scope.'],
	['git.delete', 'The viewer does not directly delete source files.'],
	['git.migrateWorktreeChanges', 'Interactive in-app merge editing is outside product scope.'],
	['git.openMergeEditor', 'Conflict resolution belongs in an external editor.'],
	['git.openRepositoriesInParentFolders', 'The repository catalog requires explicit registration.'],
	['git.rename', 'The viewer does not directly rename source files.'],
	['git.reopenClosedRepositories', 'The repository catalog owns active-repository lifecycle.'],
	['git.restoreCommitTemplate', 'Commit-message editor workflows are not part of the viewer.'],
	['git.revertChange', 'Discard is available only through confirmed SCM actions.'],
	['git.revertSelectedRanges', 'Discard is available only through confirmed SCM actions.'],
	['git.runGitMerge', 'Conflict resolution belongs in an external editor.'],
	['git.runGitMergeDiff3', 'Conflict resolution belongs in an external editor.'],
	['git.timeline.compareWithSelected', 'The Timeline view is not part of the focused shell.'],
	['git.timeline.copyCommitId', 'The Timeline view is not part of the focused shell.'],
	['git.timeline.copyCommitMessage', 'The Timeline view is not part of the focused shell.'],
	['git.timeline.openDiff', 'The Timeline view is not part of the focused shell.'],
	['git.timeline.selectForCompare', 'The Timeline view is not part of the focused shell.'],
	['git.timeline.viewCommit', 'The Timeline view is not part of the focused shell.'],
]);

const internalCommands = new Set([
	'git.api.getRemoteSources',
	'git.api.getRepositories',
	'git.api.getRepositoryState',
	'git.checkoutDetached',
	'git.closeAllUnmodifiedEditors',
	'git.openAllChanges',
	'git.openFile2',
	'git.stageChange',
	'git.stageFile',
	'git.unstageChange',
	'git.unstageFile',
]);

const commands = manifest.contributes.commands
	.filter(command => command.command.startsWith('git.'))
	.map(command => command.command)
	.sort();
const commandSet = new Set(commands);
const commandHash = createHash('sha256').update(commands.join('\n')).digest('hex');

assert.equal(commands.length, expectedCommandCount, 'Git command count changed; review and update the policy.');
assert.equal(commandHash, expectedCommandHash, 'Git command IDs changed; review and update the policy.');

for (const command of [...excludedCommands.keys(), ...internalCommands]) {
	assert.ok(commandSet.has(command), `Policy references missing command: ${command}`);
}

const blockedCommands = new Set(product.repositoryContextWorkbench?.blockedCommandIds ?? []);
for (const command of excludedCommands.keys()) {
	assert.ok(blockedCommands.has(command), `Excluded command is not blocked by the product: ${command}`);
}

function classifyCommand(command) {
	if (excludedCommands.has(command)) {
		return 'excluded';
	}
	if (internalCommands.has(command)) {
		return 'internal';
	}
	return 'supported';
}

const policy = commands.map(command => ({
	command,
	status: classifyCommand(command),
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
