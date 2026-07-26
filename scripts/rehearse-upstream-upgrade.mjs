/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Repository Context Workbench contributors.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import {
	classifyGitCommand,
	createGitManifestInventory,
	diffGitManifestInventories,
	downstreamOnlyCommands,
	pinnedUpstreamInventory,
} from './git-command-inventory.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const expectedUpstreamUrl = 'https://github.com/microsoft/vscode.git';

function readOption(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) {
		return undefined;
	}
	const value = process.argv[index + 1];
	if (!value || value.startsWith('--')) {
		throw new Error(`${name} requires a value.`);
	}
	return value;
}

function runGit(args) {
	return execFileSync('git', args, {
		cwd: repositoryRoot,
		encoding: 'utf8',
		maxBuffer: 50 * 1024 * 1024,
	}).trim();
}

function readManifest(revision) {
	return JSON.parse(runGit(['show', `${revision}:extensions/git/package.json`]));
}

function formatList(values, formatter = value => `- \`${value}\``) {
	return values.length === 0 ? '- None' : values.map(formatter).join('\n');
}

function formatMenu(entry) {
	const suffix = [
		entry.alt && `alt=${entry.alt}`,
		entry.group && `group=${entry.group}`,
		entry.when && `when=${entry.when}`,
	].filter(Boolean).join(', ');
	return `- \`${entry.location}: ${entry.command}\`${suffix ? ` (${suffix})` : ''}`;
}

const candidateTag = readOption('--tag') ?? pinnedUpstreamInventory.tag;
const reportPath = readOption('--report');
const shouldFetch = process.argv.includes('--fetch');
const allowDeclarationDelta = process.argv.includes('--allow-declaration-delta');

assert.match(candidateTag, /^\d+\.\d+\.\d+$/, 'The candidate must be an exact stable version tag.');
assert.equal(
	runGit(['remote', 'get-url', 'upstream']),
	expectedUpstreamUrl,
	'The upstream remote does not point to the official microsoft/vscode repository.'
);

if (shouldFetch) {
	const fetchResult = spawnSync(
		'git',
		['fetch', 'upstream', `refs/tags/${candidateTag}:refs/tags/${candidateTag}`],
		{ cwd: repositoryRoot, encoding: 'utf8', stdio: 'inherit' }
	);
	if (fetchResult.status !== 0) {
		process.exit(fetchResult.status ?? 1);
	}
}

const candidateObjectType = runGit(['cat-file', '-t', candidateTag]);
assert.ok(
	candidateObjectType === 'commit' || candidateObjectType === 'tag',
	'The candidate must resolve to a stable-tag commit.'
);
const candidateCommit = runGit(['rev-parse', `${candidateTag}^{commit}`]);
const baselineCommit = runGit(['rev-parse', `${pinnedUpstreamInventory.tag}^{commit}`]);
assert.equal(
	baselineCommit,
	pinnedUpstreamInventory.commit,
	'The pinned upstream tag no longer resolves to its recorded commit.'
);

const baseline = createGitManifestInventory(readManifest(pinnedUpstreamInventory.tag));
const candidate = createGitManifestInventory(readManifest(candidateTag));
const downstream = createGitManifestInventory(
	JSON.parse(runGit(['show', 'HEAD:extensions/git/package.json']))
);
for (const field of ['commandCount', 'commandHash', 'menuCount', 'menuHash']) {
	assert.equal(
		baseline[field],
		pinnedUpstreamInventory[field],
		`The recorded upstream ${field} no longer matches ${pinnedUpstreamInventory.tag}.`
	);
}

const delta = diffGitManifestInventories(baseline, candidate);
const removedRetainedCommands = delta.removedCommands.filter(command => classifyGitCommand(command) !== 'excluded');
const downstreamCommandsMissingLocally = [...downstreamOnlyCommands]
	.filter(command => !downstream.commandIds.includes(command));
assert.deepEqual(
	downstreamCommandsMissingLocally,
	[],
	'The current downstream manifest is missing a downstream-owned retained command.'
);

const declarationDelta = [
	delta.addedCommands,
	delta.removedCommands,
	delta.addedMenus,
	delta.removedMenus,
].some(entries => entries.length > 0);
const report = [
	'# Upstream stable-tag rehearsal',
	'',
	`- Baseline: \`${pinnedUpstreamInventory.tag}\` at \`${baselineCommit}\``,
	`- Candidate: \`${candidateTag}\` at \`${candidateCommit}\``,
	`- Commands: ${baseline.commandCount} → ${candidate.commandCount}`,
	`- Menu entries: ${baseline.menuCount} → ${candidate.menuCount}`,
	`- Declaration review: ${declarationDelta ? 'required' : 'no delta'}`,
	`- Removed retained commands: ${removedRetainedCommands.length}`,
	'',
	'## Added commands',
	'',
	formatList(delta.addedCommands),
	'',
	'## Removed commands',
	'',
	formatList(delta.removedCommands),
	'',
	'## Added menu entries',
	'',
	formatList(delta.addedMenus, formatMenu),
	'',
	'## Removed menu entries',
	'',
	formatList(delta.removedMenus, formatMenu),
	'',
].join('\n');

if (reportPath) {
	await writeFile(resolve(repositoryRoot, reportPath), report);
}
console.log(report);

if (removedRetainedCommands.length > 0) {
	throw new Error('The candidate removes retained Git commands; the downstream policy must be reconciled.');
}
if (declarationDelta && !allowDeclarationDelta) {
	throw new Error(
		'The candidate changes Git command or menu declarations. Review the report, update the retained inventory, ' +
		'then rerun with --allow-declaration-delta as part of an upgrade branch.'
	);
}
