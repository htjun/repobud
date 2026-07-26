/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import assert from 'assert';
import { workspace, commands, window, Uri, extensions, TabInputTextDiff, ConfigurationTarget } from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GitExtension, API, Repository } from '../api/git';
import { Status } from '../api/git.constants';
import { eventToPromise } from '../util';

suite('git smoke test', function () {
	const cwd = workspace.workspaceFolders![0].uri.fsPath;
	const temporaryPaths: string[] = [];

	function file(relativePath: string) {
		return path.join(cwd, relativePath);
	}

	function uri(relativePath: string) {
		return Uri.file(file(relativePath));
	}

	let git: API;
	let repository: Repository;

	suiteSetup(async function () {
		fs.writeFileSync(file('app.js'), 'hello', 'utf8');
		fs.writeFileSync(file('index.pug'), 'hello', 'utf8');
		cp.execSync('git init -b main', { cwd });
		cp.execSync('git config user.name testuser', { cwd });
		cp.execSync('git config user.email monacotools@example.com', { cwd });
		cp.execSync('git config commit.gpgsign false', { cwd });
		cp.execSync('git add .', { cwd });
		cp.execSync('git commit -m "initial commit"', { cwd });

		// make sure git is activated
		const ext = extensions.getExtension<GitExtension>('vscode.git');
		await ext?.activate();
		git = ext!.exports.getAPI(1);

		if (git.repositories.length === 0) {
			const onDidOpenRepository = eventToPromise(git.onDidOpenRepository);
			await commands.executeCommand('git.openRepository', cwd);
			await onDidOpenRepository;
		}

		assert.strictEqual(git.repositories.length, 1);
		assert.strictEqual(git.repositories[0].rootUri.fsPath, cwd);

		repository = git.repositories[0];
	});

	suiteTeardown(() => {
		for (const temporaryPath of temporaryPaths) {
			fs.rmSync(temporaryPath, { force: true, recursive: true });
		}
	});

	test('reflects working tree changes', async function () {
		await commands.executeCommand('workbench.view.scm');

		const appjs = uri('app.js');
		fs.appendFileSync(appjs.fsPath, ' world');
		await repository.status();

		assert.strictEqual(repository.state.workingTreeChanges.length, 1);
		assert.strictEqual(repository.state.workingTreeChanges[0].uri.path, appjs.path);
		assert.strictEqual(repository.state.workingTreeChanges[0].status, Status.MODIFIED);

		const newfile = uri('newfile.txt');
		fs.writeFileSync(newfile.fsPath, 'hey there');
		await repository.status();

		assert.strictEqual(repository.state.workingTreeChanges.length, 2);
		assert.strictEqual(repository.state.workingTreeChanges[0].uri.path, appjs.path);
		assert.strictEqual(repository.state.workingTreeChanges[0].status, Status.MODIFIED);
		assert.strictEqual(repository.state.workingTreeChanges[1].uri.path, newfile.path);
		assert.strictEqual(repository.state.workingTreeChanges[1].status, Status.UNTRACKED);
	});

	test('opens diff editor', async function () {
		const appjs = uri('app.js');
		await commands.executeCommand('git.openChange', appjs);

		assert(window.activeTextEditor);
		assert.strictEqual(window.activeTextEditor!.document.uri.path, appjs.path);

		assert(window.tabGroups.activeTabGroup.activeTab);
		assert(window.tabGroups.activeTabGroup.activeTab!.input instanceof TabInputTextDiff);
	});

	test('stages correctly', async function () {
		const appjs = uri('app.js');
		const newfile = uri('newfile.txt');

		await repository.add([appjs.fsPath]);

		assert.strictEqual(repository.state.indexChanges.length, 1);
		assert.strictEqual(repository.state.indexChanges[0].uri.path, appjs.path);
		assert.strictEqual(repository.state.indexChanges[0].status, Status.INDEX_MODIFIED);

		assert.strictEqual(repository.state.workingTreeChanges.length, 1);
		assert.strictEqual(repository.state.workingTreeChanges[0].uri.path, newfile.path);
		assert.strictEqual(repository.state.workingTreeChanges[0].status, Status.UNTRACKED);

		await repository.revert([appjs.fsPath]);

		assert.strictEqual(repository.state.indexChanges.length, 0);

		assert.strictEqual(repository.state.workingTreeChanges.length, 2);
		assert.strictEqual(repository.state.workingTreeChanges[0].uri.path, appjs.path);
		assert.strictEqual(repository.state.workingTreeChanges[0].status, Status.MODIFIED);
		assert.strictEqual(repository.state.workingTreeChanges[1].uri.path, newfile.path);
		assert.strictEqual(repository.state.workingTreeChanges[1].status, Status.UNTRACKED);
	});

	test('stages, commits changes and verifies outgoing change', async function () {
		const appjs = uri('app.js');
		const newfile = uri('newfile.txt');

		await repository.add([appjs.fsPath]);
		await repository.commit('second commit');

		assert.strictEqual(repository.state.workingTreeChanges.length, 1);
		assert.strictEqual(repository.state.workingTreeChanges[0].uri.path, newfile.path);
		assert.strictEqual(repository.state.workingTreeChanges[0].status, Status.UNTRACKED);

		assert.strictEqual(repository.state.indexChanges.length, 0);

		await repository.commit('third commit', { all: true });

		assert.strictEqual(repository.state.workingTreeChanges.length, 0);
		assert.strictEqual(repository.state.indexChanges.length, 0);
	});

	test('supports commit variants, branches, tags, stashes, worktrees and remotes', async function () {
		assert.strictEqual(fs.realpathSync(git.git.path), fs.realpathSync(cp.execFileSync('which', ['git'], { encoding: 'utf8' }).trim()));

		await repository.createBranch('operations', true);
		assert.strictEqual(repository.state.HEAD?.name, 'operations');
		fs.appendFileSync(file('app.js'), ' operations');
		await repository.commit('operations commit', { all: true, signoff: true });
		assert.match(cp.execSync('git log -1 --pretty=%B', { cwd, encoding: 'utf8' }), /Signed-off-by: testuser/);

		fs.appendFileSync(file('app.js'), ' amended');
		await repository.add([file('app.js')]);
		const commitBeforeAmend = cp.execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim();
		await repository.commit('operations amended', { amend: true });
		assert.notStrictEqual(cp.execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim(), commitBeforeAmend);
		assert.strictEqual(cp.execSync('git log -1 --pretty=%s', { cwd, encoding: 'utf8' }).trim(), 'operations amended');

		await repository.commit('operations empty', { empty: true });
		assert.strictEqual(cp.execSync('git log -1 --pretty=%s', { cwd, encoding: 'utf8' }).trim(), 'operations empty');

		await repository.checkout('main');
		fs.appendFileSync(file('index.pug'), ' main');
		await repository.commit('main operations', { all: true });
		await repository.checkout('operations');
		await repository.rebase('main');
		assert.strictEqual(repository.state.HEAD?.name, 'operations');

		await repository.tag('operations-tag', 'Operations tag');
		assert.match(cp.execSync('git tag --list operations-tag', { cwd, encoding: 'utf8' }), /operations-tag/);
		await repository.deleteTag('operations-tag');
		assert.strictEqual(cp.execSync('git tag --list operations-tag', { cwd, encoding: 'utf8' }).trim(), '');

		fs.appendFileSync(file('app.js'), ' stash');
		await repository.createStash({ message: 'operations stash' });
		assert.strictEqual(repository.state.workingTreeChanges.length, 0);
		await repository.applyStash(0);
		await repository.status();
		assert.strictEqual(repository.state.workingTreeChanges.length, 1);
		await repository.restore([file('app.js')], { ref: 'HEAD' });
		await repository.popStash(0);
		await repository.status();
		assert.strictEqual(repository.state.workingTreeChanges.length, 1);
		await repository.commit('stash restored', { all: true });

		fs.appendFileSync(file('app.js'), ' drop');
		await repository.createStash({ message: 'drop stash' });
		await repository.dropStash(0);
		assert.strictEqual(cp.execSync('git stash list', { cwd, encoding: 'utf8' }).trim(), '');

		const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'repobud-worktree-'));
		fs.rmdirSync(worktreePath);
		temporaryPaths.push(worktreePath);
		await repository.createWorktree({ path: worktreePath, branch: 'worktree-branch', commitish: 'main' });
		assert.ok(fs.existsSync(path.join(worktreePath, '.git')));
		await repository.deleteWorktree(worktreePath);
		assert.strictEqual(fs.existsSync(worktreePath), false);

		await repository.checkout('main');
		const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repobud-remote-'));
		temporaryPaths.push(remoteRoot);
		const remotePath = path.join(remoteRoot, 'remote.git');
		cp.execFileSync('git', ['init', '--bare', remotePath]);
		await repository.addRemote('origin', remotePath);
		await commands.executeCommand('git.publish', repository.rootUri);
		await repository.status();
		assert.strictEqual(repository.state.HEAD?.upstream?.remote, 'origin');

		const peerPath = path.join(remoteRoot, 'peer');
		cp.execFileSync('git', ['clone', remotePath, peerPath]);
		cp.execFileSync('git', ['config', 'user.name', 'peer'], { cwd: peerPath });
		cp.execFileSync('git', ['config', 'user.email', 'peer@example.com'], { cwd: peerPath });
		fs.writeFileSync(path.join(peerPath, 'peer.txt'), 'peer');
		cp.execFileSync('git', ['add', 'peer.txt'], { cwd: peerPath });
		cp.execFileSync('git', ['commit', '-m', 'peer change'], { cwd: peerPath });
		cp.execFileSync('git', ['push'], { cwd: peerPath });
		await repository.pull();
		assert.strictEqual(fs.readFileSync(file('peer.txt'), 'utf8'), 'peer');

		fs.appendFileSync(file('index.pug'), ' local');
		await repository.commit('local push', { all: true });
		await repository.push();
		await repository.fetch({ remote: 'origin', prune: true });
		await workspace.getConfiguration('git').update('confirmSync', false, ConfigurationTarget.Global);
		await commands.executeCommand('git.sync', repository.rootUri);
		assert.strictEqual(
			cp.execFileSync('git', ['--git-dir', remotePath, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim(),
			'local push'
		);
	});

	test('rename/delete conflict', async function () {
		await commands.executeCommand('workbench.view.scm');

		const appjs = file('app.js');
		const renamejs = file('rename.js');

		await repository.createBranch('test', true);

		// Delete file (test branch)
		fs.unlinkSync(appjs);
		await repository.commit('commit on test', { all: true });

		await repository.checkout('main');

		// Rename file (main branch)
		fs.renameSync(appjs, renamejs);
		await repository.commit('commit on main', { all: true });

		try {
			await repository.merge('test');
		} catch (e) { }

		assert.strictEqual(repository.state.mergeChanges.length, 1);
		assert.strictEqual(repository.state.mergeChanges[0].status, Status.DELETED_BY_THEM);

		assert.strictEqual(repository.state.workingTreeChanges.length, 0);
		assert.strictEqual(repository.state.indexChanges.length, 0);
	});
});
