/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ISkillProjectionRequest } from '../../common/skillProjection.js';
import { RepositoryContextSkillProjectionMainService } from '../../electron-main/skillProjectionMainService.js';

suite('RepositoryContextSkillProjectionMainService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let fixtureRoot: string;
	let service: RepositoryContextSkillProjectionMainService;

	setup(async () => {
		fixtureRoot = await fs.mkdtemp(join(tmpdir(), 'repository-context-projection-'));
		service = new RepositoryContextSkillProjectionMainService();
	});

	teardown(async () => {
		await fs.rm(fixtureRoot, { recursive: true, force: true });
	});

	async function createRequest(strategy: ISkillProjectionRequest['strategy'] = 'prefer-link'): Promise<ISkillProjectionRequest> {
		const source = join(fixtureRoot, 'canonical', 'review');
		const target = join(fixtureRoot, 'codex', 'review');
		await fs.mkdir(source, { recursive: true });
		await fs.writeFile(
			join(source, 'SKILL.md'),
			'---\nname: review\ndescription: Review changes.\n---\n\n# Review\n'
		);
		await fs.mkdir(join(source, 'references'));
		await fs.writeFile(join(source, 'references', 'checks.md'), '# Checks\n');
		return {
			client: 'codex',
			skillId: 'review',
			source: URI.file(source),
			target: URI.file(target),
			strategy,
		};
	}

	test('prefers a directory symlink without duplicating the canonical Skill', async () => {
		const request = await createRequest();
		const result = await service.project(request);

		assert.strictEqual(result.state, 'linked');
		assert.strictEqual(result.mode, 'symlink');
		assert.strictEqual((await fs.lstat(request.target.fsPath)).isSymbolicLink(), true);
		assert.strictEqual(await fs.realpath(request.target.fsPath), await fs.realpath(request.source.fsPath));
		assert.strictEqual(result.manifest, undefined);
	});

	test('records source and output hashes for managed-copy fallback', async () => {
		const request = await createRequest('managed-copy');
		const result = await service.project(request);

		assert.strictEqual(result.state, 'copied');
		assert.strictEqual(result.mode, 'managed-copy');
		assert.match(result.manifest?.sourceHash ?? '', /^[a-f0-9]{64}$/);
		assert.strictEqual(result.manifest?.sourceHash, result.manifest?.outputHash);
		assert.strictEqual((await fs.lstat(request.target.fsPath)).isSymbolicLink(), false);

		const inspected = await service.inspect({ ...request, manifest: result.manifest });
		assert.strictEqual(inspected.state, 'copied');
	});

	test('reports missing, modified, outdated, and unsupported projections', async () => {
		const request = await createRequest('managed-copy');
		assert.strictEqual((await service.inspect(request)).state, 'missing');

		const projected = await service.project(request);
		await fs.writeFile(join(request.target.fsPath, 'external.md'), 'external\n');
		const modified = await service.inspect({ ...request, manifest: projected.manifest });
		assert.strictEqual(modified.state, 'modified');
		await assert.rejects(
			() => service.project({ ...request, manifest: projected.manifest }),
			/Import changes or restore/
		);

		await fs.rm(join(request.target.fsPath, 'external.md'));
		await fs.writeFile(join(request.source.fsPath, 'canonical.md'), 'canonical\n');
		const outdated = await service.inspect({ ...request, manifest: projected.manifest });
		assert.strictEqual(outdated.state, 'outdated');

		await fs.rm(request.source.fsPath, { recursive: true });
		const unsupported = await service.inspect({ ...request, manifest: projected.manifest });
		assert.strictEqual(unsupported.state, 'unsupported');
		assert.match(unsupported.detail ?? '', /Canonical Skill is missing/);
	});

	test('imports an external managed-copy change only after an explicit request', async () => {
		const request = await createRequest('managed-copy');
		const projected = await service.project(request);
		const targetDefinition = join(request.target.fsPath, 'SKILL.md');
		await fs.appendFile(targetDefinition, '\nImported instruction.\n');

		assert.strictEqual(
			(await service.inspect({ ...request, manifest: projected.manifest })).state,
			'modified'
		);

		const imported = await service.importChanges({ ...request, manifest: projected.manifest });
		assert.strictEqual(imported.state, 'copied');
		assert.match(await fs.readFile(join(request.source.fsPath, 'SKILL.md'), 'utf8'), /Imported instruction/);
		assert.strictEqual(
			(await service.inspect({ ...request, manifest: imported.manifest })).state,
			'copied'
		);
	});

	test('restores canonical content over a drifted copy only after an explicit request', async () => {
		const request = await createRequest('managed-copy');
		const projected = await service.project(request);
		await fs.writeFile(join(request.target.fsPath, 'SKILL.md'), 'external replacement\n');

		const restored = await service.restore({ ...request, manifest: projected.manifest });
		assert.strictEqual(restored.state, 'copied');
		assert.match(await fs.readFile(join(request.target.fsPath, 'SKILL.md'), 'utf8'), /Review changes/);
		assert.strictEqual(
			(await service.inspect({ ...request, manifest: restored.manifest })).state,
			'copied'
		);
	});
});
